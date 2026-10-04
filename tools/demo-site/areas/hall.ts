// The hall (hall, with the stair and the air-handler closet under the landing), the powder room (powder_room) and the
// study (study): docs/demo-house.md#hall-hall
import type { V3 } from '../geometry.ts';
import { CEIL0, INT } from '../dims.ts';
import { item } from '../model.ts';
import { place, type Area, type Fixture, type Pin, type PlateSpec } from '../area.ts';

const hallPendant: Fixture = {
  id: 'hall.pendant',
  kind: 'pendant',
  group: 'fixture.hall',
  room: 'hall',
  at: [9, 1.6, CEIL0],
  breaker: '7',
};
const studyCeiling: Fixture = {
  id: 'study.ceiling',
  kind: 'flush',
  group: 'fixture.study',
  room: 'study',
  at: [8.8, 7.3, CEIL0],
  breaker: '7',
};

const HL_S_A: PlateSpec = {
  id: 'HL-S-A',
  room: 'hall',
  kind: 'switch',
  at: [10.35, 0, 1.2],
  normal: [0, 1],
  positions: [
    { pos: 1, role: 'porch lantern', breaker: '25', fixture_ids: ['porch.lantern'], ha_entity: 'light.porch' },
    {
      pos: 2,
      role: 'hall pendant (three-way with LV-S-A)',
      breaker: '7',
      fixture_ids: [hallPendant.id],
      ha_entity: 'light.hall',
      link: { box: 'LV-S-A', pos: 2, dir: 'with' },
    },
  ],
};

const thermostat: Pin = {
  id: 'hvac.thermostat',
  name: 'Thermostat',
  category: 'hvac',
  room: 'hall',
  at: [7 + INT / 2 + 0.01, 0.8, 1.5],
  make: 'Example Controls',
  model: 'T-100',
  ha: ['climate.thermostat'],
};
const router: Pin = {
  id: 'net.router',
  name: 'Router',
  category: 'net',
  room: 'study',
  at: [10.1, 8.6, 0.85],
  make: 'Example Networks',
  model: 'R-6',
  ha: ['device_tracker.router'],
  breaker: '17',
};

export const hall: Area = {
  id: 'hall',
  fixtures: [hallPendant, studyCeiling],
  plates: [HL_S_A],
  pins: [
    {
      id: 'hvac.air-handler',
      name: 'Air handler',
      category: 'hvac',
      room: 'hall',
      at: [11.3, 8.4, 1.0],
      make: 'Example Air',
      model: 'AH-36',
      specs: [
        ['capacity', '3 ton'],
        ['filter', '20 × 25 × 4 in'],
      ],
      note: 'In the closet under the landing.',
      breaker: '6+8',
    },
    thermostat,
    router,
  ],
  devices: [
    {
      id: 'demo-thermostat',
      name: 'Thermostat',
      integration: 'zwave_js',
      make: 'Example Controls',
      model: 'T-100',
      area: 'Hall',
      place: place('registry', thermostat.id, 'hall', thermostat.at),
      health: {
        avail: ['climate.thermostat'],
        node_status: ['sensor.thermostat_node_status'],
        battery: ['sensor.thermostat_battery'],
      },
    },
    {
      id: 'demo-hall-motion',
      name: 'Hall motion sensor',
      integration: 'zha',
      make: 'Example Sensors',
      model: 'MS-2',
      area: 'Hall',
      place: place('area', 'hall', 'hall', [9.5, 2, 2.2] as V3, true),
      health: {
        avail: ['binary_sensor.hall_motion'],
        battery: ['sensor.hall_motion_battery'],
        seen: ['sensor.hall_motion_temperature'],
        signal: [{ entity: 'sensor.hall_motion_lqi', kind: 'lqi' }],
      },
    },
    {
      id: 'demo-router',
      name: 'Router',
      integration: 'mqtt',
      make: 'Example Networks',
      model: 'R-6',
      area: 'Study',
      place: place('registry', router.id, 'study', router.at),
      health: { avail: ['device_tracker.router'], update: ['update.router_firmware'] },
    },
    {
      id: 'demo-doorbell',
      name: 'Doorbell',
      integration: 'mqtt',
      make: 'Example Security',
      model: 'DB-1',
      area: null,
      place: null,
      health: { avail: ['binary_sensor.doorbell'] },
    },
  ],
  haMap: {
    [hallPendant.id]: { entity_id: 'light.hall', conf: 'high', group: hallPendant.group },
    [studyCeiling.id]: { entity_id: 'light.study', conf: 'med', group: studyCeiling.group },
  },
  buildFurniture(m) {
    item(m, 'Furn_desk', 'study', 'desk, 1.4 × 0.7 m', [
      ['wood_ash', [8.9, 8.2, 0.72, 10.3, 8.9, 0.75]],
      ['black_steel', [8.95, 8.25, 0, 9.0, 8.85, 0.72]],
      ['black_steel', [10.2, 8.25, 0, 10.25, 8.85, 0.72]],
    ]);
    item(m, 'Furn_desk_chair', 'study', 'task chair', [
      ['black_steel', [9.35, 7.45, 0, 9.85, 7.95, 0.05]],
      ['fabric_blue', [9.35, 7.45, 0.45, 9.85, 7.95, 0.52]],
      ['fabric_blue', [9.35, 7.4, 0.52, 9.85, 7.48, 1.0]],
      ['black_steel', [9.58, 7.68, 0.05, 9.62, 7.72, 0.45]],
    ]);
  },
};
