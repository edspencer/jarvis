import { toGltf, type V3 } from './geometry.ts';
import { CEIL1, D, EAVE, EXT, G, INT, SLAB, STAIR_Y0, STAIR_Y1, UP, W, WING } from './dims.ts';

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
  /** the finished floor's level, if not the storey's (the garage wing is a step down) */
  z?: number;
}
// docs/demo-house.md#the-layout
export const ROOMS: Room[] = [
  // ground floor
  { id: 'living_room', name: 'Living room', storey: 0, rects: [[0, 0, 7, 5]], floor: 'floor_oak' },
  { id: 'kitchen', name: 'Kitchen', storey: 0, rects: [[0, 5, 7, 9]], floor: 'floor_tile' },
  {
    id: 'hall',
    name: 'Hall',
    storey: 0,
    // the foyer, the nook to the powder room and the study, and the stair (x 10.66-12, y 3-7.6) with the air-handler
    // closet under the landing
    rects: [
      [7, 0, 12, 4],
      [8.7, 4, 12, 5.6],
      [10.6, 5.6, 12, 9],
    ],
    floor: 'floor_tile',
    // none over the stair, nor under the landing (the first floor's slab is there)
    ceil: [
      [7, 0, 12, STAIR_Y0],
      [7, STAIR_Y0, 10.6, 4],
      [8.7, 4, 10.6, 5.6],
    ],
  },
  { id: 'powder_room', name: 'Powder room', storey: 0, rects: [[7, 4, 8.7, 5.6]], floor: 'floor_tile' },
  { id: 'study', name: 'Study', storey: 0, rects: [[7, 5.6, 10.6, 9]], floor: 'floor_oak' },
  {
    id: 'garage',
    name: 'Garage',
    storey: 0,
    rects: [
      [WING.x0, 0, WING.x1, 6.6],
      [15.4, 6.6, WING.x1, D],
    ],
    floor: 'concrete',
    z: WING.z,
  },
  { id: 'laundry', name: 'Laundry', storey: 0, rects: [[WING.x0, 6.6, 15.4, D]], floor: 'floor_tile', z: WING.z },
  // first floor
  { id: 'bedroom_1', name: 'Primary bedroom', storey: 1, rects: [[0, 0, 7, 4]], floor: 'carpet' },
  { id: 'primary_closet', name: 'Walk-in closet', storey: 1, rects: [[0, 4, 2.5, 5.2]], floor: 'carpet' },
  { id: 'primary_bath', name: 'Primary bath', storey: 1, rects: [[7, 0, 12, 3]], floor: 'floor_tile' },
  { id: 'bedroom_2', name: 'Bedroom 2', storey: 1, rects: [[0, 5.2, 3.5, 9]], floor: 'carpet' },
  { id: 'bedroom_3', name: 'Bedroom 3', storey: 1, rects: [[3.5, 5.2, 7, 9]], floor: 'carpet' },
  { id: 'hall_bath', name: 'Hall bath', storey: 1, rects: [[7, 5.6, 9.4, 9]], floor: 'floor_tile' },
  {
    id: 'landing',
    name: 'Landing',
    storey: 1,
    // the corridor west to the bedrooms, and round the stairwell (x 10.6-12, y 3.0-7.6)
    rects: [
      [2.5, 4, 7, 5.2],
      [7, 3, 10.6, 5.6],
      [9.4, 5.6, 10.6, 9],
      [10.6, STAIR_Y1, 12, 9],
    ],
    floor: 'carpet',
    ceil: [
      [2.5, 4, 7, 5.2],
      [7, 3, 12, 5.6],
      [9.4, 5.6, 12, 9],
    ],
  },
];
export const room = (id: string): Room => {
  const r = ROOMS.find((x) => x.id === id);
  if (!r) throw new Error(`no room ${id}`);
  return r;
};
/** a room's floor level */
export const floorZ = (r: Room): number => r.z ?? (r.storey ? UP : 0);
export const roomCentre = (r: Room): V3 => {
  const [x0, y0, x1, y1] = r.rects[0];
  return [(x0 + x1) / 2, (y0 + y1) / 2, floorZ(r)];
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
  /** a sectional (garage) door: the leaf is drawn as this many horizontal panels */
  panels?: number;
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

/** the garage wing's walls: from its slab to its eaves (openings' sill and head above the slab) */
export const wingExt = (name: string, side: 'S' | 'N' | 'E', openings: Opening[]): Wall => {
  const ew = side !== 'E';
  const [c0, c1] = side === 'S' ? [-EXT, 0] : side === 'N' ? [D, D + EXT] : [WING.x1, WING.x1 + EXT];
  return {
    name,
    storey: 0,
    dir: ew ? 'x' : 'y',
    c0,
    c1,
    from: ew ? WING.x0 : 0,
    to: ew ? WING.x1 + EXT : D,
    z0: G.lawn, // down to the lawn outside (the slab is above it)
    z1: WING.eave,
    material: 'render_white',
    openings: openings.map((o) => ({ ...o, sill: o.sill + WING.z, head: o.head + WING.z })),
    exterior: true,
  };
};
const wingInt = (name: string, dir: 'x' | 'y', c: number, from: number, to: number, openings: Opening[] = []) => {
  const w = int(name, 0, dir, c, from, to, openings, 'plaster', WING.eave - 0.15);
  return {
    ...w,
    z0: WING.z,
    openings: w.openings.map((o) => ({ ...o, sill: o.sill + WING.z, head: o.head + WING.z })),
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
  // now the hall / garage wall: down to the garage's slab (and the lawn under it), with the door to the garage
  // (self-closing, painted) and a step down under it
  { ...ext('East wall (ground)', 0, 'E', [door('garage_hall', 1.5, 2.4, 'door_paint')]), z0: G.lawn },
  int('Living / hall wall', 0, 'y', 7, 0, 5, [open(2.6, 3.8)]),
  int('Kitchen / study wall', 0, 'y', 7, 5, 9),
  int('Living / kitchen wall', 0, 'x', 5, 0, 6.94, [open(2.4, 4.4)]),
  int('Hall / powder room wall', 0, 'x', 4, 7.06, 8.76),
  int('Powder room / hall nook wall', 0, 'y', 8.7, 4.06, 5.54, [door('powder_room', 4.4, 5.15)]),
  int('Study south wall', 0, 'x', 5.6, 7.06, 10.66, [door('study', 9.5, 10.35)]),
  int('Study / stair wall', 0, 'y', 10.6, 5.66, 9),
  // the garage wing
  wingExt('South wall (garage)', 'S', [{ ...door('garage', 13.05, 17.95, 'garage_door'), head: 2.2, panels: 4 }]),
  wingExt('North wall (garage)', 'N', [
    door('laundry_back', 12.9, 13.8, 'entry_door'),
    win('laundry_n', 14.3, 15.1, 1.1),
    win('garage_n', 16.4, 17.6, 1.2),
  ]),
  wingExt('East wall (garage)', 'E', [win('garage_e', 3.4, 4.6, 1.2)]),
  wingInt('Laundry / garage wall', 'x', 6.6, WING.x0, 15.46, [door('laundry', 14.4, 15.2)]),
  wingInt('Laundry / garage wall (east)', 'y', 15.4, 6.66, D),
  // first floor
  ext('South wall (first)', 1, 'S', [
    win('bed1_s1', 1.2, 3.0),
    win('bed1_s2', 4.0, 5.8),
    win('bath_s', 10.7, 11.7, 1.4, 2.2), // clear of the vanity light
  ]),
  ext('North wall (first)', 1, 'N', [
    win('bed2_n', 0.9, 2.4),
    win('bed3_n', 4.6, 6.1),
    win('hall_bath_n', 7.8, 8.8, 1.5, 2.2),
    win('landing_n', 10.0, 11.4),
  ]),
  ext('West wall (first)', 1, 'W', [win('bed1_w', 1.8, 3.4), win('bed2_w', 6.0, 7.4)]),
  // above the garage roof (which meets this wall at most 4.4 m up, at y 4.5)
  ext('East wall (first)', 1, 'E', [win('landing_e', 7.8, 8.8)]),
  int('Primary bedroom / bath wall', 1, 'y', 7, 0, 4, [door('primary_bath', 1.7, 2.5)]),
  int('Bedroom 3 / hall bath wall', 1, 'y', 7, 5.14, 9),
  int('Primary bedroom / corridor wall', 1, 'x', 4, 0, 6.94, [
    door('primary_closet', 0.8, 1.6),
    door('bedroom_1', 4.6, 5.5),
  ]),
  int('Corridor / bedrooms wall', 1, 'x', 5.2, 0, 6.94, [door('bedroom_2', 2.62, 3.4), door('bedroom_3', 3.8, 4.6)]),
  int('Closet / corridor wall', 1, 'y', 2.5, 4.06, 5.14),
  int('Bedroom 2 / 3 wall', 1, 'y', 3.5, 5.26, 9),
  int('Primary bath / landing wall', 1, 'x', 3, 7.06, 12, [], 'plaster_bath'),
  int('Hall bath / landing wall', 1, 'x', 5.6, 7.06, 9.46, [door('hall_bath', 7.9, 8.7)], 'plaster_bath'),
  int('Hall bath / landing wall (east)', 1, 'y', 9.4, 5.66, 9, [], 'plaster_bath'),
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
