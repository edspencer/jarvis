// The first floor: the primary suite (bedroom_1, primary_closet, primary_bath), bedrooms 2 and 3, the hall bath
// (hall_bath) and the landing: docs/demo-house.md#primary-bedroom-bedroom_1-closet-primary_closet-bath-primary_bath
// The shapes (furniture, fittings, the fan, lamp and vanity-light fixtures) are in upstairs/kit.ts.
//
// Wall faces (plan): the primary bedroom is x 0-6.94, y 0-3.94 (doors in its north wall to the closet, x 0.8-1.6, and
// to the corridor, x 4.6-5.5; in its east wall to the bath, y 1.7-2.5); the closet x 0-2.44, y 4.06-5.14; the bath
// x 7.06-12, y 0-2.94; bedroom 2 x 0-3.44 and bedroom 3 x 3.56-6.94, both y 5.26-9 (doors x 2.62-3.4 and 3.8-4.6);
// the hall bath x 7.06-9.34, y 5.66-9 (door x 7.9-8.7). Doors swing into the rooms (the closet's out, into the
// bedroom), hinged on the side away from the switch.
import { Shape, type V3 } from '../geometry.ts';
import { CEIL1, UP } from '../dims.ts';
import { hex, item, type MaterialDef, type Model } from '../model.ts';
import { room, roomCentre } from '../layout.ts';
import { place, type Area, type Fixture, type Pin, type PlateSpec } from '../area.ts';
import {
  E,
  Fitted,
  Local,
  N,
  S,
  Wst,
  armchair,
  art,
  atticHatch,
  bed,
  bench,
  blind,
  ceilingFan,
  coAlarm,
  curtains,
  desk,
  deskChair,
  dresser,
  exhaustFan,
  mirror,
  nightstand,
  put,
  quarter,
  reachIn,
  shared,
  sideTable,
  smokeAlarm,
  tableLamp,
  tub,
  vanity,
  vanityGlobes,
  wc,
} from './upstairs/kit.ts';

const H = CEIL1 - UP; // 2.4: the first floor's rooms' height
/** a plan point, z above the first floor */
const at = (x: number, y: number, z: number): V3 => [x, y, UP + z];

// ------------------------------------------------------------------ light fixtures
const fx = (
  id: string,
  kind: string,
  group: string,
  room: string,
  p: V3,
  breaker: string,
  more: Partial<Fixture> = {},
): Fixture => ({ id, kind, group, room, at: p, breaker, ...more });

const B1_FAN = fx('bedroom_1.ceiling_fan', 'ceiling_fan', 'fixture.bedroom_1', 'bedroom_1', [3.5, 2.0, CEIL1], '19');
// table lamps (in the furniture model, like the living room's floor lamp) on the nightstands' tops
const B1_LAMPS = [
  [1.89, 3.74],
  [4.35, 3.74],
].map(([x, y], i) =>
  fx(`bedroom_1.lamp.${i + 1}`, 'table_lamp', 'fixture.lamps.bedroom_1', 'bedroom_1', at(x, y, 0.6), '19', {
    model: 'furniture',
  }),
);
const CLOSET = fx(
  'primary_closet.ceiling',
  'flush',
  'fixture.primary_closet',
  'primary_closet',
  [1.25, 4.5, CEIL1],
  '19',
);
// a 1.3 m vanity bar over the mirror (the viewer lights anything longer than 1.2 m as a line of lights)
const PB_VANITY = fx('primary_bath.vanity', 'bar', 'fixture.primary_bath', 'primary_bath', at(9.1, 0, 2.0), '19');
const PB_SHOWER = fx(
  'primary_bath.shower',
  'can',
  'fixture.primary_bath.shower',
  'primary_bath',
  [11.4, 2.34, CEIL1],
  '19',
);
const B2_CEIL = fx('bedroom_2.ceiling', 'flush', 'fixture.bedroom_2', 'bedroom_2', [1.72, 7.13, CEIL1], '21');
const B2_NIGHTSTANDS = [6.25, 8.35];
const B2_LAMPS = B2_NIGHTSTANDS.map((y, i) =>
  fx(`bedroom_2.lamp.${i + 1}`, 'table_lamp', 'fixture.lamps.bedroom_2', 'bedroom_2', at(3.24, y, 0.6), '21', {
    model: 'furniture',
  }),
);
const B3_FAN = fx('bedroom_3.ceiling_fan', 'ceiling_fan', 'fixture.bedroom_3', 'bedroom_3', [5.25, 7.13, CEIL1], '21');
const B3_LAMP = fx('bedroom_3.lamp', 'table_lamp', 'fixture.lamp.bedroom_3', 'bedroom_3', at(3.76, 8.11, 0.6), '21', {
  model: 'furniture',
});
// on the east wall over the vanity, facing west
const HB_VANITY = fx(
  'hall_bath.vanity',
  'vanity_globes',
  'fixture.hall_bath.vanity',
  'hall_bath',
  at(9.34, 6.75, 2.02),
  '21',
  { yaw: -Math.PI / 2 },
);
const HB_CEIL = fx('hall_bath.ceiling', 'flush', 'fixture.hall_bath', 'hall_bath', [8.25, 6.85, CEIL1], '21');
// the landing: by the stair, in the corridor to the bedrooms, at the stair head
const LANDING = [
  fx('landing.ceiling', 'flush', 'fixture.landing', 'landing', [8.8, 4.3, CEIL1], '21'),
  fx('landing.ceiling.2', 'flush', 'fixture.landing', 'landing', [4.75, 4.6, CEIL1], '21'),
  fx('landing.ceiling.3', 'flush', 'fixture.landing', 'landing', [10.0, 8.3, CEIL1], '21'),
];

const fixtures: Fixture[] = [
  B1_FAN,
  ...B1_LAMPS,
  CLOSET,
  PB_VANITY,
  PB_SHOWER,
  B2_CEIL,
  ...B2_LAMPS,
  B3_FAN,
  B3_LAMP,
  HB_VANITY,
  HB_CEIL,
  ...LANDING,
];

// ------------------------------------------------------------------ wall plates (switches 1.2 m up, outlets 0.3 m,
// bathroom counter outlets 1.05 m)
const outlet = (
  id: string,
  room: string,
  p: V3,
  normal: [number, number],
  breaker: string,
  role: string,
): PlateSpec => ({ id, room, kind: 'outlet', at: p, normal, positions: [{ pos: 1, role, breaker }] });

const B1_S_A: PlateSpec = {
  id: 'B1-S-A',
  room: 'bedroom_1',
  kind: 'switch',
  at: at(5.65, 3.94, 1.2),
  normal: [0, -1],
  positions: [
    { pos: 1, role: 'ceiling fan light', breaker: '19', fixture_ids: [B1_FAN.id], ha_entity: 'light.bedroom_1' },
    { pos: 2, role: 'ceiling fan (motor)', breaker: '19', ha_entity: 'fan.bedroom_fan' },
  ],
  notes: 'Two-gang smart fan and light control, by the door from the landing.',
};
const WC_S_A: PlateSpec = {
  id: 'WC-S-A',
  room: 'primary_closet',
  kind: 'switch',
  at: at(1.75, 4.06, 1.2),
  normal: [0, 1],
  positions: [
    { pos: 1, role: 'closet light', breaker: '19', fixture_ids: [CLOSET.id], ha_entity: 'light.walk_in_closet' },
  ],
};
// in the primary bath, by the door from the bedroom
const PB_S_A: PlateSpec = {
  id: 'PB-S-A',
  room: 'primary_bath',
  kind: 'switch',
  at: at(7.06, 2.75, 1.2),
  normal: [1, 0],
  positions: [
    {
      pos: 1,
      role: 'vanity light',
      breaker: '19',
      fixture_ids: [PB_VANITY.id],
      ha_entity: 'switch.bathroom_vanity',
    },
    { pos: 2, role: 'shower light', breaker: '19', fixture_ids: [PB_SHOWER.id], ha_entity: 'light.primary_shower' },
    { pos: 3, role: 'exhaust fan', breaker: '19' },
  ],
  notes: 'Three-gang: the vanity light (a smart switch), the shower light, the exhaust fan.',
};
const B2_S_A: PlateSpec = {
  id: 'B2-S-A',
  room: 'bedroom_2',
  kind: 'switch',
  at: at(2.5, 5.26, 1.2),
  normal: [0, 1],
  positions: [{ pos: 1, role: 'ceiling light', breaker: '21', fixture_ids: [B2_CEIL.id] }],
};
const B3_S_A: PlateSpec = {
  id: 'B3-S-A',
  room: 'bedroom_3',
  kind: 'switch',
  at: at(3.68, 5.26, 1.2),
  normal: [0, 1],
  positions: [
    { pos: 1, role: 'ceiling fan light', breaker: '21', fixture_ids: [B3_FAN.id], ha_entity: 'light.bedroom_3' },
    { pos: 2, role: 'ceiling fan (motor)', breaker: '21' },
  ],
};
const HB_S_A: PlateSpec = {
  id: 'HB-S-A',
  room: 'hall_bath',
  kind: 'switch',
  at: at(7.75, 5.66, 1.2),
  normal: [0, 1],
  positions: [
    { pos: 1, role: 'vanity light', breaker: '21', fixture_ids: [HB_VANITY.id], ha_entity: 'light.hall_bath_vanity' },
    { pos: 2, role: 'ceiling light', breaker: '21', fixture_ids: [HB_CEIL.id], ha_entity: 'light.hall_bath' },
    { pos: 3, role: 'exhaust fan', breaker: '21' },
  ],
};
// three-way: at the stair head and at the corridor's west end
const LD_S_A: PlateSpec = {
  id: 'LD-S-A',
  room: 'landing',
  kind: 'switch',
  at: at(9.46, 7.75, 1.2),
  normal: [1, 0],
  positions: [
    {
      pos: 1,
      role: 'landing lights (three-way with LD-S-B)',
      breaker: '21',
      fixture_ids: LANDING.map((f) => f.id),
      link: { box: 'LD-S-B', pos: 1, dir: 'with' },
    },
  ],
  notes: 'At the stair head; three-way with LD-S-B at the corridor end.',
};
const LD_S_B: PlateSpec = {
  id: 'LD-S-B',
  room: 'landing',
  kind: 'switch',
  at: at(2.56, 4.6, 1.2),
  normal: [1, 0],
  positions: [
    {
      pos: 1,
      role: 'landing lights (three-way with LD-S-A)',
      breaker: '21',
      fixture_ids: LANDING.map((f) => f.id),
      link: { box: 'LD-S-A', pos: 1, dir: 'with' },
    },
  ],
};

const plates: PlateSpec[] = [
  B1_S_A,
  outlet('B1-O-A', 'bedroom_1', at(1.89, 3.94, 0.3), [0, -1], '19', 'west nightstand (lamp)'),
  outlet('B1-O-B', 'bedroom_1', at(4.35, 3.94, 0.3), [0, -1], '19', 'east nightstand (lamp)'),
  outlet('B1-O-C', 'bedroom_1', at(0, 0.9, 0.3), [1, 0], '19', 'general'),
  outlet('B1-O-D', 'bedroom_1', at(3.5, 0, 0.3), [0, 1], '19', 'general'),
  outlet('B1-O-E', 'bedroom_1', at(6.94, 1.3, 0.3), [-1, 0], '19', 'reading corner'),
  WC_S_A,
  PB_S_A,
  outlet('PB-O-A', 'primary_bath', at(8.3, 0, 1.05), [0, 1], '23', 'vanity (GFCI)'),
  outlet('PB-O-B', 'primary_bath', at(9.9, 0, 1.05), [0, 1], '23', 'vanity (protected by PB-O-A)'),
  B2_S_A,
  outlet('B2-O-A', 'bedroom_2', at(3.44, 5.92, 0.3), [-1, 0], '21', 'south nightstand (lamp)'),
  outlet('B2-O-B', 'bedroom_2', at(3.44, 8.75, 0.3), [-1, 0], '21', 'north nightstand (lamp)'),
  outlet('B2-O-C', 'bedroom_2', at(0, 6.7, 0.3), [1, 0], '21', 'general'),
  B3_S_A,
  outlet('B3-O-A', 'bedroom_3', at(5.1, 9, 0.3), [0, -1], '21', 'desk'),
  outlet('B3-O-B', 'bedroom_3', at(3.56, 8.5, 0.3), [1, 0], '21', 'nightstand (lamp)'),
  outlet('B3-O-C', 'bedroom_3', at(5.6, 5.26, 0.3), [0, 1], '21', 'general'),
  HB_S_A,
  outlet('HB-O-A', 'hall_bath', at(9.34, 7.45, 1.05), [-1, 0], '23', 'vanity (GFCI)'),
  LD_S_A,
  LD_S_B,
  outlet('LD-O-A', 'landing', at(9.5, 3.06, 0.3), [0, 1], '21', 'general (vacuum)'),
];

// ------------------------------------------------------------------ registry pins
const alarm = (id: string, name: string, room: string, x: number, y: number, ha: string): Pin => ({
  id,
  name,
  category: 'safety',
  room,
  at: [x, y, CEIL1 - 0.03],
  make: 'Example Safety',
  model: id.startsWith('safety.co') ? 'CO-2' : 'SA-3',
  ha: [ha],
  specs: [
    ['power', '120 V, battery backup'],
    ['interconnect', 'wired to every alarm in the house'],
  ],
  breaker: '26',
});
const smoke = alarm('safety.smoke.landing', 'Smoke alarm (landing)', 'landing', 9.6, 5, 'binary_sensor.smoke_landing');
const co = alarm('safety.co.landing', 'CO alarm (landing)', 'landing', 3.4, 4.6, 'binary_sensor.co_landing');
// in each bedroom, at least 0.9 m from a fan's blade tips
const smokeBed = [
  alarm(
    'safety.smoke.bedroom_1',
    'Smoke alarm (primary bedroom)',
    'bedroom_1',
    5.4,
    3.0,
    'binary_sensor.smoke_bedroom_1',
  ),
  alarm('safety.smoke.bedroom_2', 'Smoke alarm (bedroom 2)', 'bedroom_2', 1.1, 6.3, 'binary_sensor.smoke_bedroom_2'),
  alarm('safety.smoke.bedroom_3', 'Smoke alarm (bedroom 3)', 'bedroom_3', 4.3, 5.85, 'binary_sensor.smoke_bedroom_3'),
];

const LANDING_C = roomCentre(room('landing'));
const pins: Pin[] = [
  {
    // the demo's one pin with an approximate place: at the landing's centroid (its room_centre), as a registry whose
    // item is known only by its room has it; so the device isn't drawn
    id: 'net.access-point',
    name: 'Wi-Fi access point (upstairs)',
    category: 'net',
    room: 'landing',
    at: [LANDING_C[0], LANDING_C[1], LANDING_C[2] + 1.2],
    approx: 'room-centroid',
    note: 'On the landing ceiling; exactly where is not recorded.',
    breaker: '21',
  },
  smoke,
  co,
  ...smokeBed,
];

// ------------------------------------------------------------------ materials
const materials: Record<string, MaterialDef> = {
  up_bedding_white: { c: hex('#f4f2ec'), rough: 1 },
  duvet_sage: { c: hex('#8fa58a'), rough: 1 },
  duvet_rust: { c: hex('#b8714f'), rough: 1 },
  duvet_navy: { c: hex('#33496b'), rough: 1 },
  up_art_mat: { c: hex('#f6f3ea'), rough: 0.9 },
  art_sky_dusk: { c: hex('#d9a48f'), rough: 0.7 },
  art_hills: { c: hex('#5d7a5a'), rough: 0.7 },
  up_bath_mirror: { c: hex('#cad7dd'), rough: 0.1 },
  up_closet_dark: { c: hex('#5b5650'), rough: 1 },
  up_blind_white: { c: hex('#f1efe8'), rough: 0.7 },
  up_fan_nickel: { c: hex('#9ea2a6'), rough: 0.35, metal: 0.8 },
  up_fan_blade: { c: hex('#6b4a33'), rough: 0.6 },
  up_lamp_ceramic: { c: hex('#5f7f86'), rough: 0.3 },
  curtain_oat: { c: hex('#d8ccb4'), rough: 1, double: true },
  shower_curtain: { c: hex('#e7eef0'), rough: 0.9, double: true },
  shower_glass: { c: hex('#d6e6ea', 0.25), rough: 0.05, blend: true },
  bath_tile: { c: hex('#eef0ee'), rough: 0.35 },
  vanity_quartz: { c: hex('#e8e6e1'), rough: 0.25 },
  vanity_navy: { c: hex('#2f4058'), rough: 0.5 },
  armchair_teal: { c: hex('#3f6f6c'), rough: 1 },
  furniture_white: { c: hex('#eeece6'), rough: 0.5 },
  clothes_navy: { c: hex('#2c3a55'), rough: 1 },
  clothes_oat: { c: hex('#cdbfa5'), rough: 1 },
  clothes_rust: { c: hex('#9a5038'), rough: 1 },
};

// ------------------------------------------------------------------ the main model: built-ins, fittings, ceiling kit
function primaryBath(m: Model) {
  const f = new Fitted();
  f.piece('WC', at(7.62, 0, 0), N, wc);
  f.piece('Double vanity', at(9.1, 0, 0), N, (l) => vanity(l, 1.8, 2, 'cabinet', 'vanity_quartz'), {
    product: '72 in double vanity, quartz top',
  });
  f.piece('Mirror', at(9.1, 0, 1.0), N, (l) => mirror(l, 1.3, 0.85));
  f.piece('Bath', at(11.15, 0, 0), N, (l) => tub(l, 1.7, 0.8), { product: '1700 × 800 soaking tub' });
  f.piece('Bath filler', at(11.15, 0, 0), N, (l) => {
    l.box('black_steel', -0.03, 0.02, 0.55, 0.03, 0.06, 0.64);
    l.box('black_steel', -0.015, 0.06, 0.61, 0.015, 0.17, 0.64);
  });
  // the walk-in shower in the north-east corner (frame: facing south from the north wall, +u is west): a low tray,
  // tiled walls, a fixed glass panel, a glass door and a glass side along x 10.8
  const shower = at(11.4, 2.94, 0);
  f.piece('Shower tray', shower, S, (l) => l.box('sanitary', -0.6, 0, 0, 0.6, 1.2, 0.05));
  f.piece('Shower tile', shower, S, (l) => {
    l.box('bath_tile', -0.6, 0, 0.05, 0.6, 0.01, 2.1);
    l.box('bath_tile', -0.6, 0.01, 0.05, -0.59, 1.2, 2.1);
  });
  f.piece(
    'Shower glass',
    shower,
    S,
    (l) => {
      l.box('shower_glass', -0.6, 1.19, 0.05, 0.0, 1.2, 2.0); // fixed panel
      l.box('shower_glass', 0.0, 1.19, 0.05, 0.59, 1.2, 2.0); // door
      l.box('shower_glass', 0.59, 0.01, 0.05, 0.6, 1.2, 2.0); // side
      for (const u of [-0.6, -0.005, 0.585]) l.box('black_steel', u, 1.185, 0.05, u + 0.015, 1.205, 2.0);
      l.box('black_steel', 0.04, 1.2, 0.95, 0.06, 1.25, 1.25); // door handle
    },
    { product: 'frameless glass, 10 mm' },
  );
  f.piece('Shower valve and head', shower, S, (l) => {
    l.lathe('black_steel', 0, 0.01, [
      [1.05, 0.06],
      [1.15, 0.06],
    ]);
    l.box('black_steel', -0.015, 0.0, 1.15, 0.015, 0.03, 2.02);
    l.box('black_steel', -0.015, 0.0, 1.99, 0.015, 0.3, 2.02);
    l.lathe(
      'black_steel',
      0,
      0.3,
      [
        [1.95, 0.1],
        [1.99, 0.1],
      ],
      10,
    );
  });
  f.piece('Towel bar', at(12, 1.27, 0), Wst, (l) => {
    l.box('black_steel', -0.33, 0, 1.2, -0.31, 0.06, 1.22);
    l.box('black_steel', 0.31, 0, 1.2, 0.33, 0.06, 1.22);
    l.box('black_steel', -0.33, 0.05, 1.2, 0.33, 0.065, 1.215);
    l.box('cabinet', -0.25, 0.04, 0.75, 0.25, 0.075, 1.24);
  });
  f.write(m, 'Primary_bath_fittings', 'primary_bath_fittings', { room: 'primary_bath' });
}

function hallBath(m: Model) {
  const f = new Fitted();
  // a tub-shower in an alcove at the west wall's north end: the west and north walls and a stub wall to the south
  f.piece('Alcove wall', at(7.44, 7.42, 0), N, (l) => l.box('plaster_bath', -0.38, -0.06, 0, 0.38, 0.06, H), {
    kind: 'interior wall',
  });
  f.piece('Bath', at(7.06, 8.24, 0), E, (l) => tub(l, 1.52, 0.76), { product: '60 × 30 in alcove tub' });
  // frame: facing south from the north wall; +u is west
  const alcove = at(7.44, 9, 0);
  f.piece('Tub surround', alcove, S, (l) => {
    l.box('bath_tile', -0.38, 0, 0.55, 0.38, 0.01, 1.95);
    l.box('bath_tile', 0.37, 0.01, 0.55, 0.38, 1.52, 1.95);
    l.box('bath_tile', -0.38, 1.51, 0.55, 0.37, 1.52, 1.95);
  });
  f.piece('Shower valve and head', alcove, S, (l) => {
    l.box('black_steel', -0.02, 0.01, 0.62, 0.02, 0.13, 0.65); // spout
    l.lathe('black_steel', 0, 0.01, [
      [1.0, 0.055],
      [1.1, 0.055],
    ]);
    l.box('black_steel', -0.012, 0.0, 1.8, 0.012, 0.18, 1.83);
    l.lathe(
      'black_steel',
      0,
      0.2,
      [
        [1.76, 0.06],
        [1.8, 0.06],
      ],
      10,
    );
  });
  f.piece(
    'Shower curtain and rod',
    at(7.82, 8.24, 0),
    E,
    (l) => {
      l.box('black_steel', -0.76, -0.012, 2.0, 0.76, 0.012, 2.025);
      // drawn back to the north end, in three folds
      for (const [u0, u1, v] of [
        [-0.74, -0.52, -0.01],
        [-0.52, -0.3, 0.015],
        [-0.3, -0.08, -0.01],
      ] as const)
        l.box('shower_curtain', u0, v - 0.006, 0.45, u1, v + 0.006, 1.99);
    },
    { product: 'fabric curtain on a straight rod' },
  );
  f.piece('WC', at(8.55, 9, 0), S, wc);
  f.piece('Vanity', at(9.34, 6.75, 0), Wst, (l) => vanity(l, 1.1, 1, 'vanity_navy', 'vanity_quartz'), {
    product: '42 in vanity',
  });
  f.piece('Mirror', at(9.34, 6.75, 1.0), Wst, (l) => mirror(l, 0.7, 0.8));
  f.piece('Towel hook and towel', at(7.44, 7.36, 0), S, (l) => {
    l.box('black_steel', -0.03, 0, 1.3, 0.03, 0.05, 1.34);
    l.box('vanity_navy', -0.2, 0.0, 0.75, 0.2, 0.04, 1.32);
  });
  f.write(m, 'Hall_bath_fittings', 'hall_bath_fittings', { room: 'hall_bath' });
}

function closets(m: Model) {
  // the walk-in: a rail and shelf the length of the north wall, hung with clothes; shelf towers either side of the
  // door (frame for the rail: facing south from the north wall)
  const f = new Fitted();
  const rail = at(1.22, 5.14, 0);
  f.piece('Rail and shelf', rail, S, (l) => {
    l.box('cabinet', -1.2, 0, 1.8, 1.2, 0.36, 1.83);
    l.box('cabinet', -1.2, 0.29, 1.7, 1.2, 0.31, 1.72);
    for (const u of [-1.18, 0, 1.16]) l.box('cabinet', u, 0, 1.6, u + 0.02, 0.36, 1.8); // brackets
  });
  f.piece('Clothes', rail, S, (l) => {
    const mats = ['clothes_navy', 'clothes_oat', 'clothes_rust'];
    let u = -1.12;
    for (let i = 0; u < 1.05; i++) {
      const w = 0.12 + ((i * 7) % 5) * 0.035;
      l.box(mats[i % mats.length], u, 0.05, i % 3 === 1 ? 0.6 : 0.95, Math.min(u + w, 1.1), 0.55, 1.68);
      u += w + 0.015;
    }
    // folded jumpers on the shelf
    for (const [u0, mat] of [
      [-1.0, 'clothes_oat'],
      [-0.6, 'clothes_navy'],
      [0.4, 'clothes_oat'],
      [0.8, 'clothes_rust'],
    ] as const)
      l.box(mat, u0, 0.04, 1.83, u0 + 0.3, 0.3, 1.97);
  });
  for (const [name, x, q] of [
    ['Shelves (west)', 0, E],
    ['Shelves (east)', 2.44, Wst],
  ] as const)
    f.piece(name, at(x, 4.31, 0), q, (l) => {
      l.box('cabinet', -0.25, 0, 0, -0.23, 0.38, 2.0);
      l.box('cabinet', 0.23, 0, 0, 0.25, 0.38, 2.0);
      for (const z of [0, 0.5, 1.0, 1.5, 1.98]) l.box('cabinet', -0.23, 0, z, 0.23, 0.38, z + 0.02);
      // shoes on the bottom two, folded stacks above
      for (const [z, mat] of [
        [0.02, 'clothes_rust'],
        [0.52, 'clothes_navy'],
        [1.02, 'clothes_oat'],
      ] as const)
        l.box(mat, -0.2, 0.04, z, 0.2, 0.33, z + (z < 0.5 ? 0.11 : 0.24));
    });
  f.write(m, 'Primary_closet_fittings', 'primary_closet_fittings', { room: 'primary_closet' });

  // reach-in closets, built in (bifold doors), and the landing's linen closet
  for (const [name, room, o, q, w, d, panels, product] of [
    ['Closet_bedroom_2', 'bedroom_2', at(1.2, 5.26, 0), N, 2.4, 0.64, 4, 'reach-in closet, bifold doors'],
    ['Closet_bedroom_3', 'bedroom_3', at(6.94, 7.9, 0), Wst, 2.2, 0.62, 4, 'reach-in closet, bifold doors'],
    ['Closet_linen', 'landing', at(7.95, 3.06, 0), N, 0.9, 0.5, 1, 'linen closet'],
  ] as const) {
    const l = new Local(new Shape(), o, q);
    reachIn(l, w, d, H, panels);
    m.node(name, l.s, { room, kind: 'closet', product });
  }
}

function ceilingKit(m: Model) {
  // the alarms share a mesh each (a node per alarm, at its registry pin)
  const smokeMesh = shared(m, 'smoke_alarm', smokeAlarm);
  for (const p of [smoke, ...smokeBed])
    m.node(
      `Alarm_${p.id.slice('safety.'.length).replace(/\./g, '_')}`,
      smokeMesh,
      { room: p.room, kind: 'smoke alarm', pin: p.id },
      { at: [p.at[0], p.at[1], CEIL1] },
    );
  m.node(
    'Alarm_co_landing',
    shared(m, 'co_alarm', coAlarm),
    { room: 'landing', kind: 'CO alarm', pin: co.id },
    { at: [co.at[0], co.at[1], CEIL1] },
  );
  const fan = shared(m, 'exhaust_fan', exhaustFan);
  m.node(
    'Fan_primary_bath',
    fan,
    { room: 'primary_bath', kind: 'exhaust fan', product: '110 cfm' },
    {
      at: [8.4, 1.4, CEIL1],
    },
  );
  m.node(
    'Fan_hall_bath',
    fan,
    { room: 'hall_bath', kind: 'exhaust fan', product: '80 cfm' },
    { at: [8.3, 8.2, CEIL1] },
  );
  const one = (name: string, p: V3, draw: (l: Local) => void, extras: Record<string, unknown>) => {
    const l = new Local(new Shape(), p, N);
    draw(l);
    m.node(name, l.s, { room: 'landing', ...extras });
  };
  one('Attic_hatch', [9.95, 3.75, CEIL1], (l) => atticHatch(l, 0.56, 0.76), { kind: 'attic hatch' });
}

// ------------------------------------------------------------------ the furniture model
function bedrooms(m: Model) {
  const S_ = quarter(S),
    W_ = quarter(Wst),
    E_ = quarter(E);
  // the primary bedroom: a king bed on the north wall between the two doors, walnut nightstands, a bench at its foot
  const king = shared(m, 'bed_king', (l) => bed(l, 1.98, 2.13, 'wood_walnut', 'duvet_sage', 2, 1.2));
  put(m, 'Furn_bed_1', 'bedroom_1', 'king bed', king, at(3.12, 3.94, 0), S_);
  const ns1 = shared(m, 'nightstand_walnut', (l) => nightstand(l, 'wood_walnut'));
  put(m, 'Furn_nightstand_1a', 'bedroom_1', 'nightstand', ns1, at(1.89, 3.94, 0), S_);
  put(m, 'Furn_nightstand_1b', 'bedroom_1', 'nightstand', ns1, at(4.35, 3.94, 0), S_);
  const benchMesh = shared(m, 'bench', (l) => bench(l, 1.4, 'fabric_grey', 'wood_walnut'));
  put(m, 'Furn_bench_1', 'bedroom_1', 'upholstered bench', benchMesh, at(3.12, 1.73, 0), S_);
  const dresser1 = shared(m, 'dresser_walnut', (l) => dresser(l, 1.3, 0.85, 'wood_walnut'));
  put(m, 'Furn_dresser_1', 'bedroom_1', 'six-drawer dresser', dresser1, at(6.94, 3.25, 0), W_);
  const mirror1 = shared(m, 'mirror_dresser', (l) => mirror(l, 0.8, 0.8));
  put(m, 'Furn_mirror_1', 'bedroom_1', 'framed mirror', mirror1, at(6.94, 3.25, 1.05), W_);
  const print = shared(m, 'art_print', (l) => art(l, 0.9, 0.6, 'art_sky_dusk', 'art_hills'));
  put(m, 'Furn_art_1', 'bedroom_1', 'framed print', print, at(3.12, 3.94, 1.35), S_);
  // a reading chair in the south-east corner, turned to face the room, and a side table
  const chair = shared(m, 'armchair', (l) => armchair(l, 'armchair_teal', 'wood_walnut'));
  put(m, 'Furn_armchair_1', 'bedroom_1', 'armchair', chair, at(6.58, 0.47, 0), Math.PI / 4);
  const table = shared(m, 'side_table', (l) => sideTable(l, 'wood_walnut'));
  put(m, 'Furn_side_table_1', 'bedroom_1', 'round side table', table, at(6.65, 1.45, 0));
  item(m, 'Furn_rug_1', 'bedroom_1', 'wool rug, 3 × 2.4 m', [['rug', [1.62, 1.2, 0, 4.62, 3.6, 0.012]]], 1);
  const drapes: [string, number[]][] = [
    ...curtains('x', 0, 1, 1.2, 3.0, 'curtain_oat'),
    ...curtains('x', 0, 1, 4.0, 5.8, 'curtain_oat'),
    ...curtains('y', 0, 1, 1.8, 3.4, 'curtain_oat'),
  ];
  item(m, 'Furn_curtains_1', 'bedroom_1', 'linen curtains', drapes, 1);

  // bedroom 2 (a guest room): a queen bed on the east wall, white nightstands and a dresser on the west wall
  const queen = shared(m, 'bed_queen', (l) => bed(l, 1.6, 2.13, 'wood_ash', 'duvet_navy', 2));
  put(m, 'Furn_bed_2', 'bedroom_2', 'queen bed', queen, at(3.44, 7.3, 0), W_);
  const nsWhite = shared(m, 'nightstand_white', (l) => nightstand(l, 'furniture_white'));
  B2_NIGHTSTANDS.forEach((y, i) =>
    put(m, `Furn_nightstand_2${'ab'[i]}`, 'bedroom_2', 'nightstand', nsWhite, at(3.44, y, 0), W_),
  );
  const dresserWhite = shared(m, 'dresser_white', (l) => dresser(l, 1.0, 0.95, 'furniture_white'));
  put(m, 'Furn_dresser_2', 'bedroom_2', 'six-drawer dresser', dresserWhite, at(0, 8.3, 0), E_);
  put(m, 'Furn_art_2', 'bedroom_2', 'framed print', print, at(3.44, 7.3, 1.3), W_);
  const blinds2 = [...blind('x', 9, 1, 0.9, 2.4, 2.2, 0.55), ...blind('y', 0, -1, 6.0, 7.4, 2.2, 0.55)];
  item(m, 'Furn_blinds_2', 'bedroom_2', 'white blinds', blinds2, 1);

  // bedroom 3 (a kid's room): a full bed on the west wall, a desk under the window, a white dresser
  const full = shared(m, 'bed_full', (l) => bed(l, 1.45, 2.03, 'furniture_white', 'duvet_rust', 1, 0.95));
  put(m, 'Furn_bed_3', 'bedroom_3', 'full bed', full, at(3.56, 7.12, 0), E_);
  put(m, 'Furn_nightstand_3', 'bedroom_3', 'nightstand', nsWhite, at(3.56, 8.11, 0), E_);
  const deskMesh = shared(m, 'desk', (l) => desk(l, 1.2, 'furniture_white', 'furniture_white'));
  put(m, 'Furn_desk_3', 'bedroom_3', 'desk', deskMesh, at(5.1, 9, 0), S_);
  const deskChairMesh = shared(m, 'desk_chair', (l) => deskChair(l, 'armchair_teal', 'furniture_white'));
  put(m, 'Furn_desk_chair_3', 'bedroom_3', 'desk chair', deskChairMesh, at(5.1, 7.95, 0));
  put(m, 'Furn_dresser_3', 'bedroom_3', 'six-drawer dresser', dresserWhite, at(6.94, 5.95, 0), W_);
  item(m, 'Furn_rug_3', 'bedroom_3', 'cotton rug', [['duvet_navy', [4.6, 6.0, 0, 6.2, 7.8, 0.012]]], 1);
  item(m, 'Furn_blinds_3', 'bedroom_3', 'white blinds', blind('x', 9, 1, 4.6, 6.1, 2.2, 0.55), 1);
}

// ------------------------------------------------------------------ the area
export const upstairs: Area = {
  id: 'upstairs',
  materials,
  fixtureShapes: { ceiling_fan: ceilingFan, table_lamp: tableLamp, vanity_globes: vanityGlobes },
  fixtures,
  plates,
  pins,
  devices: [
    {
      id: 'demo-smoke-landing',
      name: 'Smoke alarm (landing)',
      integration: 'zwave_js',
      make: 'Example Safety',
      model: 'SA-3',
      area: 'Landing',
      place: place('registry', smoke.id, 'landing', smoke.at),
      health: {
        avail: ['binary_sensor.smoke_landing'],
        node_status: ['sensor.smoke_landing_node_status'],
        battery: ['sensor.smoke_landing_battery'],
      },
    },
    {
      id: 'demo-co-landing',
      name: 'CO alarm (landing)',
      integration: 'zwave_js',
      make: 'Example Safety',
      model: 'CO-2',
      area: 'Landing',
      place: place('registry', co.id, 'landing', co.at),
      health: {
        avail: ['binary_sensor.co_landing'],
        node_status: ['sensor.co_landing_node_status'],
        battery: ['sensor.co_landing_battery'],
      },
    },
    {
      id: 'demo-bedroom-fan-control',
      name: 'Primary bedroom fan and light control',
      integration: 'zwave_js',
      make: 'Example Controls',
      model: 'FC-2',
      area: 'Primary bedroom',
      place: place('plate', B1_S_A.id, 'bedroom_1', B1_S_A.at),
      fixtures: [B1_FAN.id],
      health: { avail: ['light.bedroom_1', 'fan.bedroom_fan'], node_status: ['sensor.bedroom_fan_node_status'] },
    },
  ],
  haMap: {
    [B1_FAN.id]: { entity_id: 'light.bedroom_1', conf: 'high', group: B1_FAN.group },
    [B1_LAMPS[0].id]: { entity_id: 'light.bedroom_1_lamp_left', conf: 'high', group: B1_LAMPS[0].group },
    [B1_LAMPS[1].id]: { entity_id: 'light.bedroom_1_lamp_right', conf: 'high', group: B1_LAMPS[1].group },
    [CLOSET.id]: { entity_id: 'light.walk_in_closet', conf: 'high', group: CLOSET.group },
    [PB_VANITY.id]: {
      entity_id: 'switch.bathroom_vanity',
      conf: 'high',
      group: PB_VANITY.group,
      switch_is_light: true,
    },
    [PB_SHOWER.id]: { entity_id: 'light.primary_shower', conf: 'high', group: PB_SHOWER.group },
    // deliberately unmapped: ?ha=mock invents an entity for it
    [B2_CEIL.id]: { entity_id: null, conf: 'low', group: B2_CEIL.group },
    ...Object.fromEntries(
      B2_LAMPS.map((f) => [f.id, { entity_id: 'light.bedroom_2_lamps', conf: 'high', group: f.group }]),
    ),
    [B3_FAN.id]: { entity_id: 'light.bedroom_3', conf: 'high', group: B3_FAN.group },
    [B3_LAMP.id]: { entity_id: 'light.bedroom_3_lamp', conf: 'high', group: B3_LAMP.group },
    [HB_VANITY.id]: { entity_id: 'light.hall_bath_vanity', conf: 'high', group: HB_VANITY.group },
    [HB_CEIL.id]: { entity_id: 'light.hall_bath', conf: 'high', group: HB_CEIL.group },
    // the landing's lights are on plain three-way switches: unmapped
    ...Object.fromEntries(LANDING.map((f) => [f.id, { entity_id: null, conf: 'low', group: f.group }])),
  },
  nodeFeeds: [
    ['Fan_primary_bath', '19'],
    ['Fan_hall_bath', '21'],
  ],
  buildMain(m) {
    primaryBath(m);
    hallBath(m);
    closets(m);
    ceilingKit(m);
  },
  buildFurniture(m) {
    bedrooms(m);
  },
};
