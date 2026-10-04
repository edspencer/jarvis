// Outside: the site (lawn, paths, driveway, the back terrace), the exterior lights, the pond, the pergola (its own
// layer, key K) and the plants: docs/demo-house.md#outside
import { Shape, type V3 } from '../geometry.ts';
import { D, EAVE, EXT, G, OVERHANG, PITCH, W, WING } from '../dims.ts';
import { hex, merged, type Model } from '../model.ts';
import { place, type Area, type Fixture, type Pin, type PlateSpec } from '../area.ts';
import { decal, ngon } from './garage/panel-model.ts';

const fixtures: Fixture[] = [
  {
    id: 'porch.lantern',
    kind: 'lantern',
    group: 'fixture.porch',
    room: 'exterior',
    at: [8.6, -EXT, 2.0],
    breaker: '25',
  },
  ...[3.6, 7.2].map((x, i) => ({
    id: `terrace.wall.${i + 1}`,
    kind: 'wall',
    group: 'fixture.terrace',
    room: 'exterior',
    at: [x, D + EXT, 2.2] as V3,
    yaw: Math.PI,
    breaker: '25',
  })),
  // a flood light high on the garage wing's north-east corner, over the back yard (the laundry's back-door switch)
  {
    id: 'exterior.flood',
    kind: 'flood_light',
    group: 'fixture.flood',
    room: 'exterior',
    at: [WING.x1 - 0.4, D + EXT, 2.7],
    yaw: Math.PI,
    breaker: '25',
  },
];

/** the heat pump's outdoor unit: on a pad behind the block's north-east corner, by the air handler's closet */
const HP = { x0: 10.45, y0: 9.65, x1: 11.35, y1: 10.55, top: 0.8 };
/** the utility meter, back to back with the main panel inside (garage/panel-model.ts: PANEL_BOX) */
const METER = { x: WING.x1 + EXT, y: 5.4, z: 1.6 };

const plates: PlateSpec[] = [
  {
    id: 'EX-O-A',
    room: 'exterior',
    kind: 'outlet',
    at: [6.5, -EXT, 0.45],
    normal: [0, -1],
    positions: [{ pos: 1, role: 'weatherproof GFCI receptacle (front)', breaker: '25' }],
    notes: 'In-use cover.',
  },
  {
    id: 'EX-O-B',
    room: 'exterior',
    kind: 'outlet',
    at: [3.8, D + EXT, 0.45],
    normal: [0, 1],
    positions: [{ pos: 1, role: 'weatherproof GFCI receptacle (terrace; the pond pump plug)', breaker: '25' }],
    notes: 'In-use cover.',
  },
];

const pins: Pin[] = [
  {
    id: 'site.irrigation',
    name: 'Irrigation controller',
    category: 'site',
    room: 'exterior',
    at: [-EXT - 0.05, 6.5, 1.3],
    make: 'Example Garden',
    model: 'IC-4',
    breaker: '27',
  },
  {
    id: 'hvac.condenser',
    name: 'Heat pump (outdoor unit)',
    category: 'hvac',
    room: 'exterior',
    at: [(HP.x0 + HP.x1) / 2, HP.y1 + 0.05, HP.top - 0.2],
    make: 'Example Air',
    model: 'HP-36',
    specs: [
      ['capacity', '3 ton, heat pump'],
      ['refrigerant', 'R-454B'],
      ['disconnect', '60 A non-fused, on the wall beside it'],
    ],
    note: 'On a pad behind the house, by the air handler in the closet under the landing.',
    breaker: '2+4',
    connections: [{ key: 'pairs_with', text: 'the air handler', refs: ['hvac.air-handler'] }],
  },
  {
    id: 'elec.meter',
    name: 'Utility meter',
    category: 'elec',
    room: 'exterior',
    at: [METER.x + 0.2, METER.y, METER.z],
    make: 'Example Utility',
    model: 'Smart meter, form 2S',
    specs: [
      ['service', '200 A, 120/240 V split phase, underground'],
      ['net metering', 'yes (the rooftop solar exports through it)'],
    ],
    note: "On the garage's east wall, back to back with the main panel inside.",
    connections: [{ key: 'feeds', text: 'the main panel', refs: ['elec.panel'] }],
  },
];

export const outside: Area = {
  id: 'outside',
  materials: {
    ex_unit: { c: hex('#d9d6cc'), rough: 0.55 },
    ex_grille: { c: hex('#4c4f52'), rough: 0.6, metal: 0.4 },
    ex_fan: { c: hex('#232527'), rough: 0.6 },
    ex_box_grey: { c: hex('#9a9d9c'), rough: 0.5, metal: 0.4 },
    ex_meter_glass: { c: hex('#e7eef0'), rough: 0.1 },
    ex_asphalt: { c: hex('#4a4b4e'), rough: 0.95 },
    ex_mailbox: { c: hex('#26292c'), rough: 0.4, metal: 0.4 },
    ex_post: { c: hex('#f1efe8'), rough: 0.6 },
    ex_brass: { c: hex('#b8963f'), rough: 0.35, metal: 0.7 },
    ex_flag: { c: hex('#c0262d'), rough: 0.5 },
    ex_solar: { c: hex('#1c2a45'), rough: 0.15, metal: 0.4 },
    ex_solar_frame: { c: hex('#c4c8cc'), rough: 0.3, metal: 0.8 },
  },
  fixtureShapes: {
    // a twin-head flood light, facing -Y before the node's yaw
    flood_light: () => {
      const s = new Shape();
      s.on('fixture_metal').box(-0.05, -0.06, -0.05, 0.05, 0, 0.05);
      for (const dx of [-0.09, 0.09]) {
        s.on('fixture_metal').box(dx - 0.065, -0.2, -0.16, dx + 0.065, -0.06, -0.05);
        s.on('led_diffuser').box(dx - 0.055, -0.205, -0.15, dx + 0.055, -0.19, -0.06);
      }
      return s;
    },
  },
  fixtures,
  plates,
  pins,
  devices: [
    {
      id: 'demo-pond-plug',
      name: 'Pond pump plug',
      integration: 'zha',
      make: 'Example Plugs',
      model: 'SP-1',
      area: 'Garden',
      place: place('area', 'garden', 'exterior', [-4.5, -3.3, 0.2], true),
      health: { avail: ['switch.pond_pump'], signal: [{ entity: 'sensor.pond_pump_rssi', kind: 'rssi' }] },
    },
  ],
  haMap: {
    'porch.lantern': { entity_id: 'light.porch', conf: 'high', group: 'fixture.porch' },
    ...Object.fromEntries(
      fixtures
        .filter((f) => f.group === 'fixture.terrace')
        .map((f) => [f.id, { entity_id: 'light.terrace_wall_lights', conf: 'high', group: f.group }]),
    ),
    // deliberately unmapped: ?ha=mock invents an entity for it
    'exterior.flood': { entity_id: null, conf: 'low', group: 'fixture.flood' },
  },
  // (not the pond: its pump's own meter, below the outside circuit, feeds it; the circuit would count over it)
  nodeFeeds: [
    ['Heat_pump', '2+4'],
    ['Roof_solar', '28+30'],
  ],
  buildMain(m) {
    site(m);
    heatPump(m);
    utilityMeter(m);
    fittings(m);
    solar(m);
    pergola(m);
    planting(m);
  },
};

/** the heat pump's outdoor unit on its pad, the line set into the wall and the disconnect beside it */
function heatPump(m: Model): void {
  const { x0, y0, x1, y1, top } = HP;
  const xc = (x0 + x1) / 2,
    yc = (y0 + y1) / 2;
  const s = new Shape();
  s.on('concrete').box(x0 - 0.1, y0 - 0.1, G.lawn, x1 + 0.1, y1 + 0.1, -0.06);
  // the cabinet: corner posts and a top, coil grilles on the four sides between them
  s.on('ex_unit').box(x0, y0, -0.06, x1, y1, top);
  const e = 0.002,
    g0 = 0.08,
    g1 = top - 0.08;
  decal(s, 'ex_grille', 'y', y0 - e, -1, x0 + 0.06, x1 - 0.06, g0, g1);
  decal(s, 'ex_grille', 'y', y1 + e, 1, x0 + 0.06, x1 - 0.06, g0, g1);
  decal(s, 'ex_grille', 'x', x0 - e, -1, y0 + 0.06, y1 - 0.06, g0, g1);
  decal(s, 'ex_grille', 'x', x1 + e, 1, y0 + 0.06, yc - 0.2, g0, g1);
  // the fan guard on top
  s.on('ex_fan').lathe(
    xc,
    yc,
    [
      [top, 0.36],
      [top + 0.03, 0.36],
    ],
    12,
  );
  s.on('ex_unit').lathe(
    xc,
    yc,
    [
      [top + 0.03, 0.08],
      [top + 0.05, 0.08],
    ],
    8,
  );
  // the service panel on the east side, the line set into the wall, the disconnect and its whip
  s.on('ex_unit').box(x1, yc - 0.15, 0.25, x1 + 0.02, y1 - 0.05, 0.65);
  s.on('ex_fan').box(x1 - 0.2, D + EXT, 0.3, x1 - 0.12, y0, 0.38);
  s.on('ex_fan').box(x1 - 0.2, D + EXT, 0.38, x1 - 0.12, D + EXT + 0.08, 0.7);
  s.on('ex_box_grey').box(11.65, D + EXT, 0.9, 11.9, D + EXT + 0.1, 1.25);
  s.on('ex_box_grey').box(11.74, D + EXT, 0.3, 11.8, D + EXT + 0.06, 0.9);
  s.on('ex_box_grey').box(11.47, D + EXT + 0.02, 0.3, 11.8, D + EXT + 0.06, 0.36);
  s.on('ex_box_grey').box(11.47, D + EXT + 0.02, 0.3, 11.51, 10.05, 0.36);
  s.on('ex_box_grey').box(x1 + 0.02, 10.0, 0.3, 11.51, 10.05, 0.36);
  m.node('Heat_pump', s, { kind: 'heat pump outdoor unit' });
}

/** the utility meter on the garage's east wall, its conduit down into the ground (the service is underground) */
function utilityMeter(m: Model): void {
  const { x, y, z } = METER;
  const s = new Shape();
  s.on('ex_box_grey').box(x, y - 0.15, z - 0.28, x + 0.12, y + 0.15, z + 0.22);
  s.on('ex_meter_glass').prism(ngon([x + 0.12, y, z], 0.085, 'x', 12), [0.11, 0, 0]);
  s.on('ex_box_grey').prism(ngon([x + 0.12, y, z], 0.1, 'x', 12), [0.02, 0, 0]);
  s.on('ex_box_grey').box(x, y - 0.03, G.lawn, x + 0.06, y + 0.03, z - 0.28);
  m.node('Utility_meter', s, { kind: 'utility meter' });
}

/** hose bibs front and back, the mailbox by the sidewalk */
function fittings(m: Model): void {
  const bib = (x: number, y: number, dir: 1 | -1): number[][] => [
    [x - 0.02, Math.min(y, y + dir * 0.1), 0.42, x + 0.02, Math.max(y, y + dir * 0.1), 0.46],
    [x - 0.015, y + dir * 0.08 - 0.015, 0.36, x + 0.015, y + dir * 0.08 + 0.015, 0.42],
    [
      x - 0.04,
      Math.min(y + dir * 0.03, y + dir * 0.05),
      0.46,
      x + 0.04,
      Math.max(y + dir * 0.03, y + dir * 0.05),
      0.48,
    ],
  ];
  merged(m, 'Hose_bibs', 'hose_bibs', [
    { name: 'Hose bib (front)', material: 'ex_brass', boxes: bib(11.8, -EXT, -1) },
    { name: 'Hose bib (back)', material: 'ex_brass', boxes: bib(14.0, D + EXT, 1) },
  ]);
  merged(m, 'Mailbox', 'mailbox', [
    { name: 'Mailbox post', material: 'ex_post', boxes: [[12.06, -9.75, G.lawn, 12.16, -9.65, 1.0]] },
    { name: 'Mailbox', material: 'ex_mailbox', boxes: [[12.0, -9.95, 1.0, 12.22, -9.45, 1.2]] },
    { name: 'Mailbox flag', material: 'ex_flag', boxes: [[12.22, -9.6, 1.05, 12.23, -9.55, 1.3]] },
  ]);
}

/** the rooftop solar array: 12 panels in two rows on the main roof's south slope (in the roof layer) */
function solar(m: Model): void {
  const t = Math.tan((PITCH * Math.PI) / 180);
  const y0 = -EXT - OVERHANG;
  const roofZ = (y: number) => EAVE + (y - y0) * t + 0.07;
  const s = new Shape();
  const n = 6,
    pw = 1.05,
    gap = 0.04;
  const x0 = (W - (n * pw + (n - 1) * gap)) / 2;
  for (const [ya, yb] of [
    [0.1, 1.3],
    [1.35, 2.55],
  ]) {
    // the row's rails, showing silver between the panels
    const xa0 = x0 - 0.02,
      xb0 = x0 + n * pw + (n - 1) * gap + 0.02;
    s.on('ex_solar_frame').prism(
      [
        [xa0, ya - 0.02, roofZ(ya) - 0.03],
        [xb0, ya - 0.02, roofZ(ya) - 0.03],
        [xb0, yb + 0.02, roofZ(yb) - 0.03],
        [xa0, yb + 0.02, roofZ(yb) - 0.03],
      ],
      [0, 0, 0.065],
    );
    for (let i = 0; i < n; i++) {
      const xa = x0 + i * (pw + gap),
        xb = xa + pw;
      s.on('ex_solar').prism(
        [
          [xa, ya, roofZ(ya)],
          [xb, ya, roofZ(ya)],
          [xb, yb, roofZ(yb)],
          [xa, yb, roofZ(yb)],
        ],
        [0, 0, 0.04],
      );
    }
  }
  m.node('Roof_solar', s, { kind: 'solar array', panels: 12, watts: 4800 });
}

/** the site: lawn, front path, driveway, back terrace (one merged node), and a small pond */
function site(m: Model): void {
  merged(m, 'Site', 'site', [
    { name: 'Lawn', material: 'lawn', boxes: [[-54, -52, G.lawn - 0.1, 66, 62, G.lawn]], extras: { kind: 'ground' } },
    { name: 'Front path', material: 'path_gravel', boxes: [[8.8, -8, G.lawn, 10.2, -EXT, -0.02]] },
    { name: 'Front step', material: 'terrace_stone', boxes: [[8.6, -1.2, G.lawn, 10.4, -EXT, 0]] },
    { name: 'Driveway', material: 'concrete', boxes: [[13.0, -8, G.lawn, 18.0, -EXT, -0.12]] },
    { name: 'Driveway apron', material: 'concrete', boxes: [[12.6, -10.4, G.lawn, 18.4, -9.2, -0.12]] },
    { name: 'Sidewalk', material: 'concrete', boxes: [[-54, -9.2, G.lawn, 66, -8, -0.12]] },
    { name: 'Street', material: 'ex_asphalt', boxes: [[-54, -18, G.lawn, 66, -10.4, -0.13]] },
    { name: 'Back terrace', material: 'terrace_stone', boxes: [[2.5, D + EXT, G.lawn, 9.5, 13.2, 0]] },
  ]);

  // a small pond (water: see-through, walked through)
  const pond = new Shape();
  pond.on('water').box(-6.4, -5, G.lawn - 0.05, -2.6, -1.6, G.lawn + 0.02);
  m.node('Pond', pond, { kind: 'pond' });
  merged(m, 'Pond_edge', 'pond_edge', [
    { name: 'Pond edge (south)', material: 'pond_stone', boxes: [[-6.7, -5.3, G.lawn, -2.3, -5, G.lawn + 0.12]] },
    { name: 'Pond edge (north)', material: 'pond_stone', boxes: [[-6.7, -1.6, G.lawn, -2.3, -1.3, G.lawn + 0.12]] },
    { name: 'Pond edge (west)', material: 'pond_stone', boxes: [[-6.7, -5, G.lawn, -6.4, -1.6, G.lawn + 0.12]] },
    { name: 'Pond edge (east)', material: 'pond_stone', boxes: [[-2.6, -5, G.lawn, -2.3, -1.6, G.lawn + 0.12]] },
  ]);
}

/** the pergola over the back terrace: the site's own layer (key K) */
function pergola(m: Model): void {
  const posts = new Shape(),
    beams = new Shape(),
    rafters = new Shape();
  const PY = [10.0, 12.8],
    PX = [3, 6, 9];
  for (const x of PX)
    for (const y of PY) posts.on('pergola_timber').box(x - 0.06, y - 0.06, 0, x + 0.06, y + 0.06, 2.45);
  for (const y of PY) beams.on('pergola_timber').box(2.7, y - 0.04, 2.45, 9.3, y + 0.04, 2.65);
  for (let x = 3; x <= 9.001; x += 0.5) rafters.on('pergola_timber').box(x - 0.025, 9.7, 2.65, x + 0.025, 13.1, 2.8);
  m.node('Pergola_posts', posts, { kind: 'pergola' });
  m.node('Pergola_beams', beams, { kind: 'pergola' });
  m.node('Pergola_rafters', rafters, { kind: 'pergola' });
}

/** plants: one group (layer: plants), a node per plant, sharing a mesh per kind */
function planting(m: Model): void {
  const tree = new Shape();
  tree.on('bark').lathe(
    0,
    0,
    [
      [0, 0.12],
      [1.6, 0.09],
    ],
    6,
  );
  tree.on('foliage').lathe(
    0,
    0,
    [
      [1.3, 0],
      [1.7, 1.0],
      [2.6, 1.35],
      [3.5, 1.0],
      [4.1, 0],
    ],
    9,
  );
  const shrub = new Shape();
  shrub.on('foliage_light').lathe(
    0,
    0,
    [
      [0, 0.3],
      [0.35, 0.55],
      [0.75, 0.45],
      [0.95, 0],
    ],
    7,
  );
  const meshes = { tree: m.mesh('plant_tree', tree), shrub: m.mesh('plant_shrub', shrub) };
  const plants = m.node('Plants', null, { layer: 'plants' });
  const PLANTS: [string, 'tree' | 'shrub', string, number, number][] = [
    ['tree.1', 'tree', 'Field maple (Acer campestre)', -5, 6],
    ['tree.2', 'tree', 'Field maple (Acer campestre)', 22, 2],
    ['tree.3', 'tree', 'Silver birch (Betula pendula)', 15, 15],
    ['shrub.1', 'shrub', 'Box (Buxus sempervirens)', 1, -1.6],
    ['shrub.2', 'shrub', 'Box (Buxus sempervirens)', 3.5, -1.6],
    ['shrub.3', 'shrub', 'Box (Buxus sempervirens)', 6, -1.6],
    ['shrub.4', 'shrub', 'Lavender (Lavandula angustifolia)', 11.6, -1.6],
    ['shrub.5', 'shrub', 'Lavender (Lavandula angustifolia)', 1.5, 12.5],
    ['shrub.6', 'shrub', 'Lavender (Lavandula angustifolia)', 10.5, 12.5],
  ];
  for (const [id, kind, species, x, y] of PLANTS)
    m.node(`Plant_${id}`, meshes[kind], { plant_id: id, species, kind }, { at: [x, y, G.lawn], parent: plants });
}
