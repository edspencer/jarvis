// The kitchen and dining (kitchen): docs/demo-house.md#kitchen-and-dining-kitchen
//
// An L of base cabinets on the west and north walls (wall cabinets where there is no window), an island with three
// stools, and the dining table by the patio door. West wall, south to north: a French-door fridge (beside the opening
// from the living room), counter under the west window, an electric range with a chimney hood, the corner. North wall:
// drawers, the sink under the window with a dishwasher on its right, and a built-in microwave in the wall cabinet
// right of the window. Walkways: 1.1 m between the island and the counters, 1.2 m from the patio door to the table.
import { Shape, type V3 } from '../geometry.ts';
import { CEIL0, D } from '../dims.ts';
import { hex, type Model } from '../model.ts';
import { place, type Area, type Fixture, type Pin, type PlateSpec } from '../area.ts';
import {
  boxes,
  disc,
  legs,
  mergedParts,
  moved,
  sideChair,
  stool,
  type Box,
  type Dir,
  type Part,
} from './ground/kit.ts';

const R = 'kitchen';
const fx = (id: string, kind: string, group: string, at: V3): Fixture => ({
  id,
  kind,
  group,
  room: R,
  at,
  breaker: '7',
});
// three pendants over the island (their ids and entities are the demo's oldest: the tests and the assistant use them)
const pendants: Fixture[] = [2.05, 2.65, 3.25].map((x, i) =>
  fx(`kitchen.pendant.${i + 1}`, 'pendant', 'fixture.pendants.kitchen', [x, 6.84, CEIL0]),
);
// a chandelier over the dining table
const dining = fx('kitchen.chandelier', 'chandelier', 'fixture.dining', [5.4, 6.7, CEIL0]);
const cans: Fixture[] = [
  [1.1, 6.6],
  [1.1, 7.85],
  [2.65, 7.85],
  [3.95, 7.85],
].map(([x, y], i) => fx(`kitchen.can.${i + 1}`, 'can', 'fixture.cans.kitchen', [x, y, CEIL0]));
// LED strips under the wall cabinets either side of the window (the left one under the cabinet, the right one under
// the microwave)
const undercab: Fixture[] = [
  [0.74, 1.45],
  [3.73, 1.47],
].map(([x, z], i) => fx(`kitchen.undercab.${i + 1}`, 'undercab', 'fixture.undercab.kitchen', [x, D - 0.17, z]));

/** a four-arm chandelier: a canopy, a stem, a hub and four small shaded candles (its bottom 0.75 m down) */
function chandelierShape(): Shape {
  const s = boxes([
    ['fixture_metal', [-0.005, -0.005, -0.55, 0.005, 0.005, -0.02]],
    ['fixture_metal', [-0.32, -0.01, -0.62, 0.32, 0.01, -0.6]],
    ['fixture_metal', [-0.01, -0.32, -0.62, 0.01, 0.32, -0.6]],
  ]);
  s.on('fixture_metal').lathe(0, 0, [
    [-0.03, 0.07],
    [0, 0.07],
  ]);
  s.on('fixture_metal').lathe(0, 0, [
    [-0.66, 0.04],
    [-0.55, 0.05],
  ]);
  for (const [x, y] of [
    [0.3, 0],
    [-0.3, 0],
    [0, 0.3],
    [0, -0.3],
  ]) {
    s.on('lamp_shade').lathe(
      x,
      y,
      [
        [-0.56, 0.08],
        [-0.42, 0.055],
      ],
      8,
    );
  }
  return s;
}

/** an under-cabinet LED strip, 0.7 m, below its mounting point */
function undercabShape(): Shape {
  return boxes([
    ['fixture_metal', [-0.35, -0.02, -0.018, 0.35, 0.02, 0]],
    ['led_diffuser', [-0.34, -0.014, -0.022, 0.34, 0.014, -0.018]],
  ]);
}

const T = 0.01; // the backsplash tile's thickness: plates on the backsplash sit on its face
const plate = (
  id: string,
  kind: 'switch' | 'outlet',
  at: V3,
  normal: [number, number],
  positions: PlateSpec['positions'],
  notes?: string,
): PlateSpec => ({ id, room: R, kind, at, normal, positions, ...(notes ? { notes } : {}) });
const KT_S_A = plate(
  'KT-S-A',
  'switch',
  [4.6, 5.06, 1.2],
  [0, 1],
  [
    { pos: 1, role: 'island pendants', breaker: '7', fixture_ids: pendants.map((f) => f.id) },
    {
      pos: 2,
      role: 'kitchen cans',
      breaker: '7',
      fixture_ids: cans.map((f) => f.id),
      ha_entity: 'light.kitchen_cans',
    },
  ],
);
const plates: PlateSpec[] = [
  KT_S_A,
  plate(
    'KT-S-B',
    'switch',
    [6.65, D, 1.2],
    [0, -1],
    [
      {
        pos: 1,
        role: 'dining chandelier',
        breaker: '7',
        fixture_ids: [dining.id],
        ha_entity: 'light.kitchen_chandelier',
      },
    ],
  ),
  plate(
    'KT-S-C',
    'switch',
    [3.97, D - T, 1.15],
    [0, -1],
    [
      {
        pos: 1,
        role: 'under-cabinet lights',
        breaker: '7',
        fixture_ids: undercab.map((f) => f.id),
        ha_entity: 'light.kitchen_under_cabinet',
      },
    ],
  ),
  // counter outlets (GFCI): either side of the window, the corner by the range, the island's end
  plate('KT-O-A', 'outlet', [T, 8.62, 1.15], [1, 0], [{ pos: 1, role: 'counter (GFCI)', breaker: '9' }]),
  plate('KT-O-B', 'outlet', [0.95, D - T, 1.15], [0, -1], [{ pos: 1, role: 'counter (GFCI)', breaker: '9' }]),
  plate('KT-O-C', 'outlet', [3.45, D - T, 1.15], [0, -1], [{ pos: 1, role: 'counter (load side)', breaker: '9' }]),
  plate('KT-O-D', 'outlet', [3.5, 7.0, 0.6], [1, 0], [{ pos: 1, role: 'island (GFCI)', breaker: '9' }]),
  // the appliances' own circuits, behind or inside the cabinets
  plate('KT-O-E', 'outlet', [0, 5.55, 1.0], [1, 0], [{ pos: 1, role: 'refrigerator', breaker: '11' }]),
  plate('KT-O-F', 'outlet', [2.2, D, 0.35], [0, -1], [{ pos: 1, role: 'dishwasher and disposal', breaker: '13' }]),
  plate('KT-O-G', 'outlet', [3.73, D, 2.0], [0, -1], [{ pos: 1, role: 'microwave', breaker: '15' }]),
  plate(
    'KT-O-H',
    'outlet',
    [0, 7.83, 0.2],
    [1, 0],
    [{ pos: 1, role: 'range (240 V receptacle)', breaker: '1+3' }],
    'A 50 A range receptacle behind the range.',
  ),
];

const pin = (id: string, name: string, at: V3, breaker: string, model: string, specs: [string, string][]): Pin => ({
  id,
  name,
  category: 'appliance',
  room: R,
  at,
  make: 'Example Appliances',
  model,
  specs,
  breaker,
});

// ------------------------------------------------------------------ cabinets
/** a run of cabinets in its own frame (u along the run, v out from the wall, or the island's back; z up), and the
 * plan direction its fronts face */
type Frame = ((u0: number, u1: number, v0: number, v1: number, z0: number, z1: number) => number[]) & { out: Dir };
const frame = (f: (u0: number, u1: number, v0: number, v1: number, z0: number, z1: number) => number[], out: Dir) =>
  Object.assign(f, { out });
const northWall: Frame = frame((u0, u1, v0, v1, z0, z1) => [u0, D - v1, z0, u1, D - v0, z1], 'y-');
const westWall: Frame = frame((u0, u1, v0, v1, z0, z1) => [v0, u0, z0, v1, u1, z1], 'x+');
const islandFrame: Frame = frame((u0, u1, v0, v1, z0, z1) => [u0, 6.72 + v0, z0, u1, 6.72 + v1, z1], 'y+');

type Front = 'drawers' | 'door' | 'sink' | 'blank';
/** base cabinets (0.6 deep, the counter's underside at 0.88): a carcass, a toe kick and fronts with handles */
function baseRun(f: Frame, segs: [number, number, Front][], carcass = 'cabinet_carcass', front = 'cabinet'): Box[] {
  const out: Box[] = [];
  for (const [u0, u1, kind] of segs) {
    out.push([carcass, f(u0, u1, 0, 0.58, 0.1, kind === 'sink' ? 0.68 : 0.88)]);
    if (kind === 'sink') out.push([carcass, f(u0, u1, 0.5, 0.58, 0.68, 0.88)]);
    out.push(['black_steel', f(u0, u1, 0, 0.53, 0, 0.1), f.out]);
    const g = 0.005;
    const handleH = (a: number, b: number, z: number) => {
      const c = (a + b) / 2;
      out.push(['black_steel', f(c - 0.08, c + 0.08, 0.6, 0.605, z - 0.012, z + 0.012), f.out]);
    };
    if (kind === 'drawers') {
      for (const [z0, z1] of [
        [0.12, 0.4],
        [0.41, 0.66],
        [0.67, 0.86],
      ]) {
        out.push([front, f(u0 + g, u1 - g, 0.58, 0.6, z0, z1), f.out]);
        handleH(u0, u1, z1 - 0.06);
      }
    } else if (kind === 'blank') {
      out.push([front, f(u0 + g, u1 - g, 0.58, 0.6, 0.12, 0.86), f.out]);
    } else {
      // a drawer (or the sink's false front) over a pair of doors (one door if narrow)
      out.push([front, f(u0 + g, u1 - g, 0.58, 0.6, 0.67, 0.86), f.out]);
      if (kind !== 'sink') handleH(u0, u1, 0.8);
      const two = u1 - u0 > 0.65;
      const cuts = two ? [u0, (u0 + u1) / 2, u1] : [u0, u1];
      for (let i = 0; i < cuts.length - 1; i++) {
        const a = cuts[i] + g,
          b = cuts[i + 1] - g;
        out.push([front, f(a, b, 0.58, 0.6, 0.12, 0.66), f.out]);
        const hu = i === 0 && two ? b - 0.05 : a + 0.05;
        out.push(['black_steel', f(hu - 0.012, hu + 0.012, 0.6, 0.605, 0.48, 0.62), f.out]);
      }
    }
  }
  return out;
}
/** wall cabinets (0.33 deep) from z0 to z1: carcass, doors (two if wide) and handles at the doors' bottom corners */
function wallRun(f: Frame, u0: number, u1: number, z0 = 1.45, z1 = 2.2): Box[] {
  const out: Box[] = [['cabinet_carcass', f(u0, u1, 0, 0.31, z0, z1)]];
  const n = Math.max(1, Math.round((u1 - u0) / 0.45));
  const w = (u1 - u0) / n;
  for (let i = 0; i < n; i++) {
    const a = u0 + i * w + 0.005,
      b = a + w - 0.01;
    out.push(['cabinet', f(a, b, 0.31, 0.33, z0 + 0.01, z1 - 0.01), f.out]);
    const hu = i % 2 ? a + 0.05 : b - 0.05;
    out.push(['black_steel', f(hu - 0.012, hu + 0.012, 0.33, 0.335, z0 + 0.05, z0 + 0.18), f.out]);
  }
  return out;
}

const SINK = { x0: 1.8, x1: 2.6, y0: 8.45, y1: 8.9 }; // the counter's cut-out

function units(m: Model): void {
  const counter = (b: number[]): Box => ['worktop', b];
  const pieces: Part[] = [];
  const piece = (name: string, list: Box[]) => pieces.push({ name, boxes: list });
  piece(
    'Base cabinets, west',
    baseRun(westWall, [
      [6.02, 6.74, 'door'],
      [6.74, 7.45, 'drawers'],
      [8.21, 9.0, 'blank'],
    ]),
  );
  piece(
    'Base cabinets, north',
    baseRun(northWall, [
      [0.6, 1.2, 'drawers'],
      [1.2, 1.75, 'door'],
      [1.75, 2.65, 'sink'],
      [3.25, 3.75, 'drawers'],
      [3.75, 4.2, 'door'],
    ]),
  );
  piece('Island', [
    ...baseRun(
      islandFrame,
      [
        [1.8, 2.4, 'drawers'],
        [2.4, 3.0, 'door'],
        [3.0, 3.5, 'drawers'],
      ],
      'cabinet_navy',
      'cabinet_navy',
    ),
    // its back (the stools' side) and ends: panels
    ['cabinet_navy', [1.8, 6.7, 0, 3.5, 6.72, 0.88]],
  ]);
  piece('Worktops', [
    counter([0, 6.0, 0.88, 0.63, 7.45, 0.92]),
    counter([0, 8.21, 0.88, 0.63, D, 0.92]),
    // the north run, round the sink's cut-out
    counter([0.63, 8.37, 0.88, SINK.x0, D, 0.92]),
    counter([SINK.x1, 8.37, 0.88, 4.2, D, 0.92]),
    counter([SINK.x0, 8.37, 0.88, SINK.x1, SINK.y0, 0.92]),
    counter([SINK.x0, SINK.y1, 0.88, SINK.x1, D, 0.92]),
    counter([1.75, 6.35, 0.88, 3.55, 7.33, 0.92]),
  ]);
  piece('Wall cabinets', [
    ...wallRun(northWall, 0.33, 1.15),
    ...wallRun(westWall, 8.21, D),
    // over the fridge
    ...wallRun(westWall, 5.1, 6.0, 1.85, 2.2),
    // right of the window: the microwave's housing
    ...wallRun(northWall, 3.25, 4.2, 1.9, 2.2),
    ['cabinet_carcass', northWall(3.25, 3.36, 0, 0.33, 1.45, 1.9)],
    ['cabinet_carcass', northWall(4.1, 4.2, 0, 0.33, 1.45, 1.9)],
  ]);
  piece('Backsplash', [
    // under the windows to their sills; up to the wall cabinets elsewhere; behind the range to the hood
    ['backsplash', [0, D - T, 0.92, 1.2, D, 1.45]],
    ['backsplash', [1.2, D - T, 0.92, 3.2, D, 1.05]],
    ['backsplash', [3.2, D - T, 0.92, 4.2, D, 1.45]],
    ['backsplash', [0, 6.0, 0.92, T, 7.4, 1.05]],
    ['backsplash', [0, 7.4, 0.92, T, 8.21, 1.62]],
    ['backsplash', [0, 8.21, 0.92, T, D - T, 1.45]],
  ]);
  mergedParts(m, 'Kitchen_units', 'kitchen_units', pieces, { room: R });
}

// ------------------------------------------------------------------ appliances (each its own node: a circuit feeds it)
function fridge(): Shape {
  // French doors over a freezer drawer, facing east; x 0.05-0.8, y 5.1-6.0
  return boxes([
    ['kitchen_steel', [0.05, 5.1, 0.04, 0.74, 6.0, 1.78]],
    ['black_steel', [0.06, 5.11, 0, 0.75, 5.99, 0.04], 'x+'],
    ['kitchen_steel', [0.74, 5.105, 0.04, 0.78, 5.995, 0.735]],
    ['kitchen_steel', [0.74, 5.105, 0.765, 0.78, 5.545, 1.775]],
    ['kitchen_steel', [0.74, 5.555, 0.765, 0.78, 5.995, 1.775]],
    // the seams
    ['black_steel', [0.73, 5.1, 0.735, 0.775, 6.0, 0.765], 'x+'],
    ['black_steel', [0.73, 5.545, 0.765, 0.775, 5.555, 1.775], 'x+'],
    // handles: two bars by the doors' meeting edge, one on the drawer
    ['kitchen_chrome', [0.8, 5.51, 0.95, 0.82, 5.525, 1.6]],
    ['kitchen_chrome', [0.8, 5.575, 0.95, 0.82, 5.59, 1.6]],
    ['kitchen_chrome', [0.78, 5.51, 0.97, 0.8, 5.525, 0.99]],
    ['kitchen_chrome', [0.78, 5.51, 1.56, 0.8, 5.525, 1.58]],
    ['kitchen_chrome', [0.78, 5.575, 0.97, 0.8, 5.59, 0.99]],
    ['kitchen_chrome', [0.78, 5.575, 1.56, 0.8, 5.59, 1.58]],
    ['kitchen_chrome', [0.8, 5.25, 0.62, 0.82, 5.85, 0.645]],
    ['kitchen_chrome', [0.78, 5.27, 0.62, 0.8, 5.29, 0.645]],
    ['kitchen_chrome', [0.78, 5.81, 0.62, 0.8, 5.83, 0.645]],
    // the water and ice dispenser on the left door
    ['black_steel', [0.78, 5.28, 1.12, 0.785, 5.44, 1.38], 'x+'],
  ]);
}
function range(): Shape {
  // a freestanding electric range facing east: x 0.02-0.66, y 7.46-8.2
  const s = boxes([
    ['kitchen_steel', [0.02, 7.46, 0, 0.64, 8.2, 0.9]],
    ['tv_screen', [0.03, 7.47, 0.9, 0.65, 8.19, 0.92]],
    ['kitchen_steel', [0.02, 7.46, 0.92, 0.1, 8.2, 1.08]],
    ['black_steel', [0.1, 7.72, 0.98, 0.102, 7.94, 1.03], 'x+'],
    ['kitchen_steel', [0.64, 7.48, 0.15, 0.67, 8.18, 0.8]],
    ['black_steel', [0.67, 7.6, 0.3, 0.672, 8.06, 0.64], 'x+'],
    ['kitchen_chrome', [0.69, 7.55, 0.72, 0.71, 8.11, 0.745]],
    ['kitchen_chrome', [0.67, 7.57, 0.72, 0.69, 7.59, 0.745]],
    ['kitchen_chrome', [0.67, 8.07, 0.72, 0.69, 8.09, 0.745]],
    ['black_steel', [0.64, 7.48, 0.02, 0.665, 8.18, 0.13], 'x+'],
  ]);
  // four radiant elements, two large and two small
  for (const [x, y, r] of [
    [0.24, 7.66, 0.1],
    [0.24, 8.0, 0.08],
    [0.5, 7.66, 0.08],
    [0.5, 8.0, 0.1],
  ])
    disc(s, 'black_steel', x, y, 0.9215, r, 12);
  // knobs on the backguard's front
  for (const y of [7.55, 7.63, 8.03, 8.11])
    boxes([['black_steel', [0.1, y - 0.02, 0.98, 0.125, y + 0.02, 1.02], 'x+y-y+z+']], s);
  return s;
}
function hood(): Shape {
  // a chimney hood over the range, to the ceiling
  return boxes([
    ['kitchen_steel', [0, 7.45, 1.64, 0.5, 8.21, 1.7]],
    ['kitchen_steel', [0, 7.52, 1.7, 0.4, 8.14, 1.78]],
    ['kitchen_steel', [0, 7.68, 1.78, 0.26, 7.98, CEIL0]],
    ['black_steel', [0.04, 7.5, 1.635, 0.46, 8.16, 1.64], 'z-'],
  ]);
}
function dishwasher(): Shape {
  return boxes([
    ['kitchen_steel', [2.655, 8.38, 0.1, 3.245, 8.42, 0.86]],
    ['black_steel', [2.655, 8.375, 0.79, 3.245, 8.38, 0.85], 'y-'],
    ['kitchen_chrome', [2.75, 8.35, 0.74, 3.15, 8.37, 0.765]],
    ['kitchen_chrome', [2.77, 8.37, 0.74, 2.79, 8.38, 0.765]],
    ['kitchen_chrome', [3.11, 8.37, 0.74, 3.13, 8.38, 0.765]],
    ['black_steel', [2.66, 8.45, 0, 3.24, D, 0.1], 'y-'],
  ]);
}
function microwave(): Shape {
  return boxes([
    ['kitchen_steel', [3.36, 8.64, 1.47, 4.1, D, 1.87]],
    ['black_steel', [3.4, 8.635, 1.51, 3.84, 8.64, 1.83], 'y-'],
    ['black_steel', [3.88, 8.635, 1.51, 4.06, 8.64, 1.83], 'y-'],
    ['kitchen_chrome', [3.85, 8.61, 1.55, 3.865, 8.635, 1.79]],
  ]);
}
function sink(): Shape {
  const { x0, x1, y0, y1 } = SINK;
  const s = boxes([
    // a double bowl, its rim flush with the cut-out
    ['kitchen_steel', [x0, y0, 0.7, x1, y1, 0.71], 'z+'],
    ['kitchen_steel', [x0, y0, 0.71, x1, y0 + 0.01, 0.92], 'y+'],
    ['kitchen_steel', [x0, y1 - 0.01, 0.71, x1, y1, 0.92], 'y-'],
    ['kitchen_steel', [x0, y0, 0.71, x0 + 0.01, y1, 0.92], 'x+'],
    ['kitchen_steel', [x1 - 0.01, y0, 0.71, x1, y1, 0.92], 'x-'],
    ['kitchen_steel', [2.19, y0, 0.71, 2.21, y1, 0.9]],
    // a gooseneck faucet behind the bowls, and its lever
    ['kitchen_chrome', [2.18, 8.92, 1.2, 2.22, 8.96, 1.24]],
    ['kitchen_chrome', [2.185, 8.73, 1.2, 2.215, 8.92, 1.235]],
    ['kitchen_chrome', [2.185, 8.73, 1.1, 2.215, 8.76, 1.2]],
    ['kitchen_chrome', [2.25, 8.92, 0.98, 2.27, 8.96, 1.06]],
  ]);
  s.on('kitchen_chrome').lathe(2.2, 8.94, [
    [0.92, 0.03],
    [1.24, 0.02],
  ]);
  return s;
}

export const kitchen: Area = {
  id: 'kitchen',
  materials: {
    cabinet_carcass: { c: hex('#cfc9bd'), rough: 0.6 },
    cabinet_navy: { c: hex('#2f4560'), rough: 0.5 },
    backsplash: { c: hex('#dfe7e6'), rough: 0.25 },
    kitchen_steel: { c: hex('#b9bcbf'), rough: 0.3, metal: 0.7 },
    kitchen_chrome: { c: hex('#d9dcdf'), rough: 0.15, metal: 0.9 },
  },
  fixtureShapes: { undercab: undercabShape, chandelier: chandelierShape },
  fixtures: [...pendants, dining, ...cans, ...undercab],
  plates,
  pins: [
    {
      ...pin('appliance.fridge', 'Fridge-freezer', [0.82, 5.55, 1.2], '11', 'FF-70', [
        ['type', 'French door, bottom freezer, 36 in'],
        ['capacity', '25 cu ft'],
      ]),
      note: 'Plugged in behind it (KT-O-E).',
    },
    pin('appliance.range', 'Range', [0.7, 7.83, 0.95], '1+3', 'ER-30', [
      ['type', 'electric, smooth top, 30 in'],
      ['supply', '240 V, 40 A'],
    ]),
    pin('appliance.dishwasher', 'Dishwasher', [2.95, 8.34, 0.5], '13', 'DW-24', [['width', '24 in']]),
    {
      id: 'fixture.kitchen-pendants',
      name: 'Kitchen pendants',
      category: 'fixture',
      room: R,
      at: [2.65, 6.84, CEIL0 - 0.7],
      fixtures: pendants.map((f) => f.id),
      ha: pendants.map((_, i) => `light.kitchen_pendant_${i + 1}`),
      breaker: '7',
    },
  ],
  devices: [
    ...pendants.map((f, k) => {
      const i = k + 1;
      return {
        id: `demo-kitchen-pendant-${i}`,
        name: `Kitchen pendant ${i}`,
        integration: 'hue',
        make: 'Example Lighting',
        model: 'A19 bulb',
        area: 'Kitchen',
        place: place('fixture', f.id, R, f.at),
        fixtures: [f.id],
        unavailable_means: {
          off: `the kitchen pendants wall switch (${KT_S_A.id})`,
          unless_on: [1, 2, 3].filter((j) => j !== i).map((j) => `light.kitchen_pendant_${j}`),
        },
        health: { avail: [`light.kitchen_pendant_${i}`], update: [`update.kitchen_pendant_${i}_firmware`] },
      };
    }),
    {
      id: 'demo-leak-sensor',
      name: 'Leak sensor (kitchen sink)',
      integration: 'zha',
      make: 'Example Sensors',
      model: 'WL-1',
      area: 'Kitchen',
      place: place('area', R, R, [2.2, 8.7, 0.1]),
      health: { avail: ['binary_sensor.kitchen_leak'], battery: ['sensor.kitchen_leak_battery'] },
    },
  ],
  haMap: {
    ...Object.fromEntries(
      pendants.map((f, i) => [
        f.id,
        { entity_id: `light.kitchen_pendant_${i + 1}`, conf: 'high', group: f.group, unavailable_means: 'off' },
      ]),
    ),
    [dining.id]: { entity_id: 'light.kitchen_chandelier', conf: 'high', group: dining.group },
    ...Object.fromEntries(cans.map((f) => [f.id, { entity_id: 'light.kitchen_cans', conf: 'high', group: f.group }])),
    ...Object.fromEntries(
      undercab.map((f) => [f.id, { entity_id: 'light.kitchen_under_cabinet', conf: 'high', group: f.group }]),
    ),
  },
  nodeFeeds: [
    ['Kitchen_units', '9'],
    ['Kitchen_fridge', '11'],
    ['Kitchen_range', '1+3'],
    ['Kitchen_hood', '15'],
    ['Kitchen_microwave', '15'],
    ['Kitchen_dishwasher', '13'],
    ['Kitchen_sink', '13'],
  ],
  buildMain(m) {
    units(m);
    const ap = (name: string, s: Shape, kind: string) => m.node(name, s, { room: R, kind });
    ap('Kitchen_fridge', fridge(), 'refrigerator (French door)');
    ap('Kitchen_range', range(), 'electric range');
    ap('Kitchen_hood', hood(), 'range hood');
    ap('Kitchen_microwave', microwave(), 'built-in microwave');
    ap('Kitchen_dishwasher', dishwasher(), 'dishwasher');
    ap('Kitchen_sink', sink(), 'double-bowl sink, faucet and disposal');
  },
  buildFurniture(m) {
    // one merged node: three counter stools on the island's south side facing it, the dining table by the patio door
    // and four chairs facing it
    mergedParts(
      m,
      'Furn_dining',
      'kitchen_furniture',
      [
        ...[2.1, 2.65, 3.2].map((x, i) => ({
          name: `Counter stool ${i + 1}`,
          boxes: moved(stool(), [x, 6.2, 0], 2),
          extras: { product: 'counter stool' },
        })),
        {
          name: 'Dining table',
          boxes: [
            ['wood_ash', [4.6, 6.25, 0.72, 6.2, 7.15, 0.76]],
            ...moved(legs('wood_ash', 1.6, 0.9, 0.72, 0.06, 0.1), [5.4, 6.7, 0]),
          ],
          extras: { product: 'dining table, 1.6 × 0.9 m' },
        },
        ...(
          [
            [5.0, 5.86, 2],
            [5.8, 5.86, 2],
            [5.0, 7.54, 0],
            [5.8, 7.54, 0],
          ] as const
        ).map(([x, y, q], i) => ({
          name: `Dining chair ${i + 1}`,
          boxes: moved(sideChair(), [x, y, 0], q),
          extras: { product: 'dining chair' },
        })),
      ],
      { room: R },
    );
  },
};
