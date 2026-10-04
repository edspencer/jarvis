// The living room (living_room): docs/demo-house.md#living-room-living_room
import type { V3 } from '../geometry.ts';
import { CEIL0, INT } from '../dims.ts';
import { item } from '../model.ts';
import { place, type Area, type Fixture, type PlateSpec } from '../area.ts';

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
// a lamp in the furniture model: a light fixture outside the main model, on the switched half of LV-O-A
const floorLamp: Fixture = {
  id: 'living.floor_lamp',
  kind: 'floor_lamp',
  group: 'fixture.lamp.living',
  room: 'living_room',
  at: [0.55, 4.4, 0],
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

export const living: Area = {
  id: 'living',
  fixtures: [...cans, floorLamp],
  plates: [LV_S_A, LV_O_A],
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
  },
  nodeFeeds: [['Furn_media_unit', '5']],
  buildFurniture(m) {
    item(m, 'Furn_sofa', 'living_room', 'three-seat sofa', [
      ['fabric_grey', [0.3, 1.2, 0.1, 1.2, 3.4, 0.45]],
      ['fabric_grey', [0.3, 1.2, 0.45, 0.5, 3.4, 0.85]],
      ['fabric_grey', [0.3, 1.0, 0.1, 1.2, 1.2, 0.6]],
      ['fabric_grey', [0.3, 3.4, 0.1, 1.2, 3.6, 0.6]],
      ['wood_walnut', [0.35, 1.05, 0, 1.15, 3.55, 0.1]],
    ]);
    item(m, 'Furn_coffee_table', 'living_room', 'oak coffee table', [
      ['wood_ash', [2.0, 1.8, 0.36, 2.7, 2.9, 0.4]],
      ['wood_ash', [2.05, 1.85, 0, 2.1, 1.9, 0.36]],
      ['wood_ash', [2.6, 1.85, 0, 2.65, 1.9, 0.36]],
      ['wood_ash', [2.05, 2.8, 0, 2.1, 2.85, 0.36]],
      ['wood_ash', [2.6, 2.8, 0, 2.65, 2.85, 0.36]],
    ]);
    item(m, 'Furn_media_unit', 'living_room', 'low media unit', [
      ['wood_walnut', [6.45, 0.4, 0, 6.9, 2.3, 0.5]],
      ['black_steel', [6.75, 0.75, 0.75, 6.8, 1.95, 1.45]],
    ]);
    item(m, 'Furn_rug', 'living_room', 'wool rug, 2 × 2.4 m', [['rug', [1.5, 1.1, 0, 3.5, 3.5, 0.012]]]);
    item(m, 'Furn_bookcase', 'living_room', 'bookcase', [
      ['wood_walnut', [4.7, 4.58, 0, 6.3, 4.94, 0.02]],
      ['wood_walnut', [4.7, 4.58, 0, 4.73, 4.94, 2.0]],
      ['wood_walnut', [6.27, 4.58, 0, 6.3, 4.94, 2.0]],
      ['wood_walnut', [4.7, 4.92, 0, 6.3, 4.94, 2.0]],
      ...[0.4, 0.8, 1.2, 1.6, 1.98].map((z): [string, number[]] => [
        'wood_walnut',
        [4.73, 4.58, z, 6.27, 4.92, z + 0.025],
      ]),
      ['books_red', [4.8, 4.66, 0.02, 5.3, 4.9, 0.32]],
      ['books_blue', [5.4, 4.66, 0.425, 6.1, 4.9, 0.7]],
      ['books_red', [4.76, 4.66, 0.825, 5.2, 4.9, 1.1]],
      ['books_blue', [5.5, 4.66, 1.225, 6.2, 4.9, 1.48]],
      ['books_red', [4.9, 4.66, 1.625, 5.6, 4.9, 1.88]],
    ]);
    item(m, 'Furn_picture', 'living_room', 'framed print', [
      ['black_steel', [0.6, 4.9, 1.25, 2.0, 4.94, 2.05]],
      ['art_print', [0.65, 4.895, 1.3, 1.95, 4.9, 2.0]],
    ]);
  },
};
