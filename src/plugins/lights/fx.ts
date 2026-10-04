// The lights' look in the scene: each mapped fixture's emitting parts glow by its entity's state (scaled by brightness,
// tinted by colour temperature or RGB), lit fixtures get a halo, and the nearest few to the camera get one of a fixed
// pool of real point lights. A fixture whose entities are all unavailable glows dull red and, while the faults
// overlay is on, gets a red marker drawn through walls (unless a device marker already shows its fault). Moved
// unchanged from the prototype's Home Assistant layer, so the scene renders exactly as before.
import * as THREE from 'three';
import { isMesh, isShown } from '../../core/three-utils';
import type { MaterialOverride, MaterialsApi } from '../../plugin-api';
import type { Look } from './look';

/** a fixture's glowing copy sits at the bottom of the mesh's material stack: a fade or energy mode draws over it */
const GLOW_PRIORITY = -10;

const LINE_MIN = 1.2; // m: an emitter longer than this is treated as a line (cove, strip)
const LINE_STEP = 0.6; // m between halos along a line
const LINE_LIGHTS = 4; // at most this many pooled lights for one line fixture
const OTHER_ROOM = 6; // m added to a fixture's distance when it isn't in the camera's room

type Emitter = {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  base: { emissive: THREE.Color; intensity: number };
  /** the glowing copy over the shared material (taken off on dispose) */
  override: MaterialOverride;
};

/** a fixture as the lights plugin drives it */
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

/** which parts of a fixture glow when none of its materials is emissive (material names) */
export const DEFAULT_EMITTER_HINTS = 'glass|bulb|lens|shade|led|light|globe|candle|alabaster|amber|dome|bowl|hue';

export interface LightFxDeps {
  scene: THREE.Scene;
  camera: THREE.Camera;
  fixtures: Record<string, THREE.Object3D>;
  /** the core's material overrides */
  materials: MaterialsApi;
  emitterHints?: string;
  /** real point lights (?halights) */
  poolSize: number;
  /** the room id the camera is in, or null */
  room(): string | null;
  seen(p: THREE.Vector3): boolean;
  /** the entities bound to a fixture */
  entitiesOf(fid: string): string[];
  /** the faults overlay is on */
  wallOn(): boolean;
  /** a device marker (faults plugin) already shows this entity's fault */
  covers(e: string): boolean;
}

export function createLightFx({
  scene,
  camera,
  fixtures,
  materials,
  emitterHints,
  poolSize: POOL,
  room,
  seen,
  entitiesOf,
  wallOn,
  covers,
}: LightFxDeps) {
  const ha = {
    fx: {} as Record<string, FixtureFx>,
    pool: [] as THREE.PointLight[],
    halo: null as Halos | null,
    haloLine: null as Halos | null,
    wall: null as Halos | null,
    engaged: false,
    lit: 0,
    faults: 0,
  };
  // material-name hints for a fixture's emitting parts (the site can give its own)
  const EMIT_NAME = new RegExp(emitterHints || DEFAULT_EMITTER_HINTS, 'i');
  function prepFixture(id: string): void {
    const node = fixtures[id];
    const meshes: THREE.Mesh[] = [];
    node.traverse((o) => {
      if (isMesh(o)) meshes.push(o);
    });
    // the mesh's own, whatever another plugin draws over it for now (energy mode's ghost, the blueprint fade)
    const matOf = (o: THREE.Mesh) => materials.base(o) as THREE.MeshStandardMaterial;
    const isEm = (m: THREE.MeshStandardMaterial) =>
      m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) * (m.emissiveIntensity ?? 1) > 0.01;
    let em = meshes.filter((o) => isEm(matOf(o)) || EMIT_NAME.test(matOf(o).name || ''));
    if (!em.length) em = meshes;
    const parts: Emitter[] = em.map((o) => {
      const base = matOf(o);
      const mat = base.clone();
      const override = materials.push(o, mat, { priority: GLOW_PRIORITY });
      return { mesh: o, mat, base: { emissive: base.emissive.clone(), intensity: base.emissiveIntensity }, override };
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
      } else if (look.kind === 'off') {
        p.mat.emissive.setRGB(0, 0, 0);
      } else if (look.kind === 'fault') {
        p.mat.emissive.copy(FAULT);
        p.mat.emissiveIntensity = 0.6;
      } else {
        p.mat.emissive.copy(look.colour);
        // the build's own strength (KHR_materials_emissive_strength) is the "full" glow; a dimmed light keeps a little
        p.mat.emissiveIntensity = Math.max(1.5, p.base.intensity) * (0.15 + 0.85 * look.level);
      }
      p.override.refresh(); // a copy drawn over it (the blueprint fade) takes the new glow
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
  }

  let poolT = 0;
  const tmpV = new THREE.Vector3();

  function update(dt: number): void {
    if (!ha.engaged) return;
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
    const here = room();
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
      if (!c.away || seen(c.p)) chosen.push(c);
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
    const own = faults.filter((f) => !entitiesOf(f.id).some(covers));
    const wallhack = wallOn();
    fill(ha.wall!, wallhack ? own.map((f) => ({ p: f.at, c: FAULT })) : []);
    ha.wall!.visible = wallhack;
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

  /** take everything out of the scene again and give the fixtures their own materials back */
  function dispose(): void {
    for (const l of ha.pool) scene.remove(l);
    for (const p of [ha.halo, ha.haloLine, ha.wall]) {
      if (!p) continue;
      scene.remove(p);
      p.geometry.dispose();
      p.material.map?.dispose();
      p.material.dispose();
    }
    for (const f of Object.values(ha.fx))
      for (const e of f.parts) {
        e.override.dispose();
        e.mat.dispose();
      }
    ha.pool = [];
    ha.fx = {};
    ha.engaged = false;
  }

  return Object.assign(ha, { prepFixture, applyLook, engage, update, dispose, FAULT, poke: () => (poolT = 0) });
}

export type LightFx = ReturnType<typeof createLightFx>;
