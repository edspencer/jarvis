// Drawing helpers and shapes for the first floor (areas/upstairs.ts): a local frame for things that stand against a
// wall, merged built-ins with a parts entry per piece, shared furniture meshes, and the furniture, fittings and
// fixture shapes themselves. Everything is low-poly boxes and lathes in the plan frame (X east, Y north, Z up).
import type { Mesh } from '@gltf-transform/core';
import { Geo, Shape, type V3 } from '../../geometry.ts';
import type { Model } from '../../model.ts';

/** quarter turns anticlockwise: what the front (+v) faces. 0 north, 1 west, 2 south, 3 east */
export type Quarter = 0 | 1 | 2 | 3;
export const N: Quarter = 0,
  Wst: Quarter = 1,
  S: Quarter = 2,
  E: Quarter = 3;

/** draws in a local frame: u across (to the right, seen from the front), v out from the back (the front faces +v), w
 * up from the origin; the origin is a plan point, turned q quarters anticlockwise. Keeps the plan extent it drew. */
export class Local {
  lo: V3 = [Infinity, Infinity, Infinity];
  hi: V3 = [-Infinity, -Infinity, -Infinity];
  mats = new Set<string>();
  s: Shape;
  o: V3;
  q: Quarter;
  constructor(s: Shape, o: V3 = [0, 0, 0], q: Quarter = 0) {
    this.s = s;
    this.o = o;
    this.q = q;
  }
  xy(u: number, v: number): [number, number] {
    const [x, y] = this.o;
    switch (this.q) {
      case 0:
        return [x + u, y + v];
      case 1:
        return [x - v, y + u];
      case 2:
        return [x - u, y - v];
      default:
        return [x + v, y - u];
    }
  }
  private grow(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    const a = [x0, y0, z0],
      b = [x1, y1, z1];
    for (let i = 0; i < 3; i++) {
      this.lo[i] = Math.min(this.lo[i], a[i]);
      this.hi[i] = Math.max(this.hi[i], b[i]);
    }
  }
  box(mat: string, u0: number, v0: number, w0: number, u1: number, v1: number, w1: number): this {
    const [a, b] = this.xy(u0, v0),
      [c, d] = this.xy(u1, v1);
    const z = this.o[2];
    const bx = [Math.min(a, c), Math.min(b, d), z + w0, Math.max(a, c), Math.max(b, d), z + w1] as const;
    this.s.on(mat).box(...bx);
    this.grow(...bx);
    this.mats.add(mat);
    return this;
  }
  /** a solid of revolution about the vertical through (u, v): rings of (w, radius) */
  lathe(mat: string, u: number, v: number, rings: [number, number][], n = 8): this {
    const [x, y] = this.xy(u, v);
    const z = this.o[2];
    this.s.on(mat).lathe(
      x,
      y,
      rings.map(([w, r]) => [z + w, r] as [number, number]),
      n,
    );
    const r = Math.max(...rings.map(([, r]) => r));
    this.grow(
      x - r,
      y - r,
      z + Math.min(...rings.map(([w]) => w)),
      x + r,
      y + r,
      z + Math.max(...rings.map(([w]) => w)),
    );
    this.mats.add(mat);
    return this;
  }
}

/** a merged built-in node (docs/model-format.md §7): pieces drawn in local frames, a parts entry each */
export class Fitted {
  shape = new Shape();
  list: [string, number[], string[], Record<string, unknown>][] = [];
  piece(name: string, o: V3, q: Quarter, draw: (l: Local) => void, extras: Record<string, unknown> = {}): this {
    const l = new Local(this.shape, o, q);
    draw(l);
    this.list.push([name, Geo.gltfBox(...l.lo, ...l.hi), [...l.mats].sort(), extras]);
    return this;
  }
  write(m: Model, name: string, key: string, extras: Record<string, unknown>) {
    m.parts[key] = this.list;
    return m.node(name, this.shape, { merged: key, ...extras });
  }
}

/** one mesh per model for a shape drawn about its origin (furniture that repeats) */
const meshes = new WeakMap<Model, Map<string, Mesh>>();
export function shared(m: Model, key: string, draw: (l: Local) => void): Mesh {
  let byKey = meshes.get(m);
  if (!byKey) meshes.set(m, (byKey = new Map()));
  let mesh = byKey.get(key);
  if (!mesh) {
    const s = new Shape();
    draw(new Local(s));
    byKey.set(key, (mesh = m.mesh(key, s)));
  }
  return mesh;
}
/** a furniture node: a shared shape (front +Y) placed at a plan point and turned (radians, anticlockwise) */
export function put(m: Model, name: string, room: string, product: string, mesh: Mesh, at: V3, yaw = 0) {
  return m.node(name, mesh, { room, product }, { at, yaw: yaw || undefined });
}
export const quarter = (q: Quarter) => (q * Math.PI) / 2;

// ------------------------------------------------------------------ furniture (origin: the back's middle, on the floor)
/** a nightstand, 0.42 × 0.4 × 0.6, a drawer and a shelf */
export function nightstand(l: Local, wood: string): void {
  l.box(wood, -0.21, 0, 0, -0.19, 0.4, 0.58); // sides
  l.box(wood, 0.19, 0, 0, 0.21, 0.4, 0.58);
  l.box(wood, -0.19, 0, 0.1, 0.19, 0.02, 0.58); // back
  l.box(wood, -0.19, 0.02, 0.1, 0.19, 0.4, 0.12); // the shelf
  l.box(wood, -0.21, 0, 0.58, 0.21, 0.4, 0.6); // top
  l.box(wood, -0.19, 0.02, 0.38, 0.19, 0.405, 0.57); // the drawer
  l.box('black_steel', -0.19, 0.39, 0.37, 0.19, 0.4, 0.38);
  l.box('black_steel', -0.04, 0.405, 0.48, 0.04, 0.42, 0.495); // pull
}

/** a chest of drawers w wide, 0.48 deep, h high: two columns of drawers on a plinth */
export function dresser(l: Local, w: number, h: number, wood: string): void {
  const d = 0.48;
  l.box(wood, -w / 2 + 0.03, 0, 0, w / 2 - 0.03, d - 0.04, 0.08); // plinth (set back)
  l.box(wood, -w / 2, 0, 0.08, w / 2, d, h - 0.03);
  l.box(wood, -w / 2 - 0.01, -0.0, h - 0.03, w / 2 + 0.01, d + 0.015, h); // top
  const rows = 3,
    z0 = 0.1,
    z1 = h - 0.05;
  for (let r = 1; r < rows; r++) {
    const z = z0 + ((z1 - z0) * r) / rows;
    l.box('black_steel', -w / 2 + 0.02, d, z - 0.004, w / 2 - 0.02, d + 0.004, z + 0.004);
  }
  l.box('black_steel', -0.004, d, z0, 0.004, d + 0.004, z1);
  for (let r = 0; r < rows; r++) {
    const z = z0 + ((z1 - z0) * (r + 0.5)) / rows;
    for (const u of [-w / 4, w / 4]) l.box('black_steel', u - 0.06, d, z - 0.008, u + 0.06, d + 0.02, z + 0.008);
  }
}

/** a bed: headboard at the back (v = 0), mattress, duvet with its top folded, pillows */
export function bed(l: Local, w: number, len: number, frame: string, duvet: string, pillows: number, head = 1.1) {
  l.box(frame, -w / 2 - 0.03, 0, 0, w / 2 + 0.03, 0.06, head);
  l.box(frame, -w / 2, 0.06, 0.06, w / 2, len, 0.3);
  for (const u of [-w / 2, w / 2 - 0.05]) l.box(frame, u, len - 0.05, 0, u + 0.05, len, 0.06);
  l.box('up_bedding_white', -w / 2 + 0.02, 0.07, 0.3, w / 2 - 0.02, len - 0.02, 0.54);
  l.box(duvet, -w / 2 - 0.015, 0.62, 0.36, w / 2 + 0.015, len + 0.015, 0.58);
  l.box('up_bedding_white', -w / 2 - 0.02, 0.62, 0.575, w / 2 + 0.02, 0.82, 0.595); // the folded-back top
  const pw = (w - 0.1) / pillows;
  for (let i = 0; i < pillows; i++) {
    const u0 = -w / 2 + 0.05 + i * pw;
    l.box('up_bedding_white', u0 + 0.02, 0.1, 0.54, u0 + pw - 0.02, 0.5, 0.66);
  }
}

/** an upholstered bench, w × 0.42 × 0.47, on four legs */
export function bench(l: Local, w: number, fabric: string, wood: string) {
  for (const u of [-w / 2 + 0.03, w / 2 - 0.07])
    for (const v of [0.03, 0.35]) l.box(wood, u, v, 0, u + 0.04, v + 0.04, 0.32);
  l.box(wood, -w / 2, 0, 0.32, w / 2, 0.42, 0.36);
  l.box(fabric, -w / 2 + 0.01, 0.01, 0.36, w / 2 - 0.01, 0.41, 0.47);
}

/** an armchair facing +v: back, arms, cushion, legs */
export function armchair(l: Local, fabric: string, wood: string) {
  for (const u of [-0.36, 0.32]) for (const v of [0.04, 0.72]) l.box(wood, u, v, 0, u + 0.04, v + 0.04, 0.12);
  l.box(fabric, -0.38, 0.02, 0.12, 0.38, 0.8, 0.4); // base
  l.box(fabric, -0.38, 0, 0.12, 0.38, 0.2, 0.9); // back
  l.box(fabric, -0.38, 0.12, 0.4, -0.27, 0.8, 0.6); // arms
  l.box(fabric, 0.27, 0.12, 0.4, 0.38, 0.8, 0.6);
  l.box(fabric, -0.26, 0.2, 0.4, 0.26, 0.78, 0.5); // cushion
}

/** a small round side table */
export function sideTable(l: Local, wood: string) {
  l.lathe(
    wood,
    0,
    0,
    [
      [0.52, 0.22],
      [0.55, 0.22],
    ],
    10,
  );
  l.box(wood, -0.02, -0.02, 0.03, 0.02, 0.02, 0.52);
  l.lathe(
    wood,
    0,
    0,
    [
      [0, 0.15],
      [0.03, 0.15],
    ],
    10,
  );
}

/** a desk w × 0.6 × 0.75 with a drawer under the top */
export function desk(l: Local, w: number, top: string, legs: string) {
  for (const u of [-w / 2 + 0.02, w / 2 - 0.06])
    for (const v of [0.02, 0.54]) l.box(legs, u, v, 0, u + 0.04, v + 0.04, 0.72);
  l.box(top, -w / 2, 0, 0.72, w / 2, 0.6, 0.75);
  l.box(top, -0.3, 0.1, 0.6, 0.3, 0.58, 0.72); // drawer
  l.box('black_steel', -0.3, 0.58, 0.6, 0.3, 0.585, 0.603);
  l.box('black_steel', -0.06, 0.585, 0.655, 0.06, 0.6, 0.668);
}

/** a desk chair facing +v (its back at v = 0) */
export function deskChair(l: Local, seat: string, frame: string) {
  for (const u of [-0.21, 0.18]) for (const v of [0.02, 0.4]) l.box(frame, u, v, 0, u + 0.03, v + 0.03, 0.44);
  l.box(seat, -0.22, 0.01, 0.44, 0.22, 0.45, 0.49);
  l.box(frame, -0.21, 0, 0.49, -0.18, 0.03, 0.86);
  l.box(frame, 0.18, 0, 0.49, 0.21, 0.03, 0.86);
  l.box(seat, -0.21, 0, 0.62, 0.21, 0.035, 0.86);
}

/** framed art on a wall (origin: the bottom of the frame, on the wall face): a light frame, a mat, a landscape */
export function art(l: Local, w: number, h: number, sky: string, land: string) {
  l.box('wood_ash', -w / 2, 0, 0, w / 2, 0.03, h);
  l.box('up_art_mat', -w / 2 + 0.04, 0.03, 0.04, w / 2 - 0.04, 0.034, h - 0.04);
  const iw = w / 2 - 0.12,
    i0 = 0.12,
    i1 = h - 0.12;
  const horizon = i0 + (i1 - i0) * 0.42;
  l.box(land, -iw, 0.034, i0, iw, 0.037, horizon);
  l.box(sky, -iw, 0.034, horizon, iw, 0.037, i1);
}

/** a framed mirror on a wall (origin: the bottom middle, on the wall face) */
export function mirror(l: Local, w: number, h: number, frame?: string) {
  if (frame) l.box(frame, -w / 2, 0, 0, w / 2, 0.02, h);
  const f = frame ? 0.04 : 0;
  l.box('up_bath_mirror', -w / 2 + f, 0, f, w / 2 - f, frame ? 0.024 : 0.012, h - f);
}

// ------------------------------------------------------------------ fittings (origin: the back's middle, on the floor)
/** a close-coupled WC: tank on the wall, bowl, seat and lid */
export function wc(l: Local) {
  l.box('sanitary', -0.2, 0.0, 0.42, 0.2, 0.19, 0.83); // tank
  l.box('black_steel', -0.17, 0.19, 0.72, -0.12, 0.21, 0.74); // flush lever
  l.box('sanitary', -0.1, 0.12, 0, 0.1, 0.42, 0.38); // pedestal
  l.box('sanitary', -0.18, 0.18, 0.36, 0.18, 0.3, 0.41); // the bowl's back
  // the bowl, its rim and the seat
  l.lathe(
    'sanitary',
    0,
    0.45,
    [
      [0.22, 0.13],
      [0.36, 0.19],
      [0.41, 0.19],
    ],
    8,
  );
}

/** a bathtub along u (len), v depth from the wall: an apron front and a rim round a basin */
export function tub(l: Local, len: number, dep: number, h = 0.55) {
  const r = 0.08;
  l.box('sanitary', -len / 2, 0, 0, len / 2, dep, 0.12); // base
  l.box('sanitary', -len / 2, 0, 0.12, len / 2, r, h); // rims
  l.box('sanitary', -len / 2, dep - r, 0.12, len / 2, dep, h);
  l.box('sanitary', -len / 2, r, 0.12, -len / 2 + r, dep - r, h);
  l.box('sanitary', len / 2 - r, r, 0.12, len / 2, dep - r, h);
  l.box('bath_tile', -len / 2 + r, r, 0.12, len / 2 - r, dep - r, 0.14);
}

/** a vanity cabinet w wide (doors and a top), with n sinks set in the top and a faucet each */
export function vanity(l: Local, w: number, sinks: number, cab: string, top: string) {
  const d = 0.56,
    h = 0.84;
  l.box(cab, -w / 2 + 0.02, 0, 0, w / 2 - 0.02, d - 0.05, 0.1);
  l.box(cab, -w / 2, 0, 0.1, w / 2, d - 0.02, h);
  l.box(top, -w / 2 - 0.01, 0, h, w / 2 + 0.01, d, h + 0.03);
  const doors = sinks * 2;
  for (let i = 1; i < doors; i++) {
    const u = -w / 2 + (w * i) / doors;
    l.box('black_steel', u - 0.003, d - 0.02, 0.12, u + 0.003, d - 0.016, h - 0.02);
  }
  for (let i = 0; i < doors; i++) {
    const u = -w / 2 + (w * (i + 0.5)) / doors + (i % 2 ? -1 : 1) * (w / doors / 2 - 0.05);
    l.box('black_steel', u - 0.008, d - 0.016, h - 0.2, u + 0.008, d, h - 0.06);
  }
  for (let i = 0; i < sinks; i++) {
    const u = -w / 2 + (w * (i + 0.5)) / sinks;
    l.lathe(
      'sanitary',
      u,
      0.3,
      [
        [h + 0.03, 0.17],
        [h + 0.035, 0.17],
      ],
      10,
    );
    l.lathe(
      'bath_tile',
      u,
      0.3,
      [
        [h + 0.035, 0.14],
        [h + 0.038, 0.14],
      ],
      10,
    );
    l.box('black_steel', u - 0.015, 0.05, h + 0.03, u + 0.015, 0.08, h + 0.28); // faucet
    l.box('black_steel', u - 0.012, 0.05, h + 0.25, u + 0.012, 0.2, h + 0.28);
  }
}

/** a reach-in closet built into a room: side walls and a header to the ceiling, n door panels (origin: the middle of
 * the back wall's face; the front faces +v) */
export function reachIn(l: Local, w: number, dep: number, ceil: number, panels: number) {
  const t = 0.08;
  l.box('door_paint', -w / 2, 0, 0, -w / 2 + t, dep, ceil);
  l.box('door_paint', w / 2 - t, 0, 0, w / 2, dep, ceil);
  l.box('door_paint', -w / 2 + t, dep - t, 2.1, w / 2 - t, dep, ceil);
  l.box('up_closet_dark', -w / 2 + t, 0, 0, w / 2 - t, 0.02, 2.1); // the inside, seen through the seams
  l.box('door_paint', -w / 2 + t - 0.02, dep, 0, -w / 2 + t + 0.03, dep + 0.015, 2.13); // casing
  l.box('door_paint', w / 2 - t - 0.03, dep, 0, w / 2 - t + 0.02, dep + 0.015, 2.13);
  l.box('door_paint', -w / 2 + t - 0.02, dep, 2.08, w / 2 - t + 0.02, dep + 0.015, 2.13);
  const pw = (w - 2 * t) / panels;
  for (let i = 0; i < panels; i++) {
    const u0 = -w / 2 + t + i * pw;
    l.box('door_paint', u0 + 0.004, dep - 0.04, 0.01, u0 + pw - 0.004, dep - 0.005, 2.08);
    // a knob where the doors meet (bifold pairs fold to the sides), or on a single door's latch edge
    const knob =
      panels === 1 ? u0 + pw - 0.07 : i === panels / 2 - 1 ? u0 + pw - 0.05 : i === panels / 2 ? u0 + 0.05 : 0;
    if (knob) l.box('up_closet_dark', knob - 0.015, dep - 0.005, 1.0, knob + 0.015, dep + 0.025, 1.03);
  }
}

/** curtains: two panels either side of a window and a rod (absolute boxes, z above the storey's floor), for item() */
export function curtains(
  along: 'x' | 'y',
  face: number,
  inward: 1 | -1,
  a: number,
  b: number,
  fabric: string,
): [string, number[]][] {
  const out: [string, number[]][] = [];
  const box = (s0: number, s1: number, d0: number, d1: number, z0: number, z1: number, mat: string) => {
    const c0 = face + inward * d0,
      c1 = face + inward * d1;
    const [p0, p1] = [Math.min(c0, c1), Math.max(c0, c1)];
    out.push([mat, along === 'x' ? [s0, p0, z0, s1, p1, z1] : [p0, s0, z0, p1, s1, z1]]);
  };
  box(a - 0.28, a + 0.08, 0.04, 0.1, 0.03, 2.33, fabric);
  box(b - 0.08, b + 0.28, 0.04, 0.1, 0.03, 2.33, fabric);
  box(a - 0.36, b + 0.36, 0.06, 0.085, 2.33, 2.355, 'black_steel');
  return out;
}

/** a blind in a window's reveal, part lowered (absolute boxes for item(); the reveal is the wall's inner 0.09 m) */
export function blind(
  along: 'x' | 'y',
  face: number,
  outward: 1 | -1,
  a: number,
  b: number,
  head: number,
  drop: number,
): [string, number[]][] {
  const out: [string, number[]][] = [];
  const box = (s0: number, s1: number, d0: number, d1: number, z0: number, z1: number, mat: string) => {
    const c0 = face + outward * d0,
      c1 = face + outward * d1;
    const [p0, p1] = [Math.min(c0, c1), Math.max(c0, c1)];
    out.push([mat, along === 'x' ? [s0, p0, z0, s1, p1, z1] : [p0, s0, z0, p1, s1, z1]]);
  };
  box(a + 0.01, b - 0.01, 0.015, 0.06, head - 0.06, head - 0.005, 'up_blind_white');
  box(a + 0.02, b - 0.02, 0.03, 0.04, head - drop, head - 0.06, 'up_blind_white');
  box(a + 0.02, b - 0.02, 0.025, 0.045, head - drop - 0.03, head - drop, 'up_blind_white');
  return out;
}

// ------------------------------------------------------------------ fixture shapes (about the mounting point)
/** a hugger ceiling fan with a light kit: canopy and motor, five blades, a glass bowl under the motor */
export function ceilingFan(): Shape {
  const s = new Shape();
  s.on('up_fan_nickel').lathe(
    0,
    0,
    [
      [-0.19, 0.09],
      [-0.16, 0.15],
      [-0.09, 0.15],
      [-0.05, 0.08],
      [0, 0.07],
    ],
    10,
  );
  for (let i = 0; i < 5; i++) {
    const a = (i * 2 * Math.PI) / 5 + 0.3;
    const c = Math.cos(a),
      sn = Math.sin(a);
    const p = (r: number, t: number, z: number): V3 => [r * c - t * sn, r * sn + t * c, z];
    // a blade from the motor's rim, wider at the tip
    s.on('up_fan_blade').prism(
      [
        p(0.13, -0.04, -0.162),
        p(0.64, -0.07, -0.162),
        p(0.66, 0, -0.162),
        p(0.64, 0.07, -0.162),
        p(0.13, 0.04, -0.162),
      ],
      [0, 0, 0.012],
    );
  }
  s.on('globe').lathe(
    0,
    0,
    [
      [-0.29, 0],
      [-0.28, 0.06],
      [-0.25, 0.11],
      [-0.19, 0.12],
    ],
    10,
  );
  return s;
}

/** a table lamp (its base on the table top): ceramic base, a fabric drum shade, the bulb */
export function tableLamp(): Shape {
  const s = new Shape();
  s.on('up_lamp_ceramic').lathe(
    0,
    0,
    [
      [0, 0.06],
      [0.02, 0.075],
      [0.14, 0.09],
      [0.24, 0.05],
      [0.27, 0.015],
    ],
    8,
  );
  s.on('black_steel').box(-0.008, -0.008, 0.27, 0.008, 0.008, 0.4);
  s.on('lamp_shade').lathe(
    0,
    0,
    [
      [0.3, 0.16],
      [0.5, 0.13],
    ],
    10,
  );
  s.on('bulb').lathe(0, 0, [
    [0.33, 0],
    [0.35, 0.03],
    [0.4, 0.03],
    [0.42, 0],
  ]);
  return s;
}

/** a three-globe vanity light on a wall, facing -Y before the node's yaw */
export function vanityGlobes(): Shape {
  const s = new Shape();
  s.on('black_steel').box(-0.34, -0.025, -0.035, 0.34, 0, 0.035);
  for (const u of [-0.24, 0, 0.24]) {
    s.on('black_steel').box(u - 0.012, -0.11, 0.01, u + 0.012, -0.025, 0.03);
    s.on('globe').lathe(
      u,
      -0.12,
      [
        [-0.13, 0],
        [-0.1, 0.06],
        [-0.03, 0.055],
        [0.01, 0.025],
      ],
      8,
    );
  }
  return s;
}

// ------------------------------------------------------------------ ceiling equipment (about the point on the ceiling)
export function exhaustFan(l: Local) {
  l.box('plate_white', -0.15, -0.15, -0.015, 0.15, 0.15, 0);
  for (let i = -2; i <= 2; i++) l.box('fixture_metal', -0.12, i * 0.05 - 0.008, -0.017, 0.12, i * 0.05 + 0.008, -0.015);
}
export function smokeAlarm(l: Local) {
  l.lathe(
    'plate_white',
    0,
    0,
    [
      [-0.045, 0.06],
      [-0.035, 0.07],
      [0, 0.07],
    ],
    10,
  );
}
export function coAlarm(l: Local) {
  l.box('plate_white', -0.065, -0.065, -0.04, 0.065, 0.065, 0);
  for (let i = -1; i <= 1; i++) l.box('plate_white', -0.04, i * 0.018 - 0.004, -0.046, 0.04, i * 0.018 + 0.004, -0.04);
}
export function atticHatch(l: Local, w: number, d: number) {
  const t = 0.05;
  l.box('window_frame', -w / 2 - t, -d / 2 - t, -0.006, w / 2 + t, d / 2 + t, 0); // the casing
  l.box('window_frame', -w / 2, -d / 2, -0.014, w / 2, d / 2, -0.006); // the panel, a step down
  l.box('black_steel', -0.015, d / 2 - 0.09, -0.3, 0.015, d / 2 - 0.06, -0.014); // the pull cord
}
