// The hall (hall, with the stair and the air-handler closet under the landing), the powder room (powder_room) and the
// study (study): docs/demo-house.md#hall-hall
//
// Hall: a console table and mirror on the west wall facing the front door, a bench with coat hooks over it left of the
// front door, a doormat; the thermostat on the powder room's wall; a video doorbell outside, its chime inside.
// Powder room (1.6 × 1.5 m, its door in the east wall swinging in against the south wall): the WC on the west wall,
// a pedestal sink with a mirror and a vanity light on the north wall, an exhaust fan. Study: the desk under the north
// window, its chair facing the window; a filing cabinet with the router on it, a bookcase on the west wall, a reading
// chair in the south-west corner turned to the room; the door (east end of the south wall) swings clear of all of it.
import { Shape, type V3 } from '../geometry.ts';
import { CEIL0, EXT, INT } from '../dims.ts';
import { hex } from '../model.ts';
import { place, type Area, type Fixture, type Pin, type PlateSpec } from '../area.ts';
import {
  alarm,
  armchair,
  bookcase,
  boxes,
  furn,
  legs,
  mergedParts,
  moved,
  put,
  sharedMesh,
  type Box,
} from './ground/kit.ts';

const fixture = (id: string, kind: string, group: string, room: string, at: V3, more: Partial<Fixture> = {}) =>
  ({ id, kind, group, room, at, breaker: '7', ...more }) as Fixture;
// a lantern on a short stem, its bottom 2.15 m up (head room in the foyer)
const hallPendant = fixture('hall.pendant', 'lantern_pendant', 'fixture.hall', 'hall', [9, 1.6, CEIL0]);
const hallCans = [
  [11.3, 0.9],
  [11.3, 2.2],
].map(([x, y], i) => fixture(`hall.can.${i + 1}`, 'can', 'fixture.hall_cans', 'hall', [x, y, CEIL0]));
const studyCeiling = fixture('study.ceiling', 'flush', 'fixture.study', 'study', [8.8, 7.3, CEIL0]);
const deskLamp = fixture('study.desk_lamp', 'desk_lamp', 'fixture.lamp.study', 'study', [8.25, 8.85, 0.76], {
  breaker: '17',
  model: 'furniture',
  yaw: -Math.PI / 2,
});
// on the north wall over the sink, facing south
const vanity = fixture('powder_room.vanity', 'sconce_bar', 'fixture.powder_room', 'powder_room', [7.85, 5.54, 1.95]);

/** a lantern pendant: a canopy, a short stem and a glazed lantern (bottom 0.55 m below the ceiling) */
function lanternPendant(): Shape {
  const s = boxes([
    ['fixture_metal', [-0.004, -0.004, -0.3, 0.004, 0.004, -0.02]],
    ['fixture_metal', [-0.13, -0.13, -0.32, 0.13, 0.13, -0.3]],
    ['fixture_metal', [-0.13, -0.13, -0.55, 0.13, 0.13, -0.53]],
    ['lantern_glass', [-0.12, -0.12, -0.53, 0.12, 0.12, -0.32]],
    ['bulb', [-0.03, -0.03, -0.47, 0.03, 0.03, -0.38]],
  ]);
  s.on('fixture_metal').lathe(0, 0, [
    [-0.02, 0.06],
    [0, 0.06],
  ]);
  return s;
}
/** a 0.5 m vanity light bar on a wall, facing -Y */
function sconceBar(): Shape {
  return boxes([
    ['fixture_metal', [-0.25, -0.05, -0.04, 0.25, 0, 0.04]],
    ['led_diffuser', [-0.24, -0.065, -0.03, 0.24, -0.05, 0.03]],
  ]);
}
/** a desk lamp: a base, a post and an arm reaching +X to a cone shade */
function deskLampShape(): Shape {
  const s = boxes([
    ['black_steel', [-0.012, -0.012, 0.02, 0.012, 0.012, 0.42]],
    ['black_steel', [-0.012, -0.012, 0.4, 0.2, 0.012, 0.42]],
  ]);
  s.on('black_steel').lathe(0, 0, [
    [0, 0.08],
    [0.02, 0.08],
  ]);
  s.on('black_steel').lathe(
    0.2,
    0,
    [
      [0.28, 0.1],
      [0.4, 0.035],
    ],
    10,
  );
  s.on('bulb').lathe(0.2, 0, [
    [0.29, 0],
    [0.31, 0.03],
    [0.34, 0],
  ]);
  return s;
}

const plate = (
  id: string,
  room: string,
  kind: 'switch' | 'outlet',
  at: V3,
  normal: [number, number],
  positions: PlateSpec['positions'],
  notes?: string,
): PlateSpec => ({ id, room, kind, at, normal, positions, ...(notes ? { notes } : {}) });
const HL_S_A = plate(
  'HL-S-A',
  'hall',
  'switch',
  [10.35, 0, 1.2],
  [0, 1],
  [
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
);
const ST_O_A = plate(
  'ST-O-A',
  'study',
  'outlet',
  [8.4, 9, 0.3],
  [0, -1],
  [{ pos: 1, role: 'desk (smart plug: monitor, computer)', breaker: '17' }],
);
const PR_W = 8.7 - INT / 2; // the powder room's east wall, its inner face
const plates: PlateSpec[] = [
  HL_S_A,
  // by the door to the garage
  plate(
    'HL-S-B',
    'hall',
    'switch',
    [12, 1.3, 1.2],
    [-1, 0],
    [{ pos: 1, role: 'hall cans', breaker: '7', fixture_ids: hallCans.map((f) => f.id), ha_entity: 'light.hall_cans' }],
  ),
  plate('HL-O-A', 'hall', 'outlet', [7 + INT / 2, 2.3, 0.3], [1, 0], [{ pos: 1, role: 'general', breaker: '5' }]),
  plate('HL-O-B', 'hall', 'outlet', [12, 0.7, 0.3], [-1, 0], [{ pos: 1, role: 'general', breaker: '5' }]),
  plate(
    'PR-S-A',
    'powder_room',
    'switch',
    [PR_W, 5.33, 1.2],
    [-1, 0],
    [
      { pos: 1, role: 'vanity light', breaker: '7', fixture_ids: [vanity.id], ha_entity: 'light.powder_room' },
      { pos: 2, role: 'exhaust fan', breaker: '7' },
    ],
    'Two-gang, inside the door on the latch side.',
  ),
  plate(
    'PR-O-A',
    'powder_room',
    'outlet',
    [8.3, 5.6 - INT / 2, 1.05],
    [0, -1],
    [{ pos: 1, role: 'by the sink (GFCI)', breaker: '23' }],
  ),
  plate(
    'ST-S-A',
    'study',
    'switch',
    [9.3, 5.6 + INT / 2, 1.2],
    [0, 1],
    [{ pos: 1, role: 'study ceiling light', breaker: '7', fixture_ids: [studyCeiling.id], ha_entity: 'light.study' }],
  ),
  ST_O_A,
  plate('ST-O-B', 'study', 'outlet', [10.6 - INT / 2, 8.2, 0.3], [-1, 0], [{ pos: 1, role: 'router', breaker: '17' }]),
  plate(
    'ST-O-C',
    'study',
    'outlet',
    [7 + INT / 2, 6.0, 0.3],
    [1, 0],
    [{ pos: 1, role: 'desk lamp, general', breaker: '17', fixture_ids: [deskLamp.id] }],
  ),
];

const thermostat: Pin = {
  id: 'hvac.thermostat',
  name: 'Thermostat',
  category: 'hvac',
  room: 'hall',
  at: [7.6, 4 - INT / 2 - 0.03, 1.5],
  make: 'Example Controls',
  model: 'T-100',
  ha: ['climate.thermostat'],
  note: "On the powder room's wall, facing the foyer.",
};
const router: Pin = {
  id: 'net.router',
  name: 'Router',
  category: 'net',
  room: 'study',
  at: [10.1, 8.72, 0.8],
  make: 'Example Networks',
  model: 'R-6',
  ha: ['device_tracker.router'],
  note: 'On the filing cabinet by the desk.',
  breaker: '17',
};
const alarmPin = (id: string, name: string, room: string, at: [number, number], ha: string, model: string): Pin => ({
  id,
  name,
  category: 'safety',
  room,
  at: [at[0], at[1], CEIL0 - 0.03],
  make: 'Example Safety',
  model,
  specs: [
    ['power', '120 V, battery backup'],
    ['interconnect', 'wired, with every alarm in the house'],
  ],
  ha: [ha],
  breaker: '26',
});
const smokeHall = alarmPin(
  'safety.smoke.hall',
  'Smoke alarm (hall)',
  'hall',
  [8.3, 2.0],
  'binary_sensor.smoke_hall',
  'SA-120',
);
const coHall = alarmPin('safety.co.hall', 'CO alarm (hall)', 'hall', [9.8, 3.5], 'binary_sensor.co_hall', 'CO-120');
const smokeStudy = alarmPin(
  'safety.smoke.study',
  'Smoke alarm (office)',
  'study',
  [9.6, 6.6],
  'binary_sensor.smoke_study',
  'SA-120',
);
const doorbell: Pin = {
  id: 'security.doorbell',
  name: 'Video doorbell',
  category: 'security',
  room: 'exterior',
  at: [10.2, -EXT - 0.03, 1.25],
  make: 'Example Security',
  model: 'DB-1',
  specs: [['power', '16 V AC, from a transformer on circuit 27']],
  ha: ['binary_sensor.doorbell'],
  note: 'Right of the front door; its chime is in the hall, on the powder room wall.',
  breaker: '27',
};

export const hall: Area = {
  id: 'hall',
  materials: {
    mirror_ground: { c: hex('#cad5d9'), rough: 0.05, metal: 0.85 },
  },
  fixtureShapes: { lantern_pendant: lanternPendant, sconce_bar: sconceBar, desk_lamp: deskLampShape },
  fixtures: [hallPendant, ...hallCans, vanity, studyCeiling, deskLamp],
  plates,
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
    smokeHall,
    coHall,
    smokeStudy,
    doorbell,
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
      id: 'demo-desk-plug',
      name: 'Desk smart plug',
      integration: 'zha',
      make: 'Example Plugs',
      model: 'SP-15',
      area: 'Study',
      place: place('plate', ST_O_A.id, 'study', ST_O_A.at),
      health: { avail: ['switch.desk_plug'], seen: ['sensor.desk_plug_power'] },
    },
    {
      id: 'demo-doorbell',
      name: 'Doorbell',
      integration: 'mqtt',
      make: 'Example Security',
      model: 'DB-1',
      area: 'Hall',
      place: place('registry', doorbell.id, 'exterior', doorbell.at),
      health: { avail: ['binary_sensor.doorbell'] },
    },
  ],
  haMap: {
    [hallPendant.id]: { entity_id: 'light.hall', conf: 'high', group: hallPendant.group },
    ...Object.fromEntries(hallCans.map((f) => [f.id, { entity_id: 'light.hall_cans', conf: 'high', group: f.group }])),
    [vanity.id]: { entity_id: 'light.powder_room', conf: 'high', group: vanity.group },
    [studyCeiling.id]: { entity_id: 'light.study', conf: 'med', group: studyCeiling.group },
    // plugged in at ST-O-C, a plain lamp: left unmapped (?ha=mock invents its entity)
    [deskLamp.id]: { entity_id: null, conf: 'low', group: deskLamp.group },
  },
  nodeFeeds: [
    ['Powder_room_fan', '7'],
    ['Doorbell', '27'],
    ['Furn_desk', '17'],
  ],
  buildMain(m) {
    // the safety alarms on the ceilings (one mesh each kind; the living room's is drawn there)
    const smoke = sharedMesh(m, 'alarm_smoke', () => alarm('smoke'));
    for (const p of [smokeHall, smokeStudy])
      m.node(`Alarm_${p.id}`, smoke, { room: p.room, pin: p.id }, { at: [p.at[0], p.at[1], CEIL0] });
    m.node(
      `Alarm_${coHall.id}`,
      alarm('co'),
      { room: 'hall', pin: coHall.id },
      { at: [coHall.at[0], coHall.at[1], CEIL0] },
    );
    // the thermostat, the doorbell (outside, right of the front door) and its chime
    const tw = 4 - INT / 2; // the powder room's south wall, the hall's side
    m.node(
      'Thermostat',
      boxes([
        ['plate_white', [7.54, tw - 0.025, 1.44, 7.66, tw, 1.56]],
        ['tv_screen', [7.57, tw - 0.026, 1.48, 7.63, tw - 0.025, 1.53], 'y-'],
      ]),
      { room: 'hall', pin: thermostat.id },
    );
    const ow = -EXT; // the south wall's outer face
    m.node(
      'Doorbell',
      boxes([
        ['black_steel', [10.17, ow - 0.03, 1.17, 10.23, ow, 1.33]],
        ['led_diffuser', [10.185, ow - 0.031, 1.19, 10.215, ow - 0.03, 1.22], 'y-'],
      ]),
      { room: 'exterior', pin: doorbell.id, kind: 'video doorbell' },
    );
    m.node('Doorbell_chime', boxes([['plate_white', [8.25, tw - 0.04, 2.14, 8.45, tw, 2.26]]]), {
      room: 'hall',
      kind: 'doorbell chime',
    });
    // the powder room: WC (on the west wall, facing east), pedestal sink and mirror (north wall), the exhaust fan
    const wc = boxes([
      ['sanitary', [7.08, 4.56, 0.4, 7.28, 5.04, 0.8]],
      ['sanitary', [7.07, 4.55, 0.8, 7.3, 5.05, 0.83]],
      ['sanitary', [7.25, 4.68, 0, 7.4, 4.92, 0.4]],
      ['kitchen_chrome', [7.2, 4.96, 0.72, 7.29, 4.99, 0.74]],
      // the sink: rim and bowl, on a pedestal
      ['sanitary', [7.6, 5.1, 0.7, 8.1, 5.16, 0.86]],
      ['sanitary', [7.6, 5.42, 0.7, 8.1, 5.54, 0.86]],
      ['sanitary', [7.6, 5.16, 0.7, 7.66, 5.42, 0.86]],
      ['sanitary', [8.04, 5.16, 0.7, 8.1, 5.42, 0.86]],
      ['sanitary', [7.66, 5.16, 0.7, 8.04, 5.42, 0.76]],
      ['kitchen_chrome', [7.835, 5.45, 0.86, 7.865, 5.5, 0.98]],
      ['kitchen_chrome', [7.835, 5.37, 0.95, 7.865, 5.45, 0.98]],
      // the mirror, framed
      ['kitchen_chrome', [7.62, 5.52, 1.1, 8.08, 5.54, 1.8]],
      ['mirror_ground', [7.64, 5.515, 1.12, 8.06, 5.52, 1.78], 'y-'],
    ]);
    // the bowl and its seat (lid down)
    wc.on('sanitary').lathe(7.52, 4.8, [
      [0, 0.12],
      [0.25, 0.14],
      [0.38, 0.19],
    ]);
    wc.on('sanitary').lathe(7.52, 4.8, [
      [0.38, 0.2],
      [0.42, 0.2],
    ]);
    wc.on('sanitary').lathe(7.85, 5.36, [
      [0, 0.11],
      [0.7, 0.07],
    ]);
    m.node('Powder_room_fittings', wc, { room: 'powder_room', kind: 'WC, pedestal sink and mirror' });
    m.node(
      'Powder_room_fan',
      boxes([
        ['plate_white', [7.47, 4.32, CEIL0 - 0.015, 7.73, 4.58, CEIL0]],
        ['black_steel', [7.5, 4.35, CEIL0 - 0.016, 7.7, 4.55, CEIL0 - 0.015], 'z-'],
      ]),
      { room: 'powder_room', kind: 'exhaust fan' },
    );
  },
  buildFurniture(m) {
    // the hall: console and mirror (west wall), bench and coat hooks (left of the front door), doormat
    mergedParts(
      m,
      'Furn_hall',
      'hall_furniture',
      [
        {
          name: 'Console table',
          boxes: [
            ['wood_walnut', [7.06, 0.95, 0.78, 7.44, 2.05, 0.81]],
            ['wood_walnut', [7.09, 0.98, 0.18, 7.41, 2.02, 0.2]],
            ...moved(legs('wood_walnut', 0.38, 1.1, 0.78, 0.035, 0.015), [7.25, 1.5, 0]),
            ['wood_walnut', [7.14, 1.6, 0.81, 7.36, 1.9, 0.84]],
          ],
          extras: { product: 'console table' },
        },
        {
          name: 'Mirror',
          boxes: [
            ['wood_walnut', [7.06, 1.08, 1.15, 7.09, 1.92, 1.95]],
            ['mirror_ground', [7.09, 1.12, 1.19, 7.095, 1.88, 1.91], 'x+'],
          ],
          extras: { product: 'wall mirror' },
        },
        {
          name: 'Bench',
          boxes: [
            ['wood_walnut', [7.35, 0.02, 0.4, 8.65, 0.42, 0.44]],
            ['wood_walnut', [7.38, 0.04, 0, 7.42, 0.4, 0.4]],
            ['wood_walnut', [8.58, 0.04, 0, 8.62, 0.4, 0.4]],
            ['wood_walnut', [7.42, 0.04, 0.12, 8.58, 0.4, 0.14]],
            ['fabric_grey', [7.4, 0.04, 0.44, 8.6, 0.4, 0.49]],
          ],
          extras: { product: 'entry bench' },
        },
        {
          name: 'Coat hooks',
          boxes: [
            ['wood_walnut', [7.4, 0, 1.62, 8.6, 0.025, 1.72]],
            ...[7.6, 7.95, 8.3].map((x): Box => ['black_steel', [x, 0.025, 1.64, x + 0.02, 0.08, 1.67]]),
            ['fabric_blue', [7.48, 0.03, 0.95, 7.76, 0.16, 1.62]],
            ['fabric_grey', [8.17, 0.03, 1.08, 8.43, 0.14, 1.62]],
          ],
          extras: { product: 'coat rail, two coats' },
        },
        { name: 'Doormat', boxes: [['fabric_grey', [9.1, 0.1, 0, 9.9, 0.7, 0.012]]], extras: { product: 'doormat' } },
      ],
      { room: 'hall' },
    );
    // the study: the desk under the window (its chair facing the window), the monitor, keyboard and computer on it
    // (one node: the desk's smart plug feeds it)
    furn(m, 'Furn_desk', 'study', 'desk 1.4 × 0.7 m, monitor, keyboard, computer', [
      ['wood_ash', [8.1, 8.28, 0.73, 9.5, 8.98, 0.76]],
      ['black_steel', [8.12, 8.33, 0, 8.16, 8.93, 0.73]],
      ['black_steel', [9.44, 8.33, 0, 9.48, 8.93, 0.73]],
      ['black_steel', [8.16, 8.9, 0.5, 9.44, 8.93, 0.73]],
      // monitor: stand, neck, screen
      ['black_steel', [8.72, 8.7, 0.76, 8.98, 8.86, 0.775]],
      ['black_steel', [8.83, 8.8, 0.775, 8.87, 8.83, 0.98]],
      ['black_steel', [8.5, 8.75, 0.92, 9.2, 8.8, 1.34]],
      ['tv_screen', [8.515, 8.749, 0.935, 9.185, 8.75, 1.325], 'y-'],
      ['black_steel', [8.6, 8.42, 0.76, 9.05, 8.56, 0.775]],
      ['black_steel', [9.12, 8.45, 0.76, 9.18, 8.55, 0.785]],
      // the computer, on the floor under the desk's east end
      ['black_steel', [9.15, 8.45, 0, 9.35, 8.9, 0.45]],
    ]);
    // the rest of the study, one merged node: the desk chair (facing the window), the filing cabinet with the router
    mergedParts(
      m,
      'Furn_study',
      'study_furniture',
      [
        {
          name: 'Desk chair',
          boxes: [
            ['fabric_blue', [8.55, 7.72, 0.45, 9.05, 8.2, 0.52]],
            ['fabric_blue', [8.57, 7.64, 0.56, 9.03, 7.72, 1.05]],
            ['black_steel', [8.78, 7.92, 0.08, 8.82, 7.96, 0.45]],
            ['black_steel', [8.78, 7.67, 0.5, 8.82, 7.72, 0.62]],
            ['black_steel', [8.5, 7.91, 0, 9.1, 7.97, 0.08]],
            ['black_steel', [8.77, 7.64, 0, 8.83, 8.24, 0.08]],
          ],
          extras: { product: 'task chair' },
        },
        {
          name: 'Filing cabinet',
          boxes: [
            ['wood_ash', [9.65, 8.45, 0, 10.45, 8.98, 0.72]],
            ['black_steel', [9.66, 8.449, 0.355, 10.44, 8.45, 0.365], 'y-'],
            ['black_steel', [9.95, 8.43, 0.6, 10.15, 8.45, 0.62]],
            ['black_steel', [9.95, 8.43, 0.24, 10.15, 8.45, 0.26]],
          ],
          extras: { product: 'lateral filing cabinet, two drawers' },
        },
        {
          name: 'Router',
          boxes: [
            ['black_steel', [9.95, 8.62, 0.72, 10.25, 8.82, 0.76]],
            ['black_steel', [9.97, 8.78, 0.76, 9.985, 8.795, 0.92]],
            ['black_steel', [10.215, 8.78, 0.76, 10.23, 8.795, 0.92]],
          ],
          extras: { product: 'router (Example Networks R-6)' },
        },
      ],
      { room: 'study' },
    );
    put(
      m,
      'Furn_study_bookcase',
      sharedMesh(m, 'bookcase', () => boxes(bookcase())),
      { room: 'study', product: 'bookcase' },
      [7 + INT / 2 + 0.18, 7.8, 0],
      90,
    );
    put(
      m,
      'Furn_study_chair',
      sharedMesh(m, 'armchair', armchair),
      { room: 'study', product: 'reading chair' },
      [7.75, 6.35, 0],
      135,
    );
  },
};
