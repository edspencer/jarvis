// The walkthrough: loads the site manifest, wires the stage, the model, the walker, the HUD and the plugins together,
// runs the frame loop, and reads the start-up URL options. Everything the HUD shows comes through the plugin API
// (plugin/types.ts): the core's own panels and chips (builtin.ts) use it too.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SiteError, loadSite, type Site } from '../site';
import { BUILTIN_PLUGINS } from '../plugins/registry';
import { installTokens } from '../ui/tokens';
import { Hud } from '../ui/hud';
import { mountHud } from '../ui/shell';
import { installCore } from './builtin';
import { createContextFactory } from './context';
import { createFlight } from './flight';
import { CENTRE_NDC, bindInput, type OrbitHolder, type Pointer } from './input';
import { createPicker } from './inspect';
import { createLoading, type Loading } from './loading';
import { createMaterialStack } from './material-stack';
import { bindTouch } from './touch';
import { createModel } from './model';
import { createPlayer, createWalker } from './player';
import { createBus } from './plugin/events';
import { createStorage, createUrl } from './plugin/env';
import { createPluginHost } from './plugin/host';
import { loadPlugins } from './plugin/load';
import { createKeyRegistry } from './plugin/keys';
import { createStore } from './plugin/store';
import type { Subject, ViewApi } from './plugin/types';
import { createStage } from './stage';
import { createSunlight } from './sunlight';
import type { Analog, Keys, Mode, ViewState } from './types';
import { P, setPlanUnit, toPlan } from './units';

/** Load the site manifest, then start; a missing or invalid manifest is listed on the loading screen. */
export async function startViewer(): Promise<void> {
  installTokens();
  const loading = createLoading(document.getElementById('loading')!);
  let site: Site;
  try {
    const r = await loadSite();
    site = r.site;
    for (const w of r.warnings) console.warn(`site.json: ${w}`);
  } catch (err) {
    const e = err instanceof SiteError ? err : new SiteError('site.json', [(err as Error).message]);
    document.body.classList.add('site-error');
    loading.error(
      "Can't load the site manifest",
      e.url,
      e.lines,
      'See the README: a site folder holds a site.json, the model and its data files.',
    );
    console.error(e);
    return;
  }
  startSite(site, loading);
}

function startSite(site: Site, loading: Loading): void {
  setPlanUnit(site.unit);
  document.title = `${site.name} — JARVIS`;
  loading.stage('manifest', 'done');
  // the view is the page's main landmark, named by a heading for screen readers (the HUD's regions sit around it)
  const main = document.createElement('main');
  main.setAttribute('aria-labelledby', 'site-name');
  main.append(
    Object.assign(document.createElement('h1'), { id: 'site-name', className: 'sr-only', textContent: site.name }),
  );
  document.body.append(main);
  const stage = createStage(main, site);
  const { renderer, scene, camera, lamp, sun, centre } = stage;
  renderer.domElement.tabIndex = -1; // F6 can give the view the keys back

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
  const analog: Analog = { x: 0, y: 0 }; // the touch thumb-stick
  const orbit: OrbitHolder = { controls: null, dragged: false };
  const orbitCam = { pos: site.overviewCamera ? P(...site.overviewCamera) : centre.clone(), target: centre.clone() };
  const pointer: Pointer = { mouse: new THREE.Vector2(), hoverT: 0, hoverAt: null };
  const url = createUrl();

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

  const bus = createBus();
  const store = createStore();
  const externalKeys: Record<string, readonly string[]> = {}; // filled in when the external plugins have loaded
  const keyReg = createKeyRegistry({
    declared: (owner) =>
      Object.hasOwn(BUILTIN_PLUGINS, owner)
        ? BUILTIN_PLUGINS[owner].keys
        : Object.hasOwn(externalKeys, owner)
          ? externalKeys[owner]
          : null,
  });
  const services = new Map<string, unknown>();
  const extraProgress = new Map<string, { done(): void }>();
  const announced = new Set<string>();

  const model = createModel({
    site,
    renderer,
    scene,
    onExtraStatus: () => {
      for (const [id, x] of Object.entries(model.extras)) {
        if (x.status === 'loading' && !extraProgress.has(id)) extraProgress.set(id, hud.addProgress(`Loading ${id}…`));
        if (x.status !== 'loading' && extraProgress.has(id)) {
          extraProgress.get(id)!.done();
          extraProgress.delete(id);
        }
      }
      hud.update('status');
    },
    onExtraLoaded: () => {
      applyVisibility();
      for (const [id, x] of Object.entries(model.extras))
        if (x.status === 'loaded' && !announced.has(id)) {
          announced.add(id);
          bus.emit('model', { id });
        }
    },
  });
  const walker = createWalker({
    player,
    state,
    keys,
    analog,
    camera,
    getCollider: () => model.collider,
    onCrouchChange: () => hud.update('status'),
  });
  const picker = createPicker({
    camera,
    root: model.root,
    parts: model.parts,
    ownerOf: model.ownerOf,
    isGlass: model.isGlass,
  });
  const flight = createFlight({
    state,
    player,
    camera,
    centre,
    getOrbit: () => orbit.controls,
    onChange: () => hud.update('status'),
  });
  const sunlight = createSunlight({ site, stage, requestShadows });
  services.set('core.sunlight', sunlight); // the sun plugin's panel drives it

  function setMode(mode: Mode): void {
    if (mode === state.mode) return;
    state.mode = mode;
    lamp.visible = mode === 'walk';
    if (mode === 'orbit') {
      if (document.pointerLockElement) document.exitPointerLock();
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
    document.getElementById('cross')?.classList.toggle('hidden', mode !== 'walk');
    hud.setHover(null, null);
    hud.update('status', 'hover', 'stick');
    bus.emit('mode', { mode });
  }

  // Every node starts visible and each rule can only hide, so the toggles combine (an upstairs piece of furniture
  // stays hidden with U whatever its own layer says). Plugins add rules (a blueprint's "hide above").
  const visRules = new Set<() => Iterable<THREE.Object3D>>();
  function applyVisibility(): void {
    const { groups } = model;
    const hide = (list: Iterable<THREE.Object3D>, yes: boolean) => {
      if (yes) for (const o of list) o.visible = false;
    };
    for (const o of model.owners) o.visible = true;
    hide(groups.upper, state.upperHidden);
    hide(groups.roof, state.cutaway || state.upperHidden);
    hide(groups.ceiling, state.cutaway);
    for (const l of site.layers) hide(groups[l.id] || [], !!state.hidden[l.id]);
    for (const r of visRules) {
      try {
        hide(r(), true);
      } catch (err) {
        console.error('a visibility rule failed', err);
      }
    }
    requestShadows();
    bus.emit('visibility', {});
    hud.update('status');
  }

  // a site layer: show / hide it; an extra model's layer loads its model first (if it was left with ?noextra, or is
  // still on its way)
  function toggleLayer(id: string): void {
    const l = site.layers.find((x) => x.id === id);
    if (!l) return;
    const x = l.model ? model.extras[l.model] : null;
    if (x && x.status !== 'loaded') {
      state.hidden[id] = false;
      model.loadExtra(x.model.id);
      hud.update('status');
      return;
    }
    state.hidden[id] = !state.hidden[id];
    applyVisibility();
  }

  // ------------------------------------------------------------------ where the walker is
  let here: string | null = null;
  const DOWN = new THREE.Vector3(0, -1, 0),
    tmp = new THREE.Vector3();
  /** the room under the walker (the floor node's `room` extra): the place item and the light pool want it */
  function updateHere(): void {
    const g = walker.castDown(player.pos.x, player.pos.y + 0.3, player.pos.z);
    let room = '';
    if (g) {
      // collider triangles don't know their object; find the floor under the feet among the visible model
      const ray = walker.ray;
      ray.set(tmp.set(player.pos.x, player.pos.y + 0.3, player.pos.z), DOWN);
      ray.far = 1;
      const h = ray.intersectObjects(model.rooms, true)[0];
      if (h) room = String(model.ownerOf(h.object).userData.room);
    }
    here = state.mode === 'walk' && g && room ? room : null;
  }

  function flyToSubject(s: Subject): void {
    if (s.kind === 'item') {
      const kind = s.id.split(':')[0];
      hud.resolvers.get(kind)?.fly?.(s.id.slice(kind.length + 1));
      return;
    }
    const box = new THREE.Box3().setFromObject(s.node);
    if (box.isEmpty()) return;
    flight.fly(s.hit?.point.clone() ?? box.getCenter(new THREE.Vector3()), core.roomCentreOf(s.node));
  }

  const view: ViewApi = {
    state,
    setMode,
    fly: (t, c) => flight.fly(t, c),
    flyTo: (s) => {
      const subj = hud.resolve(s);
      if (subj) flyToSubject(subj);
    },
    teleport: (x, y, z, yaw) => {
      if (state.mode !== 'walk') setMode('walk');
      walker.teleport(x, y, z, yaw);
    },
    here: () => here,
    aim: () => (state.mode === 'walk' && document.pointerLockElement ? CENTRE_NDC : pointer.mouse),
    seen: (p) => walker.seen(p),
    addVisibilityRule(fn) {
      visRules.add(fn);
      return { dispose: () => void visRules.delete(fn) };
    },
    applyVisibility,
    toggleLayer,
    layers: () => site.layers,
    requestShadows,
  };

  // ------------------------------------------------------------------ the HUD and the plugins
  const hud: Hud = new Hud({
    site,
    keys: keyReg,
    storage: createStorage(`jarvis.ui.${site.id}`),
    flyTo: flyToSubject,
    canFly: (s) => s.kind === 'object' || !!hud.resolvers.get(s.id.split(':')[0])?.fly,
    resolveRef: (ref) => core.resolveRef(ref),
    describeObject: (s) => core.describeObject(s),
    onSelect: (subject, previous) => bus.emit('select', { subject, previous }),
    locked: () => document.pointerLockElement === renderer.domElement,
    mode: () => state.mode,
    setMode,
    stick: (x, y) => {
      analog.x = x;
      analog.y = y;
    },
  });
  const hudEl = mountHud(hud);

  const materials = createMaterialStack();
  const three = { THREE, scene, camera, renderer, model, P, toPlan, unit: site.unit, materials };
  // a plugin with a manifest section (resolved: the lights plugin also reads the old home-assistant.map)
  const own = (o: object | undefined, id: string) =>
    !!o && Object.hasOwn(o, id) && !!(o as Record<string, unknown>)[id];
  const enabled = (id: string) => own(site.plugins, id) || own(site.manifest.plugins, id);
  const twin: Record<string, unknown> = {};
  const makeContext = createContextFactory({
    site,
    three,
    materials,
    view,
    picker,
    bus,
    keys: keyReg,
    store,
    hud,
    services,
    url,
    twin,
    host: () => host,
  });
  const host = createPluginHost({
    enabled: (id) => enabled(id),
    context: (def, own) => makeContext(def, own),
    report: (def, message) => hud.toast({ text: `${def.name} is off: ${message}`, tone: 'warn', sticky: true }),
  });

  const core = installCore({
    site,
    view,
    hud,
    state,
    player,
    walker,
    model,
    ctx: makeContext({ id: 'core', name: 'JARVIS', setup() {} }, () => {}),
    here: () => here,
  });

  const touch = bindTouch({ canvas: renderer.domElement, state, player, hud, picker, bus });
  bindInput({
    canvas: renderer.domElement,
    state,
    keys,
    player,
    keyReg,
    hud,
    hudEl,
    picker,
    bus,
    orbit,
    pointer,
    lastWasTouch: touch.lastWasTouch,
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === renderer.domElement;
    hudEl.classList.toggle('locked', locked);
    hud.update('hover', 'status');
    bus.emit('pointerlock', { locked });
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
          hud.setHover(picker.at(CENTRE_NDC), null);
        }
        if (!document.pointerLockElement && hud.hoverLabel) hud.setHover(null, null);
      } else {
        if (!flying) orbit.controls!.update();
        if (pointer.hoverT < 0 && pointer.hoverAt) {
          pointer.hoverT = 0.1;
          hud.setHover(picker.at(pointer.mouse), pointer.hoverAt);
        }
        pointer.hoverT -= dt;
      }
      whereT -= dt;
      if (whereT <= 0) {
        whereT = 0.25;
        updateHere();
        hud.update('status');
      }
    }
    sunlight.step(dt);
    bus.emit('frame', { dt, now });
    updateShadows(now);
    renderer.render(scene, camera);
  }

  // scripting / test hook (browser console): twin.teleport(10, 20, 0, 180), twin.keys.KeyW = true, …; each plugin
  // adds its own (twin.pins, twin.ha, …)
  // (descriptors, not Object.assign: the getters must stay getters)
  Object.defineProperties(
    twin,
    Object.getOwnPropertyDescriptors({
      site,
      THREE,
      renderer,
      scene,
      camera,
      stepWalk: walker.stepWalk,
      headroom: walker.headroom,
      // where am I, now (the place item in the status strip; it also refreshes four times a second)
      updateWhere: () => {
        updateHere();
        hud.update('status');
      },
      sun,
      player,
      state,
      keys,
      analog,
      teleport: walker.teleport,
      setMode,
      applyVisibility,
      toggleLayer,
      fixtures: model.fixtures,
      setSun: sunlight.setSun,
      sunNow: sunlight.sunNow,
      sunAt: sunlight.sunAt,
      updateSun: sunlight.updateSun,
      sunlight,
      VIEWS: site.viewpoints,
      toPlan,
      P,
      groups: model.groups,
      owners: model.owners,
      parts: model.parts,
      root: model.root,
      materials,
      plants: model.plants,
      extras: model.extras,
      loadExtra: model.loadExtra,
      pick: picker.model,
      pickAt: picker.at,
      inspect: (s: Subject | string) => hud.inspect(s),
      fly: flight.fly,
      hud,
      store,
      keyRegistry: keyReg,
      bus,
      view,
      get host() {
        return host;
      },
      get collider() {
        return model.collider;
      },
      get here() {
        return here;
      },
    }),
  );
  window.twin = twin;

  // ------------------------------------------------------------------ start
  sunlight.updateSun();
  const start = site.viewpoints[site.startView];
  walker.teleport(...start.at, start.yaw);
  renderer.setAnimationLoop(frame);
  loading.stage('model', 'active', 0);
  model
    .loadModel((pct) => {
      loading.stage('model', pct >= 100 ? 'done' : 'active', pct);
      if (pct >= 100) loading.stage('colliders', 'active');
    })
    .then(() => {
      loading.stage('model', 'done');
      loading.stage('colliders', 'done');
      stage.fitShadows(model.box);
      if (!site.overviewCamera) {
        // off the model's south-east corner, looking down at the centre from about 35°
        const s = model.box.getSize(new THREE.Vector3());
        const r = Math.max(s.x, s.z, 10);
        orbitCam.pos.copy(centre).add(new THREE.Vector3(0.8 * r, 1.1 * r, 0.9 * r));
      }
      applyVisibility();
      announced.add('main');
      bus.emit('model', { id: 'main' });
      loading.hide();
      walker.teleport(...start.at, start.yaw);
      const vp = url.get('view') && site.viewpoints[+url.get('view')! - 1]; // ?view=3 or ?at=X,Y,Z,yaw for links
      if (vp) walker.teleport(...vp.at, vp.yaw);
      if (url.get('at')) {
        const a = url.get('at')!.split(',').map(Number);
        walker.teleport(a[0], a[1], a[2] || 0, a[3] || 0);
      }
      if (url.has('cutaway')) {
        state.cutaway = true;
        applyVisibility();
      }
      if (url.has('overview') || hud.small) setMode('orbit'); // phones start in the overview (the strip's switch walks)
      if (url.get('sun')) {
        const [h, dy] = url.get('sun')!.split(',').map(Number); // ?sun=13.5,172
        sunlight.setSun(h, dy);
      }
      if (url.has('walk')) state.ghost = false; // start walking (with collision) instead of in ghost mode
      try {
        if (!localStorage.getItem('twin.helpSeen')) hud.help(); // a first visit: the keys, once
      } catch {
        /* private mode: no help popup */
      }
      hud.update();
      // the extra models follow in the background (?noextra leaves each until its layer's key is pressed)
      for (const x of site.models.extra) {
        const layer = x.layer && site.layers.find((l) => l.id === x.layer);
        if (url.has('noextra') && layer && layer.key) state.hidden[layer.id] = true;
        else model.loadExtra(x.id);
      }
      startPlugins();
    })
    .catch((err: Error) => {
      loading.error(`Couldn't load ${site.models.main.url}`, '', [err.message], '');
      console.error(err);
    });

  // The plugins the site enables (and the autoStart ones): only their code is downloaded (plugin/load.ts). One that
  // fails to load is reported and left out.
  async function startPlugins(): Promise<void> {
    const prog = hud.addProgress('Starting plugins…');
    const { defs, keys } = await loadPlugins(site, {
      enabled,
      page: location.href,
      failed: (id, why) => hud.toast({ text: `The ${id} plugin didn't load: ${why}`, tone: 'warn', sticky: true }),
    });
    Object.assign(externalKeys, keys);
    await host.start(defs);
    bus.emit('ready', {});
    prog.done();
    hud.update();
  }
}

export type Twin = Record<string, unknown>;

declare global {
  interface Window {
    twin: Twin;
  }
}
