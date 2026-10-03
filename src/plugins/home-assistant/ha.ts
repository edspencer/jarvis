// Home Assistant in the walkthrough: show the building's lights as they are, and switch a few things.
//
// Login is Home Assistant's own browser OAuth flow (home-assistant-js-websocket): "Connect" sends the browser to HA's
// login page, which comes back here with ?auth_callback=1&code=…; the library swaps the code for tokens. The client_id
// is this page's origin, so no app has to be registered in HA. The tokens live in this browser's localStorage
// (TOKENS_KEY), as the HA frontend keeps its own; nothing is baked into the page. HA must list the viewer's origin in
// http: cors_allowed_origins, or the token exchange and the websocket fail.
//
// The map from fixture to entity is the site's fixture map (plugins.home-assistant.map). Each mapped fixture shows its entity:
//   on           its emitting parts glow, scaled by brightness and tinted by color_temp_kelvin / rgb_color; a halo;
//                and the nearest POOL lit fixtures to the camera get one of a fixed pool of real point lights
//   off          no glow
//   unavailable / unknown   a dull red glow, and with "faults through walls" (V) a red marker drawn over everything
//                (the marker of a light that is an HA device in the device map is the faults layer's, which knows its
//                wall switch and the other devices; this file's own marker is left for the rest)
//   no entity    left as the model draws it (the build's baked glow)
// ?ha=mock replays a fake state stream instead (every fixture gets a made-up entity per switched group), for testing
// without a login. ?ha=off never connects, even with stored tokens.
//
// Two-way: the HUD's controls (scripts, a switch) and switching a light from the model (T / Shift-click / the inspect
// panel's button). Every call to HA goes through send() (policy.ts), which allows only the services in SEND_OK and,
// for lights from the model, only what ha_controls.json's fixture_toggle allows (lights; switches the map marks as
// lights). In ?ha=mock, send() goes to a simulator and nothing reaches HA.
import * as THREE from 'three';
import {
  ERR_CANNOT_CONNECT,
  ERR_INVALID_AUTH,
  ERR_INVALID_AUTH_CALLBACK,
  callService,
  createConnection,
  getAuth,
  subscribeEntities,
  type AuthData,
  type Connection,
} from 'home-assistant-js-websocket';
import type { Site } from '../../site';
import { isMesh, isShown } from '../../core/three-utils';
import type { DomLookup, Fixtures, SeenFn } from '../../core/types';
import { DEFAULT_K, combine, kelvinRGB, lookOf, type Look } from './look';
import {
  controlCall,
  createSender,
  entitiesOf as entitiesOfEntry,
  isControlAction,
  toggleBlocker as blockerFor,
} from './policy';
import type { Control, Entities, EntityState, MapEntry, ServiceData, Status, TogglePolicy } from './types';

export type { Entities, EntityState } from './types';

const TOKENS_KEY = 'twin.hassTokens';
const LINE_MIN = 1.2; // m: an emitter longer than this is treated as a line (cove, strip)
const LINE_STEP = 0.6; // m between halos along a line
const LINE_LIGHTS = 4; // at most this many pooled lights for one line fixture
const OTHER_ROOM = 6; // m added to a fixture's distance when it isn't in the camera's room
const PENDING_MS = 5000;

type Emitter = {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  base: { emissive: THREE.Color; intensity: number };
};

/** a fixture as the HA layer drives it */
export interface FixtureFx {
  id: string;
  node: THREE.Object3D;
  parts: Emitter[];
  /** where its halo and pool light go */
  at: THREE.Vector3;
  /** halo points along a long emitter (a cove, a strip), or null */
  line: THREE.Vector3[] | null;
  /** pool-light candidates */
  lights: THREE.Vector3[];
  look: Look | null;
  /** a switch in flight: keep its optimistic look until HA reports */
  pending?: { to: 'on' | 'off'; stamp: string; t: number } | null;
  err?: string | null;
  lastOn?: Look;
}

type Halos = THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;

export interface HADeps {
  /** the site's home-assistant section (URL, map and controls files, emitter hints) */
  config: NonNullable<Site['plugins']['home-assistant']>;
  scene: THREE.Scene;
  camera: THREE.Camera;
  fixtures: Fixtures;
  $: DomLookup;
  /** a state or a status changed (the HUD's flags; refresh an open panel) */
  onChange?: () => void;
  /** the room id the camera is in, or null */
  room?: () => string | null;
  seen?: SeenFn;
}

interface MockApi {
  set(e: string, state: string, attributes?: Record<string, unknown>): void;
  adopt(ids: string[]): void;
  load(list: EntityState[]): void;
  run(c: Control, service: string): Promise<void>;
  service(domain: string, svc: string, data: ServiceData): Promise<void>;
  calls: { domain: string; service: string; data: ServiceData; t: number }[];
  /** make the next call fail with this reason */
  failNext: string | null;
  /** HA accepts but nothing changes (a dead bulb) */
  silent: boolean;
}

interface BlinkState {
  active: boolean;
  queue: string[];
  i: number;
  answers: { entity: string; fixture?: string | null; error?: string }[];
  busy: boolean;
  fid: string | null;
  fixtures?: string[];
  result?: string | null;
}

/** which parts of a fixture glow when none of its materials is emissive (material names) */
export const DEFAULT_EMITTER_HINTS = 'glass|bulb|lens|shade|led|light|globe|candle|alabaster|amber|dome|bowl|hue';

export function createHA({ config, scene, camera, fixtures, $, onChange, room, seen }: HADeps) {
  const HASS_URL = config.url;
  const q = new URLSearchParams(location.search);
  const mode: 'mock' | 'off' | 'live' = q.get('ha') === 'mock' ? 'mock' : q.get('ha') === 'off' ? 'off' : 'live';
  const POOL = THREE.MathUtils.clamp(+(q.get('halights') ?? 10), 0, 32); // real lights; tune for fps (8-12)

  const ha = {
    mode,
    status: 'disconnected' as Status,
    error: '',
    conn: null as Connection | null,
    entities: {} as Entities,
    /** fixture_id -> its map entry (mock ids filled in for ?ha=mock) */
    map: {} as Record<string, MapEntry>,
    /** entity_id -> [fixture_id] */
    byEntity: {} as Record<string, string[]>,
    wallhack: q.has('hawall'),
    pool: [] as THREE.PointLight[],
    halo: null as Halos | null,
    haloLine: null as Halos | null,
    wall: null as Halos | null,
    fx: {} as Record<string, FixtureFx>,
    engaged: false,
    mock: null as MockApi | null,
    /** (entities, previous) after every state change: the faults layer's device health */
    listeners: [] as ((ents: Entities, old: Entities) => void)[],
    /** entity -> true if a device marker (faults layer) already shows its fault */
    covers: null as ((e: string) => boolean) | null,
    controls: [] as Control[],
    /** fixture_toggle policy; empty = no light can be switched from the model */
    toggle: {} as TogglePolicy,
    lit: 0,
    faults: 0,
    /** Home Assistant's base URL ('' = none configured) */
    hassUrl: HASS_URL,
  };

  // ------------------------------------------------------------------ status in the HUD
  const LABEL: Record<Status, string> = {
    disconnected: 'not connected',
    connecting: 'connecting…',
    live: 'live',
    error: 'error',
    mock: 'mock data',
  };
  function setStatus(s: Status, err = ''): void {
    ha.status = s;
    ha.error = err;
    const dot = $('hadot'),
      lab = $('halabel'),
      btn = $('habtn');
    if (!dot) return;
    dot.className = `hadot ${s}`;
    lab.textContent = LABEL[s] + (err ? `: ${err}` : '');
    lab.title = err;
    btn.textContent = s === 'live' || s === 'connecting' ? 'Disconnect' : 'Connect Home Assistant';
    btn.classList.toggle('hidden', mode !== 'live');
    $('hawallrow').classList.toggle('hidden', !ha.engaged);
    drawControls();
    onChange?.();
  }

  // ------------------------------------------------------------------ the map
  async function loadMap(): Promise<void> {
    try {
      if (!config.map) return;
      const r = await fetch(config.map);
      if (!r.ok) return;
      const j = (await r.json()) as Record<string, unknown> & { fixtures?: Record<string, unknown> };
      const m = j.fixtures || j;
      for (const [id, v] of Object.entries(m)) if (v && typeof v === 'object') ha.map[id] = v as MapEntry;
    } catch {
      /* no map yet: nothing is mapped */
    }
  }
  // A fixture's entity_id is one entity, or a list when several bulbs light one fixture (a two-bulb floor lamp, a cove
  // of four strips); a group (a Hue room or zone) also works as one entity standing in for a set of bulbs.
  const entitiesOf = (fid: string): string[] => entitiesOfEntry(ha.map[fid]);
  const entityOf = (fid: string): string | null => entitiesOf(fid)[0] || null;
  function index(): void {
    ha.byEntity = {};
    for (const id of Object.keys(ha.map)) for (const e of entitiesOf(id)) (ha.byEntity[e] ||= []).push(id);
  }

  // ------------------------------------------------------------------ fixtures: emitters, materials, glow
  // A fixture's emitters are the parts whose material the build made emissive (lenses, bulbs, LED discs, shades), plus
  // glass, bulb, shade and light parts that carry no emissive; failing both, every part. Each emitter gets its own
  // material copy (materials are shared between fixtures), with the build's emissive kept to restore.
  // material-name hints for a fixture's emitting parts (the site can give its own)
  const EMIT_NAME = new RegExp(config.emitterHints || DEFAULT_EMITTER_HINTS, 'i');
  function prepFixture(id: string): void {
    const node = fixtures[id];
    const meshes: THREE.Mesh[] = [];
    node.traverse((o) => {
      if (isMesh(o)) meshes.push(o);
    });
    const matOf = (o: THREE.Mesh) => o.material as THREE.MeshStandardMaterial;
    const isEm = (m: THREE.MeshStandardMaterial) =>
      m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) * (m.emissiveIntensity ?? 1) > 0.01;
    let em = meshes.filter((o) => isEm(matOf(o)) || EMIT_NAME.test(matOf(o).name || ''));
    if (!em.length) em = meshes;
    const parts: Emitter[] = em.map((o) => {
      const base = matOf(o);
      const mat = base.clone();
      o.material = mat;
      return { mesh: o, mat, base: { emissive: base.emissive.clone(), intensity: base.emissiveIntensity } };
    });
    const box = new THREE.Box3();
    for (const p of parts) box.expandByObject(p.mesh);
    const at = box.getCenter(new THREE.Vector3());
    at.y = Math.max(box.min.y - 0.04, at.y - 0.1); // just below a ceiling can's lens; inside a pendant's glass
    // A long emitter (a cove, an under-cabinet strip) is a line, not a point: its box centre can be nowhere near it
    // (a ring of cove light is centred on the middle of the ceiling). So its halos are spread along the strip itself
    // (`line`, about every LINE_STEP m), and its share of the light pool is split over up to LINE_LIGHTS points along
    // it (`lights`), picked as far apart as possible.
    const size = box.getSize(new THREE.Vector3());
    let line: THREE.Vector3[] | null = null,
      lights = [at];
    if (Math.max(size.x, size.z) > LINE_MIN) {
      line = alongStrip(parts.map((p) => p.mesh));
      if (line.length) lights = farthest(line, Math.min(LINE_LIGHTS, Math.ceil((line.length * LINE_STEP) / 2.5)));
    }
    ha.fx[id] = { id, node, parts, at, line, lights, look: null };
  }

  // points along the emitters' triangle edges, at least LINE_STEP apart (world space; reads through getX, so
  // quantised positions come out in metres). Edges, not vertices: a straight strip has vertices only at its ends.
  function alongStrip(meshes: THREE.Mesh[]): THREE.Vector3[] {
    const out: THREE.Vector3[] = [],
      a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      v = new THREE.Vector3();
    const add = (p: THREE.Vector3) => {
      if (out.every((q) => q.distanceToSquared(p) > LINE_STEP * LINE_STEP)) out.push(p.clone());
    };
    for (const o of meshes) {
      o.updateWorldMatrix(true, false);
      const pos = o.geometry.attributes.position,
        idx = o.geometry.index;
      const n = idx ? idx.count : pos.count;
      const vi = (k: number) => (idx ? idx.getX(k) : k);
      for (let t = 0; t < Math.min(n, 3 * 3000); t += 3) {
        for (let e = 0; e < 3; e++) {
          a.fromBufferAttribute(pos, vi(t + e)).applyMatrix4(o.matrixWorld);
          b.fromBufferAttribute(pos, vi(t + ((e + 1) % 3))).applyMatrix4(o.matrixWorld);
          const steps = Math.ceil(a.distanceTo(b) / (LINE_STEP / 2));
          for (let k = 0; k <= steps; k++) add(v.lerpVectors(a, b, k / steps));
        }
      }
    }
    return out;
  }
  // farthest-point sampling: n points spread over the strip (a ring's four sides, a strip's two ends and middle)
  function farthest(pts: THREE.Vector3[], n: number): THREE.Vector3[] {
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    const out = [pts.reduce((a, p) => (p.distanceToSquared(c) > a.distanceToSquared(c) ? p : a))];
    while (out.length < Math.min(n, pts.length)) {
      out.push(
        pts.reduce<{ p: THREE.Vector3 | null; d: number }>(
          (a, p) => {
            const d = Math.min(...out.map((q) => q.distanceToSquared(p)));
            return d > a.d ? { p, d } : a;
          },
          { p: null, d: -1 },
        ).p!,
      );
    }
    return out.map((p) => p.clone().setY(p.y - 0.05));
  }

  const FAULT = new THREE.Color(0.9, 0.05, 0.05);
  function applyLook(f: FixtureFx, look: Look): void {
    f.look = look;
    for (const p of f.parts) {
      if (look.kind === 'none') {
        p.mat.emissive.copy(p.base.emissive);
        p.mat.emissiveIntensity = p.base.intensity;
        continue;
      }
      if (look.kind === 'off') {
        p.mat.emissive.setRGB(0, 0, 0);
        continue;
      }
      if (look.kind === 'fault') {
        p.mat.emissive.copy(FAULT);
        p.mat.emissiveIntensity = 0.6;
        continue;
      }
      p.mat.emissive.copy(look.colour);
      // the build's own strength (KHR_materials_emissive_strength) is the "full" glow; a dimmed light keeps a little
      p.mat.emissiveIntensity = Math.max(1.5, p.base.intensity) * (0.15 + 0.85 * look.level);
    }
  }

  // ------------------------------------------------------------------ halos, the wall hack, the light pool
  function haloTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!,
      r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)');
    r.addColorStop(0.25, 'rgba(255,255,255,.45)');
    r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }
  // one THREE.Points for every halo (one draw call), and one more for the faults drawn through walls
  function points(n: number, size: number, over: boolean): Halos {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const m = new THREE.PointsMaterial({
      size,
      map: haloTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      depthTest: !over,
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    if (over) {
      p.renderOrder = 999;
      m.blending = THREE.NormalBlending;
      m.sizeAttenuation = false;
    }
    p.name = over ? 'HA_wallhack' : 'HA_halos';
    scene.add(p);
    return p;
  }

  function engage(): void {
    if (ha.engaged) return;
    ha.engaged = true;
    // the pool is fixed in size and always in the scene: three.js compiles shaders per light count, so adding and
    // removing lights as you walk would recompile every material. An unused light just has intensity 0.
    for (let i = 0; i < POOL; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 7, 2);
      l.name = `HA_light_${i}`;
      scene.add(l);
      ha.pool.push(l);
    }
    ha.halo = points(160, 0.55, false);
    ha.haloLine = points(1024, 0.3, false); // smaller halos strung along coves and strips
    ha.wall = points(160, 22, true);
    $('hawallrow').classList.remove('hidden');
  }

  let poolT = 0,
    nFix = -1;
  const tmpV = new THREE.Vector3();

  function syncFixtures(): void {
    const ids = Object.keys(fixtures);
    if (ids.length === nFix) return;
    nFix = ids.length; // the lamps of an extra model arrive after the main model
    const fresh = ids.filter((id) => !ha.fx[id]);
    if (ha.mock) ha.mock.adopt(fresh);
    for (const id of fresh) {
      prepFixture(id);
      refresh(id);
    }
  }

  function refresh(id: string): void {
    const f = ha.fx[id];
    if (!f) return;
    if (f.pending) {
      // a switch is in flight: keep its optimistic look until HA reports
      if (stamp(id) === f.pending.stamp) return;
      f.pending = null;
      f.err = null;
    }
    const es = entitiesOf(id);
    if (!es.length) return applyLook(f, { kind: 'none' });
    applyLook(f, combine(es.map((e) => lookOf(ha.entities[e], ha.map[id]?.unavailable_means))));
  }

  function update(dt: number): void {
    if (!ha.engaged) return;
    syncFixtures();
    poolT -= dt;
    if (poolT > 0) return;
    poolT = 0.2; // re-pick the pool and redraw the halos five times a second
    type Lit = FixtureFx & { look: Extract<Look, { kind: 'on' }> };
    const lit: Lit[] = [],
      faults: FixtureFx[] = [];
    for (const f of Object.values(ha.fx)) {
      if (!f.look || !isShown(f.node)) continue;
      if (f.look.kind === 'on') lit.push(f as Lit);
      else if (f.look.kind === 'fault') faults.push(f);
    }
    // the pool's candidates are light points: one per fixture, or a few along a line fixture (sharing its output)
    const cam = camera.getWorldPosition(tmpV);
    const here = room?.();
    const cands: { p: THREE.Vector3; f: Lit; away: number; share: number; d: number }[] = [];
    for (const f of lit) {
      // a fixture in another room counts as OTHER_ROOM m further away: the pool's lights have no shadows, so a light
      // just through the wall would shine into this room
      const away = here && f.node.userData.room && f.node.userData.room !== here ? OTHER_ROOM : 0;
      for (const p of f.lights)
        cands.push({ p, f, away, share: 1 / Math.sqrt(f.lights.length), d: (p.distanceTo(cam) + away) ** 2 });
    }
    cands.sort((a, b) => a.d - b.d);
    // nearest first; another room's fixture only if the camera can see it (through an arch or a door, not a wall).
    // This room's fixtures always count: a cove hidden behind its crown moulding still lights the room.
    const chosen: typeof cands = [];
    for (let i = 0; i < cands.length && chosen.length < POOL && i < POOL * 4; i++) {
      const c = cands[i];
      if (!c.away || !seen || seen(c.p)) chosen.push(c);
    }
    ha.pool.forEach((l, i) => {
      const c = chosen[i];
      if (!c) {
        l.intensity = 0;
        return;
      }
      l.position.copy(c.p);
      if (!c.f.line) l.position.y -= 0.2; // a little under a can, so it lights its own ceiling too
      l.color.copy(c.f.look.colour);
      l.intensity = 2.5 * c.f.look.level * c.share;
    });
    const glow = (f: Lit) => f.look.colour.clone().multiplyScalar(0.25 + 0.6 * f.look.level);
    fill(
      ha.halo!,
      lit.filter((f) => !f.line).map((f) => ({ p: f.at, c: glow(f) })),
    );
    fill(
      ha.haloLine!,
      lit
        .filter((f) => f.line)
        .flatMap((f) => {
          const c = glow(f).multiplyScalar(0.7);
          return f.line!.map((p) => ({ p, c }));
        }),
    );
    // a fixture whose entity a device in the device map watches gets the device's marker instead, once
    const covers = ha.covers;
    const own = covers ? faults.filter((f) => !entitiesOf(f.id).some(covers)) : faults;
    fill(ha.wall!, ha.wallhack ? own.map((f) => ({ p: f.at, c: FAULT })) : []);
    ha.wall!.visible = ha.wallhack;
    ha.lit = lit.length;
    ha.faults = faults.length;
  }
  function fill(pts: Halos, list: { p: THREE.Vector3; c: THREE.Color }[]): void {
    const pos = pts.geometry.attributes.position as THREE.BufferAttribute,
      col = pts.geometry.attributes.color as THREE.BufferAttribute;
    const n = Math.min(list.length, pos.count);
    for (let i = 0; i < n; i++) {
      pos.setXYZ(i, list[i].p.x, list[i].p.y, list[i].p.z);
      col.setXYZ(i, list[i].c.r, list[i].c.g, list[i].c.b);
    }
    pts.geometry.setDrawRange(0, n);
    pos.needsUpdate = col.needsUpdate = true;
  }

  // ------------------------------------------------------------------ states in
  function onEntities(ents: Entities): void {
    const old = ha.entities;
    ha.entities = ents;
    for (const [e, ids] of Object.entries(ha.byEntity)) if (ents[e] !== old[e]) for (const id of ids) refresh(id);
    if (ha.controls.some((c) => ents[c.entity_id] !== old[c.entity_id] || (c.power && ents[c.power] !== old[c.power])))
      drawControls();
    for (const f of ha.listeners) f(ents, old); // the faults layer: device health
    onChange?.();
  }

  // ------------------------------------------------------------------ controls: the HUD's buttons
  // ha_controls.json: a short list of scripts to run and switches to toggle. The viewer calls a service ONLY on an
  // entity in that list, and only the service its action allows (act() below is the one place that calls HA for
  // them; policy.ts): the login can do anything in HA, and this keeps a bug or a misclick away from locks, doors, the
  // alarm. A script runs fire-and-forget (script.turn_on); its entity is "on" while it runs, so the button says
  // "running…", and its effects arrive through the state stream like any other change.
  const pending: Record<string, string> = {}; // control id -> 'sent' while a call is in flight; or an error text
  async function loadControls(): Promise<void> {
    try {
      if (!config.controls) return;
      const r = await fetch(config.controls);
      if (r.ok) {
        const j = (await r.json()) as Control[] | { controls?: Control[]; fixture_toggle?: TogglePolicy };
        // {controls: [...], fixture_toggle: {...}}, or a bare list (older files)
        ha.controls = (Array.isArray(j) ? j : j.controls || []).filter(
          (c) => c && c.id && c.entity_id && isControlAction(c.action),
        );
        ha.toggle = (!Array.isArray(j) && j.fixture_toggle) || {};
      }
    } catch {
      /* no controls file: no buttons */
    }
  }
  function drawControls(): void {
    const box = $('hactl');
    if (!box) return;
    $('hactlrow').classList.toggle('hidden', !ha.controls.length || !(ha.status === 'live' || ha.status === 'mock'));
    for (const c of ha.controls) {
      let b = $<HTMLButtonElement>(`ha-ctl-${c.id}`);
      if (!b) {
        b = document.createElement('button');
        b.type = 'button';
        b.id = `ha-ctl-${c.id}`;
        b.className = 'hactl';
        b.addEventListener('click', (e) => {
          (e.currentTarget as HTMLElement).blur();
          act(c);
        });
        box.appendChild(b);
      }
      const st = ha.entities[c.entity_id];
      const state = st?.state;
      const busy = pending[c.id] === 'sent' || (c.action === 'run' && state === 'on');
      let text = c.label;
      if (c.action === 'toggle' && state) {
        text += `: ${state}`;
        const w = c.power && ha.entities[c.power];
        if (w && state === 'on' && w.state !== 'unavailable') text += ` · ${Math.round(+w.state)} W`;
      }
      if (busy) text += c.action === 'run' ? ' · running…' : ' …';
      if (!st) text += ' (not in HA)';
      else if (state === 'unavailable') text += ' (unavailable)';
      b.textContent = text;
      b.disabled = busy || !st || state === 'unavailable';
      b.classList.toggle('on', c.action === 'toggle' && state === 'on');
      b.classList.toggle('err', !!pending[c.id] && pending[c.id] !== 'sent');
      b.title =
        pending[c.id] && pending[c.id] !== 'sent'
          ? pending[c.id]
          : `${c.action === 'run' ? 'Run' : 'Switch'} ${st?.attributes?.friendly_name || c.entity_id} in Home Assistant${c.confirm ? ' (asks first)' : ''}`;
    }
  }
  async function act(c: Control): Promise<void> {
    const call = controlCall(ha.controls, c, ha.entities);
    if ('refused' in call) {
      // never anything outside the list
      console.warn(`Home Assistant: ${call.refused}`);
      return;
    }
    const { domain, service } = call;
    if (c.confirm && !window.confirm(c.confirm)) return;
    pending[c.id] = 'sent';
    drawControls();
    try {
      if (ha.mock && c.action === 'run') await ha.mock.run(c, service);
      else await send(domain, service, { entity_id: c.entity_id });
      delete pending[c.id];
    } catch (err) {
      pending[c.id] = `Failed: ${errText(err)}`;
      console.warn('Home Assistant:', err);
      setTimeout(() => {
        if (pending[c.id] !== 'sent') {
          delete pending[c.id];
          drawControls();
        }
      }, 6000);
    }
    drawControls();
  }
  const errText = (err: unknown): string => {
    const e = err as { message?: string; code?: unknown } | null;
    return String(e?.message || e?.code || err);
  };

  // ------------------------------------------------------------------ send(): the only call to Home Assistant
  const send = createSender({
    mock: () => (ha.mock ? ha.mock.service : null),
    status: () => ha.status,
    connected: () => !!ha.conn,
    call: (domain, service, data) => callService(ha.conn!, domain, service, data),
  });

  // ------------------------------------------------------------------ switching a light from the model
  // T while aiming at a fixture (walking), Shift-click (either mode), or the inspect panel's button. A fixture with one
  // entity gets <domain>.toggle; one with several (a two-bulb lamp, a cove's four strips) gets turn_on or turn_off on
  // all of them, so they stay together. The glow changes at once (optimistic) and the real state replaces it when the
  // subscription reports the change; no change within PENDING_MS, or an error, puts the real state back and says why.
  const toggleBlocker = (fid: string): string | null =>
    blockerFor({ entry: ha.map[fid], policy: ha.toggle, status: ha.status, states: ha.entities });
  // how many bulbs a toggle reaches: a group lists its members in attributes.entity_id
  function bulbsOf(fid: string): { n: number; groups: number } {
    let n = 0,
      groups = 0;
    for (const e of entitiesOf(fid)) {
      const mem = ha.entities[e]?.attributes?.entity_id;
      if (Array.isArray(mem)) {
        n += mem.length;
        groups++;
      } else n++;
    }
    return { n, groups };
  }
  const stamp = (fid: string): string =>
    entitiesOf(fid)
      .map((e) => `${ha.entities[e]?.state}|${ha.entities[e]?.last_changed}`)
      .join(',');
  async function toggleFixture(fid: string): Promise<boolean> {
    const f = ha.fx[fid];
    const why = toggleBlocker(fid);
    if (!f || why) {
      if (f) {
        f.err = why;
        onChange?.();
      }
      console.warn(`Home Assistant: not switching ${fid}: ${why}`);
      return false;
    }
    const es = entitiesOf(fid);
    const to = f.look?.kind === 'on' ? 'off' : 'on';
    const byDomain: Record<string, string[]> = {};
    for (const e of es) (byDomain[e.split('.')[0]] ||= []).push(e);
    f.err = null;
    f.pending = { to, stamp: stamp(fid), t: Date.now() };
    if (f.look?.kind === 'on') f.lastOn = f.look;
    applyLook(
      f,
      to === 'on'
        ? f.lastOn || { kind: 'on', colour: kelvinRGB(DEFAULT_K, new THREE.Color()), level: 0.8 }
        : { kind: 'off' },
    );
    onChange?.();
    const mine = f.pending;
    setTimeout(() => {
      // nothing came back: put the real state back, and say so
      if (f.pending !== mine) return;
      f.pending = null;
      f.err = `Home Assistant reported no change within ${PENDING_MS / 1000} s`;
      refresh(fid);
      onChange?.();
    }, PENDING_MS);
    try {
      for (const [d, ids] of Object.entries(byDomain)) {
        const service = es.length === 1 ? 'toggle' : to === 'on' ? 'turn_on' : 'turn_off';
        await send(d, service, { entity_id: ids.length === 1 ? ids[0] : ids });
      }
      return true;
    } catch (err) {
      if (f.pending === mine) f.pending = null;
      f.err = `Failed: ${errText(err)}`;
      console.warn(`Home Assistant: switching ${fid} failed`, err);
      refresh(fid);
      onChange?.();
      return false;
    }
  }

  // ------------------------------------------------------------------ a wall plate's position (switches layer)
  // A plate position that names an ha_entity gets a toggle in its panel. Mock only for now: plate identities are still
  // being confirmed, so live HA is never switched from a plate, whatever the caller; and the call still goes through
  // send()'s allowlist and the fixture_toggle policy (a light, or nothing).
  async function togglePlateEntity(e: string): Promise<boolean> {
    const d = String(e || '').split('.')[0];
    if (mode !== 'mock' || !ha.mock) {
      console.warn(`Home Assistant: not switching ${e} from a plate (mock only)`);
      return false;
    }
    if (!(d === 'light' && ha.toggle.light)) {
      console.warn(`Home Assistant: ${e} isn't a light the model may switch`);
      return false;
    }
    try {
      await send(d, 'toggle', { entity_id: e });
      return true;
    } catch (err) {
      console.warn(`Home Assistant: ${e}:`, err);
      return false;
    }
  }

  // ------------------------------------------------------------------ blink test
  // To confirm the low-confidence mappings (which of a numbered set of bulbs is which can): pick a fixture, and the test
  // takes its set (the low-confidence fixtures in the same room of the same kind). For each bulb in turn it flashes it
  // three times, then puts it back exactly as it was (on at its brightness and colour, or off), and asks which fixture
  // blinked: aim at it and press T (or Shift-click), or say none. The answers come out as map lines to paste (and in
  // localStorage twin.blinkResults). Hidden unless the page has ?hablink. Flashing goes through send(), so the same
  // allowlist applies; groups and unavailable bulbs are left out.
  const blink: BlinkState = { active: false, queue: [], i: 0, answers: [], busy: false, fid: null };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  function blinkSet(fid: string): { fixtures: string[]; entities: string[] } {
    const f = fixtures[fid],
      m = ha.map[fid] || {};
    const same = Object.keys(ha.map).filter(
      (id) =>
        fixtures[id] &&
        ha.map[id].conf === (m.conf || 'low') &&
        fixtures[id].userData.room === f.userData.room &&
        fixtures[id].userData.fixture_kind === f.userData.fixture_kind,
    );
    const ents = [...new Set(same.flatMap((id) => entitiesOf(id)))].filter(
      (e) =>
        e.startsWith('light.') &&
        !Array.isArray(ha.entities[e]?.attributes?.entity_id) &&
        !['unavailable', 'unknown', undefined].includes(ha.entities[e]?.state),
    );
    return { fixtures: same, entities: ents.sort() };
  }
  async function flash(e: string): Promise<void> {
    const st = ha.entities[e];
    const was = st.state,
      a = st.attributes || {};
    for (let k = 0; k < 3; k++) {
      await send('light', 'turn_on', { entity_id: e, brightness: 255 });
      await sleep(600);
      await send('light', 'turn_off', { entity_id: e });
      await sleep(600);
    }
    if (was === 'on') {
      // back as it was: brightness, then its colour in its own mode
      const back: ServiceData = { entity_id: e };
      if (a.brightness != null) back.brightness = a.brightness;
      if (a.color_mode === 'color_temp' && a.color_temp_kelvin) back.color_temp_kelvin = a.color_temp_kelvin;
      else if (Array.isArray(a.xy_color)) back.xy_color = a.xy_color;
      else if (Array.isArray(a.rgb_color)) back.rgb_color = a.rgb_color;
      await send('light', 'turn_on', back);
    }
  }
  async function blinkStart(fid: string): Promise<void> {
    if (!q.has('hablink') || blink.active) return;
    const set = blinkSet(fid);
    if (!set.entities.length) {
      ha.fx[fid].err = 'blink test: no bulbs to flash in this set';
      onChange?.();
      return;
    }
    if (
      !window.confirm(
        `Blink test: flash ${set.entities.length} light(s) one at a time (${set.entities.join(', ')}), 3 times each, then put each back as it was?`,
      )
    )
      return;
    Object.assign(blink, { active: true, queue: set.entities, i: 0, answers: [], fid, fixtures: set.fixtures });
    blinkNext();
  }
  async function blinkNext(): Promise<void> {
    if (blink.i >= blink.queue.length) return blinkEnd();
    blink.busy = true;
    drawBlink();
    try {
      await flash(blink.queue[blink.i]);
    } catch (err) {
      blink.answers.push({ entity: blink.queue[blink.i], error: String((err as Error)?.message || err) });
      blink.i++;
      blink.busy = false;
      return blinkNext();
    }
    blink.busy = false;
    drawBlink();
  }
  function blinkAnswer(fid: string | null): boolean {
    // fid: the fixture that blinked, or null (didn't see it)
    if (!blink.active || blink.busy) return false;
    blink.answers.push({ entity: blink.queue[blink.i], fixture: fid });
    blink.i++;
    blinkNext();
    return true;
  }
  function blinkEnd(): void {
    blink.active = false;
    const day = new Date().toISOString().slice(0, 10);
    const lines = blink.answers.map((a) =>
      a.fixture
        ? `  ${a.fixture}:\n    entity_id: ${a.entity}\n    conf: high\n    src: "blink test ${day}: flashed ${a.entity}, seen at ${a.fixture}"`
        : `  # ${a.entity}: ${a.error ? `not flashed (${a.error})` : 'nobody saw a fixture blink'}`,
    );
    blink.result = lines.join('\n');
    try {
      localStorage.setItem('twin.blinkResults', JSON.stringify({ day, answers: blink.answers }));
    } catch {
      /* private mode */
    }
    drawBlink();
  }
  function drawBlink(): void {
    const el = $('hablink');
    if (!el) return;
    el.classList.toggle('hidden', !blink.active && !blink.result);
    if (blink.active) {
      const e = blink.queue[blink.i];
      el.innerHTML = `<b>Blink test</b> ${blink.i + 1} / ${blink.queue.length}: ${e}<br>${blink.busy ? 'flashing…' : 'Which fixture blinked? Aim at it and press T (or Shift-click it).'}
        <button type="button" id="hablinknone" ${blink.busy ? 'disabled' : ''}>Didn't see it</button>
        <button type="button" id="hablinkstop">Stop</button>`;
      $('hablinknone').onclick = (ev) => {
        (ev.target as HTMLElement).blur();
        blinkAnswer(null);
      };
      $('hablinkstop').onclick = (ev) => {
        (ev.target as HTMLElement).blur();
        blink.i = blink.queue.length;
        if (!blink.busy) blinkEnd();
      };
    } else if (blink.result) {
      el.innerHTML =
        '<b>Blink test done</b>: paste into the map\'s <code>fixtures:</code> (also kept in this browser)<textarea readonly rows="6"></textarea><button type="button" id="hablinkclose">Close</button>';
      el.querySelector('textarea')!.value = blink.result;
      $('hablinkclose').onclick = () => {
        blink.result = null;
        drawBlink();
      };
    }
  }

  // the inspect panel's switch section for a fixture: a DOM element, or null when HA isn't in use
  function panel(fid: string): HTMLElement | null {
    if (!fid || !ha.engaged) return null;
    const f = ha.fx[fid],
      m = ha.map[fid] || {};
    if (!f) return null;
    const div = document.createElement('div');
    div.className = 'haswitch';
    const why = toggleBlocker(fid);
    const { n, groups } = bulbsOf(fid);
    const kind = f.look?.kind;
    if (!why) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = f.pending
        ? f.pending.to === 'on'
          ? 'Turning on…'
          : 'Turning off…'
        : kind === 'on'
          ? 'Turn off'
          : 'Turn on';
      b.disabled = !!f.pending || blink.active;
      b.onclick = (e) => {
        (e.currentTarget as HTMLElement).blur();
        toggleFixture(fid);
      };
      div.appendChild(b);
      const note = document.createElement('span');
      note.className = 'hanote';
      // other fixtures on the same entity switch too (a group standing in for a set of cans)
      const others = new Set(entitiesOf(fid).flatMap((e) => ha.byEntity[e] || []));
      others.delete(fid);
      note.textContent =
        ` ${n > 1 ? `toggles ${n} bulbs${groups ? ` (${groups === 1 ? 'a Hue zone / group' : `${groups} groups`})` : ''}` : 'toggles 1 bulb'}` +
        `${others.size ? `, with ${others.size} other fixture${others.size > 1 ? 's' : ''} in the model` : ''} · T or Shift-click`;
      div.appendChild(note);
      if (q.has('hablink') && m.conf === 'low') {
        const t = document.createElement('button');
        t.type = 'button';
        t.textContent = 'Blink test this set…';
        t.disabled = blink.active;
        t.onclick = (e) => {
          (e.currentTarget as HTMLElement).blur();
          blinkStart(fid);
        };
        div.appendChild(t);
      }
    } else {
      const s = document.createElement('div');
      s.className = 'hanote';
      s.textContent = `Can't switch: ${why}`;
      div.appendChild(s);
    }
    if (m.conf === 'low') {
      const w = document.createElement('div');
      w.className = 'hawarn';
      w.textContent = '⚠ unconfirmed mapping: this may be another bulb of the same set';
      w.title = m.src || '';
      div.appendChild(w);
    }
    if (f.err) {
      const r = document.createElement('div');
      r.className = 'haerr';
      r.textContent = f.err.length > 60 ? `${f.err.slice(0, 57)}…` : f.err;
      r.title = f.err;
      div.appendChild(r);
    }
    return div;
  }

  // ------------------------------------------------------------------ live: the OAuth login and the websocket
  const saveTokens = (t: AuthData | null) => {
    try {
      if (t) localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
      else localStorage.removeItem(TOKENS_KEY);
    } catch {
      /* private mode */
    }
  };
  const loadTokens = async (): Promise<AuthData | null | undefined> => {
    try {
      return JSON.parse(localStorage.getItem(TOKENS_KEY) as string) as AuthData | null;
    } catch {
      return null;
    }
  };
  const hasTokens = (): boolean => {
    try {
      return !!JSON.parse(localStorage.getItem(TOKENS_KEY) as string);
    } catch {
      return false;
    }
  };
  function why(err: unknown): string {
    if (err === ERR_INVALID_AUTH) return 'login refused or expired; connect again';
    if (err === ERR_CANNOT_CONNECT) return `can't reach ${HASS_URL}`;
    if (err === ERR_INVALID_AUTH_CALLBACK) return 'login came back for another server';
    if (err instanceof TypeError)
      return `blocked (is ${location.origin} in HA's cors_allowed_origins? See the Home Assistant docs)`;
    return String((err as Error)?.message || err);
  }

  async function connect(): Promise<void> {
    if (mode !== 'live' || ha.conn) return;
    if (!HASS_URL) {
      setStatus('error', 'no Home Assistant URL in the site manifest');
      return;
    }
    setStatus('connecting');
    try {
      const auth = await getAuth({ hassUrl: HASS_URL, saveTokens, loadTokens }); // may navigate away to HA's login
      const q2 = new URLSearchParams(location.search);
      if (q2.has('auth_callback')) {
        // tidy the login's code and state out of the address bar
        for (const k of ['auth_callback', 'code', 'state']) q2.delete(k);
        history.replaceState(null, '', location.pathname + (q2.toString() ? `?${q2}` : '') + location.hash);
      }
      if (auth.expired) await auth.refreshAccessToken();
      const conn = await createConnection({ auth });
      ha.conn = conn;
      conn.addEventListener('ready', () => setStatus('live')); // reconnected (the library retries)
      conn.addEventListener('disconnected', () => setStatus('connecting', 'connection lost, retrying'));
      conn.addEventListener('reconnect-error', (_c, e) => {
        if (e === ERR_INVALID_AUTH) {
          saveTokens(null);
          disconnect();
        }
        setStatus('error', why(e));
      });
      engage();
      subscribeEntities(conn, (ents) => onEntities(ents as unknown as Entities));
      setStatus('live');
    } catch (err) {
      if (err === ERR_INVALID_AUTH) saveTokens(null);
      ha.conn = null;
      setStatus('error', why(err));
      console.warn('Home Assistant:', err);
    }
  }

  function disconnect(forget = false): void {
    if (ha.conn) {
      ha.conn.close();
      ha.conn = null;
    }
    if (forget) saveTokens(null);
    onEntities({});
    setStatus('disconnected');
  }

  // ------------------------------------------------------------------ mock: a fake, repeatable state stream
  // Every fixture without a confirmed entity gets one per switched group (light.mock_<group>), so a group switches
  // together as it does in a real building. States come from a seeded generator (?hamock=<seed>): about 60 % on at
  // assorted brightness and colour temperature, a few RGB, about 8 % unavailable and 3 % unknown. Every 2 s one entity
  // flips, as a live building would (?hamock=static: no changes). twin.ha.mock.set(entity, state, attrs) sets one.
  function startMock(): void {
    let seed = +(q.get('hamock') as string) || 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const now = Date.now();
    const invent = (e: string): EntityState => {
      const r = rnd();
      const st = r < 0.08 ? 'unavailable' : r < 0.11 ? 'unknown' : r < 0.71 ? 'on' : 'off';
      const a: EntityState['attributes'] = { friendly_name: e.replace(/^light\.mock_/, '').replace(/_/g, ' ') };
      if (st === 'on') {
        a.brightness = Math.round(70 + rnd() * 185);
        if (rnd() < 0.12) {
          a.color_mode = 'rgb';
          a.rgb_color = [255, Math.round(rnd() * 120), Math.round(80 + rnd() * 175)];
        } else {
          a.color_mode = 'color_temp';
          a.color_temp_kelvin = Math.round(2200 + rnd() * 1800);
        }
      }
      return { entity_id: e, state: st, attributes: a, last_changed: new Date(now - rnd() * 864e5).toISOString() };
    };
    // the switched group is the fixture's `fixture_group` extra (a `fixture.` prefix is dropped: docs/model-format.md)
    // give fixtures with no confirmed entity a made-up one (also an extra model's lamps, which arrive later)
    const adopt = (ids: string[]) => {
      const ents = { ...ha.entities };
      for (const id of ids) {
        if (entityOf(id)) continue;
        const g = String(fixtures[id].userData.fixture_group || id)
          .replace(/^fixture\./, '')
          .replace(/[^a-z0-9]+/gi, '_')
          .toLowerCase();
        ha.map[id] = { ...(ha.map[id] || {}), entity_id: `light.mock_${g}`, conf: 'mock', src: '?ha=mock' };
      }
      index();
      for (const e of Object.keys(ha.byEntity).sort()) if (!ents[e]) ents[e] = invent(e);
      ha.entities = ents;
    };
    const set = (e: string, state: string, attributes: Record<string, unknown> = {}) => {
      const prev = ha.entities[e] || { entity_id: e, attributes: {} };
      onEntities({
        ...ha.entities,
        [e]: {
          ...prev,
          state,
          attributes: { ...prev.attributes, ...attributes },
          last_changed: new Date().toISOString(),
        },
      });
    };
    // replay recorded states (e.g. HA's /api/states) over the made-up ones
    const load = (list: EntityState[]) =>
      onEntities({ ...ha.entities, ...Object.fromEntries(list.map((x) => [x.entity_id, x])) });
    // the controls: scripts idle, a switch on at a made-up 490 W. run() plays a control's `mock` stand-in: the script is "on"
    // for 1.5 s, then the listed rooms' mapped lights go on or off
    for (const c of ha.controls) {
      if (!ha.entities[c.entity_id])
        ha.entities[c.entity_id] = {
          entity_id: c.entity_id,
          state: c.action === 'run' ? 'off' : 'on',
          attributes: { friendly_name: c.label },
          last_changed: new Date().toISOString(),
        };
      if (c.power && !ha.entities[c.power])
        ha.entities[c.power] = { entity_id: c.power, state: '490', attributes: { unit_of_measurement: 'W' } };
    }
    const run = async (c: Control, service: string) => {
      await new Promise((r) => setTimeout(r, 250)); // a round trip
      if (c.action === 'toggle') {
        set(c.entity_id, service === 'turn_on' ? 'on' : 'off');
        if (c.power) set(c.power, service === 'turn_on' ? '490' : '0');
        return;
      }
      set(c.entity_id, 'on');
      setTimeout(() => {
        const m = c.mock || {},
          ents = { ...ha.entities },
          now = new Date().toISOString();
        const inList = (list: string[] | undefined, room: string) =>
          (list || []).includes('*') || (list || []).includes(room);
        for (const f of Object.values(ha.fx)) {
          const room = f.node.userData.room as string;
          if ((m.except || []).includes(room)) continue;
          const to = inList(m.lights_on, room) ? 'on' : inList(m.lights_off, room) ? 'off' : null;
          if (!to) continue;
          for (const e of entitiesOf(f.id)) {
            if (!e.startsWith('light.')) continue; // lights only: not a plug-in switch
            const prev = ents[e] || { entity_id: e, attributes: {} };
            ents[e] = {
              ...prev,
              state: to,
              attributes: { brightness: 200, color_temp_kelvin: 2700, ...prev.attributes },
              last_changed: now,
            };
          }
        }
        ents[c.entity_id] = { ...ents[c.entity_id], state: 'off', last_changed: now };
        onEntities(ents);
      }, 1500);
    };
    // send() lands here in ?ha=mock: a 250 ms round trip, then the states change as HA would report them (a group
    // also switches its members). ha.mock.failNext = 'reason' makes the next call fail, to test the error path;
    // ha.mock.calls records every call.
    const service = async (domain: string, svc: string, data: ServiceData) => {
      mock.calls.push({ domain, service: svc, data, t: Date.now() });
      await new Promise((r) => setTimeout(r, 250));
      if (mock.failNext) {
        const m = mock.failNext;
        mock.failNext = null;
        throw new Error(m);
      }
      if (mock.silent) return; // HA accepts but nothing changes (a dead bulb)
      const ents = { ...ha.entities },
        now = new Date().toISOString();
      const { entity_id: eid, ...attrs } = data;
      const apply = (e: string, to: string) => {
        const prev = ents[e] || { entity_id: e, attributes: {} };
        ents[e] = {
          ...prev,
          state: to,
          attributes: { ...prev.attributes, ...(to === 'on' ? attrs : {}) },
          last_changed: now,
        };
        for (const m of Array.isArray(prev.attributes?.entity_id) ? prev.attributes.entity_id : []) apply(m, to);
      };
      for (const e of ([] as string[]).concat(eid)) {
        const to = svc === 'toggle' ? (ents[e]?.state === 'on' ? 'off' : 'on') : svc === 'turn_on' ? 'on' : 'off';
        apply(e, to);
        if (domain === 'switch')
          for (const c of ha.controls)
            if (c.entity_id === e && c.power) ents[c.power] = { ...ents[c.power], state: to === 'on' ? '490' : '0' };
      }
      onEntities(ents);
    };
    const mock: MockApi = { set, adopt, load, run, service, calls: [], failNext: null, silent: false };
    ha.mock = mock;
    engage();
    syncFixtures();
    onEntities(ha.entities);
    setStatus('mock');
    if (q.get('hamock') !== 'static') {
      setInterval(() => {
        const list = Object.keys(ha.entities).filter(
          (e) => e.startsWith('light.') && ['on', 'off'].includes(ha.entities[e].state),
        );
        const e = list[Math.floor(rnd() * list.length)];
        if (e)
          set(
            e,
            ha.entities[e].state === 'on' ? 'off' : 'on',
            ha.entities[e].attributes.brightness ? {} : { brightness: 200, color_temp_kelvin: 2700 },
          );
      }, 2000);
    }
  }

  // ------------------------------------------------------------------ the inspect panel and the hover label
  const ago = (iso: string): string => {
    const s = (Date.now() - Date.parse(iso)) / 1000;
    return s < 90
      ? `${Math.round(s)} s ago`
      : s < 5400
        ? `${Math.round(s / 60)} min ago`
        : s < 172800
          ? `${Math.round(s / 3600)} h ago`
          : `${Math.round(s / 86400)} d ago`;
  };
  function infoRows(fid: string): [string, string][] {
    if (!fid || (!ha.engaged && !ha.map[fid])) return [];
    const m = ha.map[fid] || {};
    const es = entitiesOf(fid);
    if (!es.length)
      return [['HA entity', `none yet${m.group ? ` (group ${m.group})` : ''}${m.src ? `; ${m.src}` : ''}`]];
    const rows: [string, string][] = [['HA mapping', [m.conf, m.src].filter(Boolean).join('; ')]];
    for (const e of es) {
      // one block per entity (a fixture can have several bulbs)
      const st = ha.entities[e];
      rows.push(['HA entity', e]);
      if (!ha.engaged) {
        rows.push(['HA state', 'not connected']);
        continue;
      }
      if (!st) {
        rows.push(['HA state', 'not in Home Assistant']);
        continue;
      }
      const a = st.attributes || {};
      let s = st.state;
      if (s === 'on') {
        if (a.brightness != null) s += ` · ${Math.round((100 * a.brightness) / 255)} %`;
        if (Array.isArray(a.rgb_color) && a.color_mode !== 'color_temp') s += ` · rgb(${a.rgb_color.join(', ')})`;
        else if (a.color_temp_kelvin) s += ` · ${a.color_temp_kelvin} K`;
      }
      if (st.state === 'unavailable' && m.unavailable_means === 'off')
        s += ' (shown as off: power cut at the wall switch)';
      rows.push(['HA state', s]);
      if (a.friendly_name) rows.push(['HA name', a.friendly_name]);
      if (st.last_changed)
        rows.push(['last changed', `${new Date(st.last_changed).toLocaleString('en-GB')} (${ago(st.last_changed)})`]);
    }
    return rows;
  }
  function hoverSuffix(fid: string): string {
    const l = ha.engaged && ha.fx[fid]?.look;
    if (!l || l.kind === 'none') return '';
    return ` · ${l.kind === 'fault' ? 'unavailable' : l.kind}${l.kind === 'on' ? ` ${Math.round(100 * l.level)}%` : ''}`;
  }

  function setWallhack(on: boolean): void {
    ha.wallhack = on;
    if ($('hawall')) $<HTMLInputElement>('hawall').checked = on;
    poolT = 0;
    onChange?.();
  }

  // ------------------------------------------------------------------ start
  async function start(): Promise<void> {
    $('habtn').addEventListener('click', (e) => {
      (e.target as HTMLElement).blur();
      if (ha.conn || ha.status === 'connecting') disconnect(true);
      else connect();
    });
    $('hawall').addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      setWallhack(t.checked);
      t.blur();
    });
    $<HTMLInputElement>('hawall').checked = ha.wallhack;
    $('harow').classList.remove('hidden');
    setStatus(mode === 'mock' ? 'mock' : 'disconnected');
    await loadMap();
    await loadControls();
    index();
    if (mode === 'mock') return startMock();
    // reconnect by itself after the login redirect, or when this browser already holds tokens
    if (mode === 'live' && (q.has('auth_callback') || hasTokens())) connect();
  }

  return Object.assign(ha, {
    start,
    connect,
    disconnect,
    update,
    infoRows,
    hoverSuffix,
    entityOf,
    entitiesOf,
    setWallhack,
    lookOf,
    kelvinRGB,
    act,
    toggleFixture,
    toggleBlocker,
    panel,
    blinkAnswer,
    blinkStart,
    blink,
    send,
    togglePlateEntity,
    poolSize: POOL,
  });
}

export type HA = ReturnType<typeof createHA>;
