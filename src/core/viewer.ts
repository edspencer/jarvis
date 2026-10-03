// The walkthrough: loads the site manifest, wires the stage, the model, the walker, the HUD and the optional layers
// (plugins) together, runs the frame loop, and reads the start-up URL options.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SiteError, loadSite, type Site } from '../site';
import { createBlueprints } from './blueprints';
import { $, esc, query } from './dom';
import { createFlight } from './flight';
import { createHud } from './hud';
import { CENTRE_NDC, bindInput, type OrbitHolder, type Pointer } from './input';
import { createInspect } from './inspect';
import { createModel } from './model';
import { createPlayer, createWalker } from './player';
import { startPlugins } from './plugins';
import { createStage } from './stage';
import { createSunlight } from './sunlight';
import type { Keys, Mode, PluginSlots, ViewState } from './types';
import { P, setPlanUnit, toPlan } from './units';

/** Load the site manifest, then start; a missing or invalid manifest is listed on the loading screen. */
export async function startViewer(): Promise<void> {
  const loading = $('loading');
  let site: Site;
  try {
    const r = await loadSite();
    site = r.site;
    for (const w of r.warnings) console.warn(`site.json: ${w}`);
  } catch (err) {
    const e = err instanceof SiteError ? err : new SiteError('site.json', [(err as Error).message]);
    loading.classList.add('error');
    document.body.classList.add('site-error');
    loading.innerHTML =
      `<b>Can't load the site manifest</b> <code>${esc(e.url)}</code><ul>` +
      e.lines.map((l) => `<li>${esc(l)}</li>`).join('') +
      '</ul><span class="sub">See the README: a site folder holds a site.json, the model and its data files.</span>';
    console.error(e);
    return;
  }
  startSite(site);
}

/** the site's own words in the page: the title, the help's heading, viewpoints and layer keys */
function describeSite(site: Site): void {
  document.title = `${site.name} — JARVIS`;
  $('helptitle').textContent = site.name;
  $('helpsub').textContent = [site.description, 'Doors are shown open; glass is see-through.']
    .filter(Boolean)
    .join(' ');
  const row = (k: string, what: string) => `<tr><td>${esc(k)}</td><td>${what}</td></tr>`;
  const n = site.viewpoints.length;
  $('helpviews').outerHTML = row(n > 1 ? `1 – ${n}` : '1', site.viewpoints.map((v) => esc(v.name)).join(' · '));
  $('helplayers').outerHTML = site.layers
    .filter((l) => l.key)
    .map((l) =>
      row(l.key!, `Show / hide ${esc(l.help)}${l.model ? ' (it loads in the background after the main model)' : ''}`),
    )
    .join('');
}

function startSite(site: Site): void {
  setPlanUnit(site.unit);
  describeSite(site);
  const stage = createStage(document.body, site);
  const { renderer, scene, camera, lamp, sun, centre } = stage;

  // ghost is the default: a model may have gaps and steps a walker can get stuck on; G walks
  const state: ViewState = {
    mode: 'walk',
    cutaway: false,
    upperHidden: false,
    ghost: true,
    running: false,
    hidden: Object.fromEntries(site.layers.map((l) => [l.id, l.hidden])),
  };
  const player = createPlayer(site.walk);
  const keys: Keys = {};
  const plugins: PluginSlots = { ha: null, faults: null, pins: null, switches: null };
  const orbit: OrbitHolder = { controls: null, dragged: false };
  const orbitCam = { pos: site.overviewCamera ? P(...site.overviewCamera) : centre.clone(), target: centre.clone() };
  const pointer: Pointer = { mouse: new THREE.Vector2(), hoverT: 0, hoverAt: null };

  // Shadow map: not redrawn every frame (autoUpdate off), and at most every SHADOW_MS while something keeps changing
  // (dragging the time or date slider, animating the year); the last change always gets its update.
  const SHADOW_MS = 200;
  let shadowDirty = true,
    shadowAt = 0;
  const requestShadows = () => {
    shadowDirty = true;
  };
  function updateShadows(now: number): void {
    if (shadowDirty && now - shadowAt >= SHADOW_MS) {
      renderer.shadowMap.needsUpdate = true;
      shadowDirty = false;
      shadowAt = now;
    }
  }

  const model = createModel({
    site,
    renderer,
    scene,
    onExtraStatus: () => hud.flags(),
    onExtraLoaded: () => {
      blueprints.onModelAdded();
      applyVisibility();
    },
  });
  const walker = createWalker({
    player,
    state,
    keys,
    camera,
    getCollider: () => model.collider,
    onCrouchChange: () => hud.flags(),
  });
  const hud = createHud({ site, state, player, model, walker, plugins, $, setMode });
  const blueprints = createBlueprints({
    config: site.plugins.blueprints,
    units: site.units,
    scene,
    renderer,
    owners: model.owners,
    groups: model.groups,
    $,
    applyVisibility,
  });
  const inspect = createInspect({
    camera,
    root: model.root,
    parts: model.parts,
    ownerOf: model.ownerOf,
    isGlass: model.isGlass,
    plugins,
    $,
    esc,
  });
  const flight = createFlight({
    state,
    player,
    camera,
    centre,
    getOrbit: () => orbit.controls,
    onChange: () => hud.flags(),
  });
  const sunlight = createSunlight({ site, stage, $, requestShadows });

  function setMode(mode: Mode): void {
    state.mode = mode;
    lamp.visible = mode === 'walk';
    if (mode === 'orbit') {
      if (document.pointerLockElement) document.exitPointerLock();
      hud.help(false);
      camera.position.copy(orbitCam.pos);
      if (!orbit.controls) {
        orbit.controls = new OrbitControls(camera, renderer.domElement);
        orbit.controls.enableDamping = true;
        orbit.controls.maxPolarAngle = Math.PI * 0.495;
      }
      orbit.controls.target.copy(orbitCam.target);
      orbit.controls.enabled = true;
      orbit.controls.update();
    } else if (orbit.controls) {
      orbitCam.pos.copy(camera.position);
      orbitCam.target.copy(orbit.controls.target);
      orbit.controls.enabled = false;
    }
    hud.flags();
  }

  // Every node starts visible and each rule can only hide, so the toggles combine (an upstairs piece of furniture
  // stays hidden with U whatever its own layer says).
  function applyVisibility(): void {
    const { groups } = model;
    const { bp } = blueprints;
    const hide = (list: THREE.Object3D[], yes: boolean) => {
      if (yes) for (const o of list) o.visible = false;
    };
    for (const o of model.owners) o.visible = true;
    hide(groups.upper, state.upperHidden);
    hide(groups.roof, state.cutaway || state.upperHidden);
    hide(groups.ceiling, state.cutaway);
    for (const l of site.layers) hide(groups[l.id], !!state.hidden[l.id]);
    hide(bp.hidden, !!bp.active && bp.hideAbove); // blueprint overlay: "hide above"
    plugins.pins?.refresh(); // equipment pins upstairs go with U
    plugins.faults?.refresh(); // and device fault markers
    requestShadows();
    hud.flags();
  }

  bindInput({
    site,
    canvas: renderer.domElement,
    state,
    keys,
    player,
    model,
    walker,
    hud,
    inspect,
    blueprints,
    plugins,
    orbit,
    pointer,
    $,
    setMode,
    applyVisibility,
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ------------------------------------------------------------------ main loop
  let last = performance.now();
  let whereT = 0;
  function frame(): void {
    const now = performance.now(),
      dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (model.collider) {
      const flying = flight.stepFlight(dt);
      if (state.mode === 'walk') {
        if (!flying) walker.stepWalk(dt);
        camera.position.set(player.pos.x, player.eyeY, player.pos.z);
        camera.rotation.set(player.pitch, player.yaw, 0);
        pointer.hoverT -= dt;
        if (pointer.hoverT <= 0 && document.pointerLockElement) {
          pointer.hoverT = 0.12;
          inspect.hover(CENTRE_NDC);
        }
        if (!document.pointerLockElement) $('hover').style.display = 'none';
      } else {
        if (!flying) orbit.controls!.update();
        if (pointer.hoverT < 0 && pointer.hoverAt) {
          pointer.hoverT = 0.1;
          inspect.hover(pointer.mouse, pointer.hoverAt);
        }
        pointer.hoverT -= dt;
      }
      whereT -= dt;
      if (whereT <= 0) {
        whereT = 0.25;
        hud.updateWhere();
      }
    }
    sunlight.step(dt);
    plugins.ha?.update(dt);
    plugins.faults?.update(dt);
    plugins.pins?.update(dt);
    plugins.switches?.update(dt);
    updateShadows(now);
    renderer.render(scene, camera);
  }

  // scripting / test hook (browser console): twin.teleport(10, 20, 0, 180), twin.keys.KeyW = true, …
  const twin = {
    site,
    THREE,
    renderer,
    scene,
    camera,
    stepWalk: walker.stepWalk,
    updateWhere: hud.updateWhere,
    headroom: walker.headroom,
    sun,
    player,
    state,
    keys,
    teleport: walker.teleport,
    setMode,
    applyVisibility,
    fixtures: model.fixtures,
    setSun: sunlight.setSun,
    sunNow: sunlight.sunNow,
    sunAt: sunlight.sunAt,
    updateSun: sunlight.updateSun,
    VIEWS: site.viewpoints,
    toPlan,
    P,
    groups: model.groups,
    owners: model.owners,
    parts: model.parts,
    root: model.root,
    plants: model.plants,
    extras: model.extras,
    loadExtra: model.loadExtra,
    pick: inspect.pick,
    showInfo: inspect.showInfo,
    bp: blueprints.bp,
    showBlueprint: blueprints.showBlueprint,
    setBlueprintFade: blueprints.setBlueprintFade,
    fly: flight.fly,
    get collider() {
      return model.collider;
    },
    // set by the plugins as they load
    ha: undefined as unknown,
    faults: undefined as unknown,
    pins: undefined as unknown,
    switches: undefined as unknown,
  };
  window.twin = twin;

  // ------------------------------------------------------------------ start
  sunlight.updateSun();
  hud.flags();
  try {
    if (!localStorage.getItem('twin.helpSeen')) hud.help(true);
  } catch {
    /* private mode: no help popup */
  }
  const start = site.viewpoints[site.startView];
  walker.teleport(...start.at, start.yaw);
  renderer.setAnimationLoop(frame);
  const loading = $('loading');
  loading.textContent = `Loading ${site.name}…`;
  model
    .loadModel((pct) => {
      loading.textContent = `Loading ${site.name}… ${pct}%`;
    })
    .then(() => {
      stage.fitShadows(model.box);
      if (!site.overviewCamera) {
        // off the model's south-east corner, looking down at the centre from about 35°
        const s = model.box.getSize(new THREE.Vector3());
        const r = Math.max(s.x, s.z, 10);
        orbitCam.pos.copy(centre).add(new THREE.Vector3(0.8 * r, 1.1 * r, 0.9 * r));
      }
      applyVisibility();
      hud.buildRoomMenu();
      loading.classList.add('hidden');
      walker.teleport(...start.at, start.yaw);
      const q = query(); // ?view=3 or ?at=X,Y,Z,yaw for links
      const view = q.get('view') && site.viewpoints[+q.get('view')! - 1];
      if (view) walker.teleport(...view.at, view.yaw);
      if (q.get('at')) {
        const a = q.get('at')!.split(',').map(Number);
        walker.teleport(a[0], a[1], a[2] || 0, a[3] || 0);
      }
      if (q.has('cutaway')) {
        state.cutaway = true;
        applyVisibility();
      }
      if (q.has('overview')) setMode('orbit');
      if (q.get('sun')) {
        const [h, dy] = q.get('sun')!.split(',').map(Number); // ?sun=13.5,172
        sunlight.setSun(h, dy);
      }
      if (q.has('walk')) {
        state.ghost = false; // start walking (with collision) instead of in ghost mode
        hud.flags();
      }
      // the extra models follow in the background (?noextra leaves each until its layer's key is pressed)
      for (const x of site.models.extra) {
        const layer = x.layer && site.layers.find((l) => l.id === x.layer);
        if (q.has('noextra') && layer && layer.key) state.hidden[layer.id] = true;
        else model.loadExtra(x.id);
      }
      blueprints.loadIndex(); // ?bp=<sheet id> opens with that sheet, ?bpfade=20 sets the model's opacity
      startPlugins({
        site,
        stage,
        state,
        model,
        plugins,
        twin,
        $,
        esc,
        seen: walker.seen,
        fly: flight.fly,
        flags: () => hud.flags(),
        hereRoom: () => hud.hereRoom(),
        inspect,
      });
    })
    .catch((err: Error) => {
      loading.textContent = `Couldn't load ${site.models.main.url} (${err.message}).`;
      console.error(err);
    });
}

export type Twin = Record<string, unknown>;

declare global {
  interface Window {
    twin: Twin;
  }
}
