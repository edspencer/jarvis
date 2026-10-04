// The living room (living_room): docs/demo-house.md#living-room-living_room
//
// A family room: one TV, wall-mounted over a media console on the east wall (between the room's south-east corner and
// the opening to the hall), a three-seat sofa facing it 3.4 m away and centred on it (y 1.5), the coffee table between
// them on a rug under the sofa's front legs, an armchair on the rug's north side turned to the TV, a side table with a
// lamp at the sofa's north end and a sofa table behind it. The west end is a reading corner: an armchair, the floor
// lamp and a framed landscape. Curtains at the three windows; the bookcase on the north wall. The way from the hall to
// the kitchen passes north of the armchair, clear of the TV.
import type { V3 } from '../geometry.ts';
import { CEIL0, INT } from '../dims.ts';
import { hex } from '../model.ts';
import { place, type Area, type Fixture, type Pin, type PlateSpec } from '../area.ts';
import {
  KIT_MATERIALS,
  alarm,
  armchair,
  bookcase,
  boxes,
  framedArt,
  furn,
  legs,
  mergedParts,
  moved,
  put,
  sharedMesh,
  sofa,
  type Box,
} from './ground/kit.ts';

const cans: Fixture[] = [
  [2, 1.5],
  [5, 1.5],
  [2, 3.5],
  [5, 3.5],
].map(([x, y], i) => ({
  id: `living.can.${i + 1}`,
  kind: 'can',
  group: 'fixture.cans.living',
  room: 'living_room',
  at: [x, y, CEIL0] as V3,
  breaker: '7',
}));
// lamps in the furniture model: light fixtures outside the main model. The floor lamp (reading corner) is on the
// switched half of LV-O-A; the table lamp (on the side table) is plugged in at LV-O-D, and left unmapped (?ha=mock
// invents its entity)
const floorLamp: Fixture = {
  id: 'living.floor_lamp',
  kind: 'floor_lamp',
  group: 'fixture.lamp.living',
  room: 'living_room',
  at: [0.55, 4.4, 0],
  breaker: '5',
  model: 'furniture',
};
// (its shape is the table_lamp kind the upstairs area defines, as the bedside lamps are)
const tableLamp: Fixture = {
  id: 'living.table_lamp',
  kind: 'table_lamp',
  group: 'fixture.lamp.living_table',
  room: 'living_room',
  at: [3.44, 2.86, 0.58],
  breaker: '5',
  model: 'furniture',
};

const LV_S_A: PlateSpec = {
  id: 'LV-S-A',
  room: 'living_room',
  kind: 'switch',
  at: [7 - INT / 2, 2.45, 1.2],
  normal: [-1, 0],
  positions: [
    {
      pos: 1,
      role: 'living room cans',
      breaker: '7',
      fixture_ids: cans.map((f) => f.id),
      ha_entity: 'light.living_room_cans',
    },
    {
      pos: 2,
      role: 'hall pendant (three-way with HL-S-A)',
      breaker: '7',
      fixture_ids: ['hall.pendant'],
      link: { box: 'HL-S-A', pos: 2, dir: 'with' },
    },
  ],
  notes: 'Two-gang; position 2 is three-way with HL-S-A by the front door.',
};
const LV_O_A: PlateSpec = {
  id: 'LV-O-A',
  room: 'living_room',
  kind: 'outlet',
  at: [0, 4.2, 0.35],
  normal: [1, 0],
  positions: [{ pos: 1, role: 'floor lamp (switched half)', breaker: '5', fixture_ids: [floorLamp.id] }],
};
const outlet = (id: string, at: V3, normal: [number, number], role: string, fixtures?: string[]): PlateSpec => ({
  id,
  room: 'living_room',
  kind: 'outlet',
  at,
  normal,
  positions: [{ pos: 1, role, breaker: '5', ...(fixtures ? { fixture_ids: fixtures } : {}) }],
});
const plates: PlateSpec[] = [
  LV_S_A,
  LV_O_A,
  outlet('LV-O-B', [7 - INT / 2, 2.45, 0.3], [-1, 0], 'TV, soundbar, streaming box'),
  outlet('LV-O-C', [6.6, 5 - INT / 2, 0.3], [0, -1], 'general'),
  outlet('LV-O-D', [3.5, 0, 0.3], [0, 1], 'table lamp', [tableLamp.id]),
  outlet('LV-O-E', [0, 1.0, 0.3], [1, 0], 'general'),
];

const smoke: Pin = {
  id: 'safety.smoke.living',
  name: 'Smoke alarm (living room)',
  category: 'safety',
  room: 'living_room',
  at: [3.5, 4.2, CEIL0 - 0.03],
  make: 'Example Safety',
  model: 'SA-120',
  specs: [
    ['power', '120 V, battery backup'],
    ['interconnect', 'wired, with every alarm in the house'],
  ],
  ha: ['binary_sensor.smoke_living_room'],
  breaker: '26',
};

/** curtain panels either side of a window (a to b along a wall whose inner face is at `face`, the room on the
 * `inward` side) and a rod over it. Each panel is three folds. */
function curtains(along: 'x' | 'y', face: number, inward: 1 | -1, a: number, b: number): Box[] {
  const box = (u0: number, u1: number, d0: number, d1: number, z0: number, z1: number): number[] => {
    const v0 = face + inward * d0,
      v1 = face + inward * d1;
    const [w0, w1] = v0 < v1 ? [v0, v1] : [v1, v0];
    return along === 'x' ? [u0, w0, z0, u1, w1, z1] : [w0, u0, z0, w1, u1, z1];
  };
  const parts: Box[] = [];
  for (const u0 of [a - 0.29, b + 0.02])
    for (let i = 0; i < 3; i++) {
      const d = i % 2 ? 0.07 : 0.04;
      parts.push(['curtain_living', box(u0 + i * 0.09, u0 + (i + 1) * 0.09, d, d + 0.04, 0.03, 2.38)]);
    }
  parts.push(['black_steel', box(a - 0.36, b + 0.36, 0.06, 0.085, 2.4, 2.425)]);
  return parts;
}

export const living: Area = {
  id: 'living',
  materials: {
    ...KIT_MATERIALS,
    tv_screen: { c: hex('#07090c'), rough: 0.12, metal: 0.5 },
    curtain_living: { c: hex('#8a9bab'), rough: 1, double: true },
    rug_field: { c: hex('#d9ccb0'), rough: 1 },
  },
  fixtures: [...cans, floorLamp, tableLamp],
  plates,
  pins: [smoke],
  devices: [
    {
      id: 'demo-living-dimmer',
      name: 'Living room dimmer',
      integration: 'zwave_js',
      make: 'Example Controls',
      model: 'ZD-1',
      area: 'Living room',
      place: place('plate', LV_S_A.id, 'living_room', LV_S_A.at),
      health: { avail: ['light.living_room_cans'], node_status: ['sensor.living_dimmer_node_status'] },
    },
    {
      id: 'demo-floor-lamp',
      name: 'Floor lamp bulb',
      integration: 'hue',
      make: 'Example Lighting',
      model: 'E27 bulb',
      area: 'Living room',
      place: place('fixture', floorLamp.id, 'living_room', [0.55, 4.4, 1.4]),
      fixtures: [floorLamp.id],
      powered_by: 'switch.living_outlet',
      health: { avail: ['light.floor_lamp'] },
    },
  ],
  haMap: {
    ...Object.fromEntries(
      cans.map((f) => [f.id, { entity_id: 'light.living_room_cans', conf: 'high', group: f.group }]),
    ),
    [floorLamp.id]: { entity_id: 'light.floor_lamp', conf: 'high', group: floorLamp.group },
    [tableLamp.id]: { entity_id: null, conf: 'low', group: tableLamp.group },
  },
  nodeFeeds: [
    ['Furn_tv', '5'],
    ['Furn_media_unit', '5'],
  ],
  buildMain(m) {
    m.node(
      `Alarm_${smoke.id}`,
      sharedMesh(m, 'alarm_smoke', () => alarm('smoke')),
      { room: 'living_room', pin: smoke.id },
      {
        at: [smoke.at[0], smoke.at[1], CEIL0],
      },
    );
  },
  buildFurniture(m) {
    const R = 'living_room';
    // the TV wall (east): a 65 in TV on a wall mount, the console under it (each its own node: circuit 5 feeds them)
    furn(m, 'Furn_tv', R, '65 in TV, wall-mounted', [
      ['black_steel', [6.87, 0.775, 0.85, 6.915, 2.225, 1.665]],
      ['black_steel', [6.915, 1.2, 1.05, 6.94, 1.8, 1.45]],
      ['tv_screen', [6.866, 0.787, 0.862, 6.87, 2.213, 1.653], 'x-'],
    ]);
    furn(m, 'Furn_media_unit', R, 'media console, soundbar and streaming box', [
      ['wood_walnut', [6.48, 0.65, 0.12, 6.92, 2.35, 0.55]],
      ...[0.68, 2.27].flatMap((y): Box[] => [
        ['black_steel', [6.52, y, 0, 6.56, y + 0.04, 0.12]],
        ['black_steel', [6.84, y, 0, 6.88, y + 0.04, 0.12]],
      ]),
      ...[0.67, 1.24, 1.81].map((y): Box => ['wood_ash', [6.465, y, 0.16, 6.48, y + 0.53, 0.51], 'x-']),
      ['black_steel', [6.55, 0.95, 0.55, 6.65, 2.05, 0.62]],
      ['black_steel', [6.62, 2.12, 0.55, 6.72, 2.24, 0.58]],
    ]);
    // the armchairs, turned (each a node, one mesh) and the bookcase (its mesh shared with the study's)
    const chair = sharedMesh(m, 'armchair', armchair);
    put(m, 'Furn_armchair', chair, { room: R, product: 'armchair' }, [4.85, 3.15, 0], 30);
    put(m, 'Furn_reading_chair', chair, { room: R, product: 'armchair (reading corner)' }, [1.35, 3.95, 0], 40);
    const shelves = sharedMesh(m, 'bookcase', () => boxes(bookcase()));
    put(m, 'Furn_bookcase', shelves, { room: R, product: 'bookcase' }, [5.5, 4.76, 0]);
    // the rest, one merged node: the sofa facing the TV and centred on it, the coffee table between them, the rug under
    // the sofa's front legs, the side table (with the table lamp) and the sofa table, the picture, the curtains
    mergedParts(
      m,
      'Furn_living',
      'living_furniture',
      [
        { name: 'Sofa', boxes: moved(sofa(), [3.475, 1.5, 0], 1), extras: { product: 'three-seat sofa' } },
        {
          name: 'Coffee table',
          boxes: [
            ['wood_ash', [4.35, 0.95, 0.38, 5.0, 2.05, 0.42]],
            ['wood_ash', [4.4, 1.0, 0.12, 4.95, 2.0, 0.14]],
            ...moved(legs('wood_ash', 0.65, 1.1, 0.38), [4.675, 1.5, 0]),
            ['books_blue', [4.5, 1.15, 0.42, 4.75, 1.45, 0.46]],
            ['books_red', [4.52, 1.17, 0.46, 4.73, 1.42, 0.48]],
          ],
          extras: { product: 'oak coffee table, 1.1 × 0.65 m' },
        },
        {
          name: 'Rug',
          boxes: [
            ['rug', [3.7, 0.3, 0, 6.1, 2.7, 0.012]],
            ['rug_field', [3.88, 0.48, 0.012, 5.92, 2.52, 0.014], 'z+'],
          ],
          extras: { product: 'wool rug, 2.4 × 2.4 m' },
        },
        {
          name: 'Side table',
          boxes: [
            ['wood_walnut', [3.2, 2.62, 0.55, 3.68, 3.1, 0.58]],
            ['wood_walnut', [3.24, 2.66, 0.15, 3.64, 3.06, 0.17]],
            ...moved(legs('wood_walnut', 0.48, 0.48, 0.55, 0.03, 0.01), [3.44, 2.86, 0]),
          ],
          extras: { product: 'side table' },
        },
        {
          name: 'Sofa table',
          boxes: [
            ['wood_walnut', [2.6, 0.75, 0.72, 2.95, 2.25, 0.75]],
            ['wood_walnut', [2.62, 0.77, 0, 2.66, 2.23, 0.72]],
            ['wood_walnut', [2.89, 0.77, 0, 2.93, 2.23, 0.72]],
            ['books_red', [2.68, 0.95, 0.75, 2.88, 1.25, 0.8]],
          ],
          extras: { product: 'sofa table' },
        },
        {
          name: 'Picture',
          boxes: moved(framedArt(1.1, 0.8), [1.25, 4.94, 1.3]),
          extras: { product: 'framed print (a landscape)' },
        },
        {
          name: 'Curtains',
          boxes: [...curtains('x', 0, 1, 1.2, 3.0), ...curtains('x', 0, 1, 4.0, 5.8), ...curtains('y', 0, 1, 1.8, 3.4)],
          extras: { product: 'curtains and rods' },
        },
      ],
      { room: R },
    );
  },
};
