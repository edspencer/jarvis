// The garage wing: the garage (garage) and the laundry / mudroom (laundry), with the electrical service's inside half
// (the main panel and the energy monitor), the water heater, the EV charger, the battery and the PV inverter:
// docs/demo-house.md#garage-garage. The geometry is in garage/build.ts and garage/panel-model.ts.
import { Shape, type V3 } from '../geometry.ts';
import { D, WING } from '../dims.ts';
import { hex } from '../model.ts';
import { PANEL, SCHEDULE, breakerText, circuit, type Circuit } from '../panel.ts';
import { place, type Area, type Fixture, type Pin, type PlateSpec } from '../area.ts';
import { REPO } from '../manifest.ts';
import { AT, buildGarageFurniture, buildGarageMain } from './garage/build.ts';
import { MONITOR_BOX, PANEL_BOX, panelAndMonitor } from './garage/panel-model.ts';

const z = (h: number) => WING.z + h;
const E = WING.x1,
  Wx = WING.x0,
  CEIL = WING.ceil;

// ------------------------------------------------------------------ lights
const shop: Fixture[] = (
  [
    [14.2, 3.0],
    [17.0, 2.6],
    [17.0, 7.7],
  ] as const
).map(([x, y], i) => ({
  id: `garage.shop.${i + 1}`,
  kind: 'shop_light',
  group: 'fixture.garage',
  room: 'garage',
  at: [x, y, CEIL] as V3,
  breaker: '24',
}));
const laundryLight: Fixture = {
  id: 'laundry.ceiling',
  kind: 'flush',
  group: 'fixture.laundry',
  room: 'laundry',
  at: [13.8, 7.9, CEIL],
  breaker: '24',
};
/** the coach lights each side of the garage door, on the wing's south wall outside (on the outside circuit, 25,
 * switched from the garage) */
const coach: Fixture[] = [12.65, 18.45].map((x, i) => ({
  id: `garage.coach.${i + 1}`,
  kind: 'lantern',
  group: 'fixture.coach',
  room: 'exterior',
  at: [x, -0.25, z(1.95)] as V3,
  breaker: '25',
}));

// ------------------------------------------------------------------ wall plates
const plates: PlateSpec[] = [
  {
    id: 'GA-S-A',
    room: 'garage',
    kind: 'switch',
    at: [Wx, 2.62, z(1.2)],
    normal: [1, 0],
    positions: [
      {
        pos: 1,
        role: 'shop lights (three-way with GA-S-B)',
        breaker: '24',
        fixture_ids: shop.map((f) => f.id),
        ha_entity: 'switch.garage_lights',
        link: { box: 'GA-S-B', pos: 1, dir: 'with' },
      },
      {
        pos: 2,
        role: 'coach lights',
        breaker: '25',
        fixture_ids: coach.map((f) => f.id),
        ha_entity: 'light.coach_lights',
      },
    ],
    notes: 'By the door to the hall; the door opener button is beside it.',
  },
  {
    id: 'GA-S-B',
    room: 'garage',
    kind: 'switch',
    at: [14.2, 6.6 - 0.06, z(1.2)],
    normal: [0, -1],
    positions: [
      {
        pos: 1,
        role: 'shop lights (three-way with GA-S-A)',
        breaker: '24',
        fixture_ids: shop.map((f) => f.id),
        ha_entity: 'switch.garage_lights',
        link: { box: 'GA-S-A', pos: 1, dir: 'with' },
      },
    ],
  },
  {
    id: 'GA-O-A',
    room: 'garage',
    kind: 'outlet',
    at: [Wx, 3.85, z(1.05)],
    normal: [1, 0],
    positions: [{ pos: 1, role: 'GFCI receptacle (chest freezer)', breaker: '24' }],
  },
  {
    id: 'GA-O-B',
    room: 'garage',
    kind: 'outlet',
    at: [16.2, D, z(1.08)],
    normal: [0, -1],
    positions: [{ pos: 1, role: 'GFCI receptacle (workbench)', breaker: '24' }],
  },
  {
    id: 'GA-O-C',
    room: 'garage',
    kind: 'outlet',
    at: [E, 1.0, z(1.05)],
    normal: [-1, 0],
    positions: [{ pos: 1, role: 'GFCI receptacle', breaker: '24' }],
  },
  {
    id: 'LA-S-A',
    room: 'laundry',
    kind: 'switch',
    at: [14.2, 6.6 + 0.06, z(1.2)],
    normal: [0, 1],
    positions: [
      { pos: 1, role: 'laundry light', breaker: '24', fixture_ids: [laundryLight.id], ha_entity: 'light.laundry' },
    ],
  },
  {
    id: 'LA-S-B',
    room: 'laundry',
    kind: 'switch',
    at: [Wx, 8.62, z(1.2)],
    normal: [1, 0],
    positions: [
      { pos: 1, role: 'back flood light', breaker: '25', fixture_ids: ['exterior.flood'], ha_entity: 'light.flood' },
    ],
    notes: 'By the back door.',
  },
  {
    id: 'LA-O-A',
    room: 'laundry',
    kind: 'outlet',
    at: [(AT.washer.x0 + AT.washer.x1) / 2, 6.6 + 0.06, z(1.15)],
    normal: [0, 1],
    positions: [{ pos: 1, role: 'washer receptacle', breaker: '22' }],
  },
  {
    id: 'LA-O-B',
    room: 'laundry',
    kind: 'outlet',
    at: [13.6, 6.6 + 0.06, z(1.15)],
    normal: [0, 1],
    positions: [{ pos: 1, role: 'dryer receptacle (NEMA 14-30, 240 V)', breaker: '14+16' }],
  },
  {
    id: 'LA-O-C',
    room: 'laundry',
    kind: 'outlet',
    at: [15.4 - 0.06, 8.5, z(1.1)],
    normal: [-1, 0],
    positions: [{ pos: 1, role: 'GFCI receptacle (by the sink)', breaker: '22' }],
  },
];

// ------------------------------------------------------------------ registry pins
const rating = (c: Circuit) =>
  `${c.amps} A ${c.volts} V${c.protection ? ` ${c.protection === 'dual' ? 'AFCI/GFCI' : c.protection}` : ''}`;
const usedSpaces = SCHEDULE.flatMap((c) => [c.breaker].flat()).length;
const panel: Pin = {
  id: 'elec.panel',
  name: 'Main panel',
  category: 'elec',
  room: 'garage',
  at: [E - PANEL_BOX.depth - 0.02, (PANEL_BOX.y0 + PANEL_BOX.y1) / 2, PANEL_BOX.z1 - 0.15],
  make: 'Example Electric',
  model: 'LP-40',
  specs: [
    ['main', `${PANEL.main_amps} A, 2-pole, at the top`],
    ['spaces', `${PANEL.spaces}: odd on the left, even on the right; ${PANEL.spaces - usedSpaces} spare`],
    ['service', '120/240 V split phase, underground, from the meter outside on this wall'],
    // the schedule, as on the card inside the door: breaker, circuit, rating, the monitor's clamp
    ...SCHEDULE.map((c): [string, string] => [
      `breaker ${breakerText(c)}`,
      `${c.label} · ${rating(c)} · ${c.source ? 'source' : c.ct ? `CT ${c.ct}` : 'no CT (in the Balance)'}`,
    ]),
  ],
  note: 'On the east wall, back to back with the utility meter outside; drawn with its door open.',
  connections: [
    { key: 'fed_from', text: 'the utility meter', refs: ['elec.meter'] },
    { key: 'monitored_by', text: 'the energy monitor', refs: ['elec.energy-monitor'] },
  ],
  documents: [
    { text: 'Panel schedule (docs/demo-house.md)', url: `${REPO}/blob/main/docs/demo-house.md#panel-schedule` },
    { text: 'LP-40 manual (example)', url: null },
  ],
};
const monitor: Pin = {
  id: 'elec.energy-monitor',
  name: 'Energy monitor',
  category: 'elec',
  room: 'garage',
  at: [E - MONITOR_BOX.depth - 0.02, (MONITOR_BOX.y0 + MONITOR_BOX.y1) / 2, (MONITOR_BOX.z0 + MONITOR_BOX.z1) / 2],
  make: 'Example Energy',
  model: 'EM-16 (16-circuit monitor)',
  ha: ['binary_sensor.vue2_status', 'sensor.vue2_phase_a_power', 'sensor.vue2_phase_b_power'],
  specs: [
    ['mains clamps', '2 × 200 A, phase A and phase B'],
    ['circuit clamps', `16 × 50 A: ${SCHEDULE.filter((c) => c.ct).length} in use (see the panel's schedule)`],
    ['supply', `2-pole 15 A breaker, ${breakerText(circuit('circuit.monitor'))}`],
    ['network', 'Wi-Fi; ESPHome firmware, a reading every 5 s'],
    ['entities', 'sensor.vue2_<circuit>_power, sensor.vue2_<circuit>_energy_today, sensor.vue2_balance_power'],
  ],
  note:
    'Stands in for an Emporia Vue 2, in a small box beside the panel, joined to it by a conduit nipple; its clamps ' +
    'are on the conductors inside the panel. A 240 V circuit has one clamp, on one leg, doubled in the settings. Its ' +
    'readings reach Home Assistant through ESPHome (local) or the Emporia Vue integration from HACS (cloud).',
  breaker: '32+34',
  connections: [{ key: 'monitors', text: 'the main panel', refs: ['elec.panel'] }],
};

const pins: Pin[] = [
  panel,
  monitor,
  {
    id: 'plumb.water-heater',
    name: 'Water heater',
    category: 'plumb',
    room: 'garage',
    at: [AT.waterHeater[0] + 0.3, AT.waterHeater[1], z(1.2)],
    make: 'Example Water',
    model: 'WH-50',
    specs: [
      ['capacity', '50 gal'],
      ['elements', '2 × 4500 W (one at a time), 240 V'],
      ['expansion tank', '2 gal, on the cold line'],
    ],
    note: 'On a stand in the corner by the laundry door.',
    breaker: '10+12',
  },
  {
    id: 'plumb.stopcock',
    name: 'Main shut-off valve',
    category: 'plumb',
    room: 'garage',
    at: AT.stopcock,
    specs: [['valve', '1 in full-port ball valve']],
    note: 'Where the water main comes up through the slab, by the water heater.',
  },
  {
    id: 'elec.ev-charger',
    name: 'EV charger',
    category: 'elec',
    room: 'garage',
    at: [E - 0.13, (AT.charger.y0 + AT.charger.y1) / 2, z(1.25)],
    make: 'Example Charging',
    model: 'L2-40',
    ha: ['switch.ev_charger', 'sensor.ev_charger_status'],
    specs: [
      ['level', '2 (240 V)'],
      ['current', '40 A (9.6 kW), set to 30 A (7.2 kW)'],
      ['cable', '7.5 m'],
    ],
    breaker: '18+20',
  },
  {
    id: 'elec.battery',
    name: 'Home battery',
    category: 'elec',
    room: 'garage',
    at: [E - 0.18, (AT.battery.y0 + AT.battery.y1) / 2, z(0.8)],
    make: 'Example Storage',
    model: 'HB-13',
    ha: ['sensor.battery_power', 'sensor.battery_level'],
    specs: [
      ['capacity', '13.5 kWh'],
      ['power', '5 kW continuous'],
    ],
    note: 'AC-coupled, on the PV breaker (28+30) with the inverter.',
    connections: [{ key: 'charged_by', text: 'the PV inverter', refs: ['elec.inverter'] }],
  },
  {
    id: 'elec.inverter',
    name: 'PV inverter',
    category: 'elec',
    room: 'garage',
    at: [E - 0.2, (AT.inverter.y0 + AT.inverter.y1) / 2, z(1.45)],
    make: 'Example Solar',
    model: 'SI-5',
    ha: ['sensor.solar_power', 'sensor.solar_energy_today'],
    specs: [
      ['rating', '5 kW AC'],
      ['array', '12 × 400 W on the main roof, south slope'],
    ],
    note: 'Back-feeds the main panel through the 2-pole breaker in spaces 28+30.',
    breaker: '28+30',
    connections: [{ key: 'feeds', text: 'the main panel (back-fed)', refs: ['elec.panel'] }],
  },
  {
    id: 'appliance.garage-door',
    name: 'Garage door opener',
    category: 'appliance',
    room: 'garage',
    at: [15.5, 3.85, CEIL - 0.32],
    make: 'Example Doors',
    model: 'GO-500',
    ha: ['cover.garage_door'],
    specs: [
      ['drive', 'belt, 1/2 hp'],
      ['door', '16 × 7 ft sectional, four panels'],
    ],
    breaker: '24',
  },
  {
    id: 'appliance.washer',
    name: 'Washer',
    category: 'appliance',
    room: 'laundry',
    at: [(AT.washer.x0 + AT.washer.x1) / 2, AT.appliancesY[1] + 0.05, z(0.75)],
    make: 'Example Home',
    model: 'FL-45',
    specs: [['type', 'front-load, 4.5 cu ft']],
    breaker: '22',
  },
  {
    id: 'appliance.dryer',
    name: 'Dryer',
    category: 'appliance',
    room: 'laundry',
    at: [(AT.dryer.x0 + AT.dryer.x1) / 2, AT.appliancesY[1] + 0.05, z(0.75)],
    make: 'Example Home',
    model: 'ED-74',
    specs: [
      ['type', 'electric, 7.4 cu ft'],
      ['vent', '4 in, up through the roof'],
    ],
    breaker: '14+16',
  },
];

// ------------------------------------------------------------------ the area
export const garage: Area = {
  id: 'garage',
  materials: {
    ga_panel_grey: { c: hex('#8d9195'), rough: 0.45, metal: 0.5 },
    ga_panel_front: { c: hex('#c6c9cb'), rough: 0.5, metal: 0.3 },
    ga_breaker: { c: hex('#232427'), rough: 0.5 },
    ga_label_card: { c: hex('#f7f3e6'), rough: 0.8 },
    ga_label_ink: { c: hex('#3e4652'), rough: 0.8 },
    ga_monitor: { c: hex('#e6e6e1'), rough: 0.5 },
    ga_brand_band: { c: hex('#2f6d5a'), rough: 0.5 },
    ga_led: { c: hex('#4ee07a'), rough: 0.2 },
    ga_conduit: { c: hex('#a3a7ab'), rough: 0.4, metal: 0.6 },
    ga_steel: { c: hex('#7c8186'), rough: 0.45, metal: 0.6 },
    ga_tank: { c: hex('#ecebe4'), rough: 0.35 },
    ga_copper: { c: hex('#b8733a'), rough: 0.35, metal: 0.7 },
    ga_valve_red: { c: hex('#c0392b'), rough: 0.5 },
    ga_expansion: { c: hex('#5b80a8'), rough: 0.4, metal: 0.3 },
    ga_charger_white: { c: hex('#f1f1ef'), rough: 0.3 },
    ga_charger_black: { c: hex('#26282b'), rough: 0.3 },
    ga_battery: { c: hex('#f4f4f2'), rough: 0.25 },
    ga_inverter: { c: hex('#6c7176'), rough: 0.45, metal: 0.3 },
    ga_opener: { c: hex('#dcdad4'), rough: 0.5 },
    ga_appliance: { c: hex('#f4f4f2'), rough: 0.3 },
    ga_chrome: { c: hex('#c9cdd1'), rough: 0.2, metal: 0.85 },
    ga_door_glass: { c: hex('#2a3540'), rough: 0.08 },
    ga_duct: { c: hex('#c9cbce'), rough: 0.35, metal: 0.7 },
    ga_toolbox: { c: hex('#b3261e'), rough: 0.4, metal: 0.3 },
    ga_tote_blue: { c: hex('#3c6ea8'), rough: 0.6 },
    ga_tote_grey: { c: hex('#8b9095'), rough: 0.6 },
    ga_bin: { c: hex('#3f4a43'), rough: 0.7 },
    ga_tyre: { c: hex('#1b1b1c'), rough: 0.9 },
    ga_hub: { c: hex('#b8bcc0'), rough: 0.3, metal: 0.8 },
    ga_car_paint: { c: hex('#264e78'), rough: 0.25, metal: 0.5 },
    ga_car_glass: { c: hex('#1b232b'), rough: 0.05, metal: 0.2 },
    ga_headlight: { c: hex('#eef3f7'), rough: 0.1 },
    ga_tail: { c: hex('#b0151c'), rough: 0.2 },
  },
  fixtureShapes: {
    // an LED shop light: a 1.2 m strip hung on two short chains, along Y
    shop_light: () => {
      const s = new Shape();
      s.on('fixture_metal').box(-0.005, -0.45, -0.18, 0.005, -0.44, 0);
      s.on('fixture_metal').box(-0.005, 0.44, -0.18, 0.005, 0.45, 0);
      s.on('fixture_trim').box(-0.07, -0.6, -0.22, 0.07, 0.6, -0.18);
      s.on('led_diffuser').box(-0.055, -0.58, -0.23, 0.055, 0.58, -0.22);
      return s;
    },
  },
  fixtures: [...shop, laundryLight, ...coach],
  plates,
  pins,
  devices: [
    {
      id: 'demo-energy-monitor',
      name: 'Energy monitor',
      integration: 'esphome',
      make: 'Example Energy',
      model: 'EM-16',
      area: 'Garage',
      place: place('registry', monitor.id, 'garage', monitor.at),
      health: {
        avail: ['binary_sensor.vue2_status', 'sensor.vue2_phase_a_power'],
        signal: [{ entity: 'sensor.vue2_wifi_signal', kind: 'rssi' }],
        update: ['update.vue2_firmware'],
      },
    },
    {
      id: 'demo-garage-door',
      name: 'Garage door opener',
      integration: 'mqtt',
      make: 'Example Doors',
      model: 'GO-500',
      area: 'Garage',
      place: place('registry', 'appliance.garage-door', 'garage', [15.5, 3.85, CEIL - 0.32]),
      health: { avail: ['cover.garage_door'] },
    },
    // deliberately not placed (no HA area, no hint): the faults plugin lists it as "not placed"
    {
      id: 'demo-freezer-plug',
      name: 'Freezer smart plug',
      integration: 'zha',
      make: 'Example Plugs',
      model: 'SP-15',
      area: null,
      place: null,
      health: { avail: ['switch.freezer_plug'], seen: ['sensor.freezer_plug_power'] },
    },
    {
      id: 'demo-laundry-leak',
      name: 'Leak sensor (laundry)',
      integration: 'zha',
      make: 'Example Sensors',
      model: 'WL-1',
      area: 'Laundry',
      place: place('area', 'laundry', 'laundry', [13.065, AT.appliancesY[1] - 0.15, z(0.02)]),
      health: {
        avail: ['binary_sensor.laundry_leak'],
        battery: ['sensor.laundry_leak_battery'],
        signal: [{ entity: 'sensor.laundry_leak_lqi', kind: 'lqi' }],
      },
    },
  ],
  haMap: {
    ...Object.fromEntries(shop.map((f) => [f.id, { entity_id: 'switch.garage_lights', conf: 'high', group: f.group }])),
    // deliberately unmapped: ?ha=mock invents an entity for it
    [laundryLight.id]: { entity_id: null, conf: 'low', group: laundryLight.group },
    ...Object.fromEntries(coach.map((f) => [f.id, { entity_id: 'light.coach_lights', conf: 'high', group: f.group }])),
  },
  // (the panel and the monitor are fed by the panel's own meter, in energy.ts)
  nodeFeeds: [
    ['Water_heater', '10+12'],
    ['EV_charger', '18+20'],
    ['Furn_car', '18+20'],
    ['Garage_door_opener', '24'],
    ['Chest_freezer', '24'],
    ['Washer', '22'],
    ['Dryer', '14+16'],
    ['Home_battery', '28+30'],
    ['PV_inverter', '28+30'],
  ],
  buildMain(m) {
    panelAndMonitor(m);
    buildGarageMain(m);
  },
  buildFurniture(m) {
    buildGarageFurniture(m);
  },
};
