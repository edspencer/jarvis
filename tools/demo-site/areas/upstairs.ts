// The first floor: the primary suite (bedroom_1, primary_closet, primary_bath), bedrooms 2 and 3, the hall bath
// (hall_bath) and the landing: docs/demo-house.md#primary-bedroom-bedroom_1-closet-primary_closet-bath-primary_bath
// (It may split into files under areas/upstairs/ as it grows.)
import { CEIL1, INT, UP } from '../dims.ts';
import { item, merged } from '../model.ts';
import { place, type Area, type Fixture, type Pin, type PlateSpec } from '../area.ts';

const fixtures: Fixture[] = [
  {
    id: 'bedroom_1.ceiling',
    kind: 'flush',
    group: 'fixture.bedroom_1',
    room: 'bedroom_1',
    at: [3.5, 2.0, CEIL1],
    breaker: '19',
  },
  {
    id: 'bedroom_2.ceiling',
    kind: 'flush',
    group: 'fixture.bedroom_2',
    room: 'bedroom_2',
    at: [1.75, 7.1, CEIL1],
    breaker: '21',
  },
  {
    id: 'landing.ceiling',
    kind: 'flush',
    group: 'fixture.landing',
    room: 'landing',
    at: [8.8, 4.3, CEIL1],
    breaker: '21',
  },
  // a 1.3 m vanity bar: the viewer lights anything longer than 1.2 m as a line of lights
  {
    id: 'primary_bath.vanity',
    kind: 'bar',
    group: 'fixture.primary_bath',
    room: 'primary_bath',
    at: [9.8, 0.05, UP + 2.0],
    breaker: '19',
  },
];

// in the primary bath, by the door from the bedroom
const PB_S_A: PlateSpec = {
  id: 'PB-S-A',
  room: 'primary_bath',
  kind: 'switch',
  at: [7 + INT / 2, 2.75, UP + 1.2],
  normal: [1, 0],
  positions: [
    {
      pos: 1,
      role: 'vanity light',
      breaker: '19',
      fixture_ids: ['primary_bath.vanity'],
      ha_entity: 'switch.bathroom_vanity',
    },
  ],
};

const smoke: Pin = {
  id: 'safety.smoke.landing',
  name: 'Smoke alarm (landing)',
  category: 'safety',
  room: 'landing',
  at: [9.6, 5, CEIL1 - 0.03],
  ha: ['binary_sensor.smoke_landing'],
  breaker: '26',
};

export const upstairs: Area = {
  id: 'upstairs',
  fixtures,
  plates: [PB_S_A],
  pins: [
    {
      id: 'net.access-point',
      name: 'Wi-Fi access point (upstairs)',
      category: 'net',
      room: 'landing',
      at: [10.0, 4.6, UP + 2.2],
      approx: 'room-centroid',
      note: 'On the landing ceiling; exactly where is not recorded.',
      breaker: '21',
    },
    smoke,
  ],
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
  ],
  haMap: {
    'bedroom_1.ceiling': { entity_id: 'light.bedroom_1', conf: 'high', group: 'fixture.bedroom_1' },
    'bedroom_2.ceiling': { entity_id: null, conf: 'low', group: 'fixture.bedroom_2' },
    'landing.ceiling': { entity_id: null, conf: 'low', group: 'fixture.landing' },
    'primary_bath.vanity': {
      entity_id: 'switch.bathroom_vanity',
      conf: 'high',
      group: 'fixture.primary_bath',
      switch_is_light: true,
    },
  },
  buildMain(m) {
    merged(
      m,
      'Primary_bath_fittings',
      'primary_bath_fittings',
      [
        {
          name: 'Bath',
          material: 'sanitary',
          boxes: [[10.2, 1.25, UP, 12, 2.95, UP + 0.55]],
          extras: { product: '1700 × 700 bath' },
        },
        { name: 'Vanity unit', material: 'cabinet', boxes: [[9.3, 0, UP, 10.3, 0.5, UP + 0.85]] },
        { name: 'Basin', material: 'sanitary', boxes: [[9.45, 0.05, UP + 0.85, 10.15, 0.45, UP + 0.9]] },
        { name: 'WC', material: 'sanitary', boxes: [[7.4, 0.1, UP, 7.8, 0.75, UP + 0.42]] },
      ],
      { room: 'primary_bath' },
    );
  },
  buildFurniture(m) {
    item(
      m,
      'Furn_bed_1',
      'bedroom_1',
      'king bed',
      [
        ['wood_walnut', [1.0, 0.3, 0, 2.6, 2.4, 0.3]],
        ['linen', [1.0, 0.3, 0.3, 2.6, 2.4, 0.55]],
        ['wood_walnut', [0.3, 0.25, 0, 1.0, 2.45, 1.1]],
        ['linen', [1.0, 0.5, 0.55, 1.4, 2.2, 0.65]],
      ],
      1,
    );
    // headboard on the bedroom 2 / 3 wall
    item(
      m,
      'Furn_bed_2',
      'bedroom_2',
      'double bed',
      [
        ['wood_ash', [1.2, 6.6, 0, 3.2, 8.0, 0.3]],
        ['fabric_blue', [1.2, 6.6, 0.3, 3.2, 8.0, 0.5]],
        ['wood_ash', [3.2, 6.55, 0, 3.44, 8.05, 1.0]],
      ],
      1,
    );
  },
};
