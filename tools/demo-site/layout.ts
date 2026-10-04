import { toGltf, type V3 } from './geometry.ts';
import { CEIL1, D, EAVE, EXT, INT, SLAB, STAIR_Y0, STAIR_Y1, UP, W } from './dims.ts';

// ------------------------------------------------------------------ rooms
export interface Room {
  id: string;
  name: string;
  storey: 0 | 1;
  /** floor rectangles [x0, y0, x1, y1] */
  rects: number[][];
  floor: string;
  /** ceiling rectangles, if not the floor's */
  ceil?: number[][];
}
export const ROOMS: Room[] = [
  { id: 'living_room', name: 'Living room', storey: 0, rects: [[0, 0, 7, 5]], floor: 'floor_oak' },
  { id: 'kitchen', name: 'Kitchen', storey: 0, rects: [[0, 5, 7, 9]], floor: 'floor_tile' },
  {
    id: 'hall',
    name: 'Hall',
    storey: 0,
    rects: [
      [7, 0, 12, 4],
      [10.6, 4, 12, 9],
    ],
    floor: 'floor_tile',
    ceil: [
      [7, 0, 12, STAIR_Y0],
      [7, STAIR_Y0, 10.6, 4],
    ],
  },
  { id: 'study', name: 'Study', storey: 0, rects: [[7, 4, 10.6, 9]], floor: 'floor_oak' },
  { id: 'bedroom_1', name: 'Bedroom 1', storey: 1, rects: [[0, 0, 7, 5]], floor: 'carpet' },
  { id: 'bedroom_2', name: 'Bedroom 2', storey: 1, rects: [[0, 5, 7, 9]], floor: 'carpet' },
  { id: 'bathroom', name: 'Bathroom', storey: 1, rects: [[7, 0, 12, 3]], floor: 'floor_tile' },
  {
    id: 'landing',
    name: 'Landing',
    storey: 1,
    // around the stairwell (x 10.6-12, y 3.0-7.6)
    rects: [
      [7, 3, 10.6, 9],
      [10.6, STAIR_Y1, 12, 9],
    ],
    floor: 'carpet',
    ceil: [[7, 3, 12, 9]],
  },
];
export const roomCentre = (r: Room): V3 => {
  const [x0, y0, x1, y1] = r.rects[0];
  return [(x0 + x1) / 2, (y0 + y1) / 2, r.storey ? UP : 0];
};

/** plan point -> viewer (three.js) metres */
export const pos = (p: V3) => toGltf(p).map((v) => +v.toFixed(4)) as V3;
export const eye = (r: Room): V3 => {
  const [x, y, z] = roomCentre(r);
  return pos([x, y, z + 1.2]);
};

// ------------------------------------------------------------------ walls and openings
export interface Opening {
  /** along the wall, plan metres */
  a: number;
  b: number;
  sill: number;
  head: number;
  kind: 'window' | 'door' | 'glazed' | 'open';
  id?: string;
  material?: string;
}
export interface Wall {
  name: string;
  storey: 0 | 1;
  /** 'x': runs east-west at y in [c0, c1]; 'y': runs north-south at x in [c0, c1] */
  dir: 'x' | 'y';
  c0: number;
  c1: number;
  from: number;
  to: number;
  z0: number;
  z1: number;
  material: string;
  openings: Opening[];
  exterior?: boolean;
}
export const win = (id: string, a: number, b: number, sill = 0.9, head = 2.2): Opening => ({
  id,
  a,
  b,
  sill,
  head,
  kind: 'window',
});
export const door = (id: string, a: number, b: number, material = 'door_oak'): Opening => ({
  id,
  a,
  b,
  sill: 0,
  head: 2.1,
  kind: 'door',
  material,
});
export const open = (a: number, b: number, head = 2.3): Opening => ({ a, b, sill: 0, head, kind: 'open' });

export const ext = (name: string, storey: 0 | 1, side: 'S' | 'N' | 'W' | 'E', openings: Opening[]): Wall => {
  const z0 = storey ? UP : 0,
    z1 = storey ? EAVE : UP;
  const ew = side === 'S' || side === 'N';
  const [c0, c1] = side === 'S' ? [-EXT, 0] : side === 'N' ? [D, D + EXT] : side === 'W' ? [-EXT, 0] : [W, W + EXT];
  return {
    name,
    storey,
    dir: ew ? 'x' : 'y',
    c0,
    c1,
    from: ew ? -EXT : 0,
    to: ew ? W + EXT : D,
    z0,
    z1,
    material: 'render_white',
    openings: openings.map((o) => ({ ...o, sill: o.sill + z0, head: o.head + z0 })),
    exterior: true,
  };
};
export const int = (
  name: string,
  storey: 0 | 1,
  dir: 'x' | 'y',
  c: number,
  from: number,
  to: number,
  openings: Opening[] = [],
  material = 'plaster',
  z1?: number,
): Wall => {
  const z0 = storey ? UP : 0;
  return {
    name,
    storey,
    dir,
    c0: c - INT / 2,
    c1: c + INT / 2,
    from,
    to,
    z0,
    z1: z1 ?? (storey ? CEIL1 : SLAB),
    material,
    openings: openings.map((o) => ({ ...o, sill: o.sill + z0, head: o.head + z0 })),
  };
};

export const WALLS: Wall[] = [
  // ground floor
  ext('South wall (ground)', 0, 'S', [
    win('living_s1', 1.2, 3.0),
    win('living_s2', 4.0, 5.8),
    door('front', 9.0, 10.0, 'entry_door'),
    win('hall_s', 10.8, 11.6, 1.0),
  ]),
  ext('North wall (ground)', 0, 'N', [
    win('kitchen_n', 1.2, 3.2, 1.05),
    { ...win('patio', 4.4, 6.4, 0, 2.2), kind: 'glazed' },
    win('study_n', 8.0, 9.6),
  ]),
  ext('West wall (ground)', 0, 'W', [win('living_w', 1.8, 3.4), win('kitchen_w', 6.0, 7.4, 1.05)]),
  ext('East wall (ground)', 0, 'E', [win('stair_e', 5.0, 6.4, 1.4, 2.6)]),
  int('Living / hall wall', 0, 'y', 7, 0, 5, [open(2.6, 3.8)]),
  int('Kitchen / study wall', 0, 'y', 7, 5, 9),
  int('Living / kitchen wall', 0, 'x', 5, 0, 6.94, [open(2.4, 4.4)]),
  int('Hall / study wall', 0, 'x', 4, 7.06, 10.66, [door('study', 8.0, 8.9)]),
  int('Study / stair wall', 0, 'y', 10.6, 4, 9),
  // first floor
  ext('South wall (first)', 1, 'S', [
    win('bed1_s1', 1.2, 3.0),
    win('bed1_s2', 4.0, 5.8),
    win('bath_s', 9.2, 10.4, 1.4, 2.2),
  ]),
  ext('North wall (first)', 1, 'N', [win('bed2_n', 2.0, 4.0), win('landing_n', 8.0, 9.6)]),
  ext('West wall (first)', 1, 'W', [win('bed1_w', 1.8, 3.4), win('bed2_w', 6.0, 7.4)]),
  ext('East wall (first)', 1, 'E', [win('stairwell_e', 5.0, 6.4, 0.6, 1.8)]),
  int('Bedrooms / landing wall', 1, 'y', 7, 0, 9, [door('bed1', 3.7, 4.6), door('bed2', 6.6, 7.5)]),
  int('Bedroom 1 / 2 wall', 1, 'x', 5, 0, 6.94),
  int('Bathroom / landing wall', 1, 'x', 3, 7.06, 12, [door('bath', 7.6, 8.5)], 'plaster_bath'),
];

/** the boxes of a wall, around its openings */
export function wallBoxes(w: Wall): number[][] {
  const out: number[][] = [];
  const box = (a: number, b: number, z0: number, z1: number) => {
    if (b - a < 1e-3 || z1 - z0 < 1e-3) return;
    out.push(w.dir === 'x' ? [a, w.c0, z0, b, w.c1, z1] : [w.c0, a, z0, w.c1, b, z1]);
  };
  let at = w.from;
  for (const o of [...w.openings].sort((p, q) => p.a - q.a)) {
    box(at, o.a, w.z0, w.z1);
    box(o.a, o.b, w.z0, o.sill);
    box(o.a, o.b, o.head, w.z1);
    at = o.b;
  }
  box(at, w.to, w.z0, w.z1);
  return out;
}
