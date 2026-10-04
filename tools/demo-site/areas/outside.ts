// Outside: the site (lawn, paths, driveway, the back terrace), the exterior lights, the pond, the pergola (its own
// layer, key K) and the plants: docs/demo-house.md#outside
import { Shape, type V3 } from '../geometry.ts';
import { D, EXT, G } from '../dims.ts';
import { merged, type Model } from '../model.ts';
import { place, type Area, type Fixture } from '../area.ts';

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
];

export const outside: Area = {
  id: 'outside',
  fixtures,
  pins: [
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
  ],
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
  },
  nodeFeeds: [['Pond', '25']],
  buildMain(m) {
    site(m);
    pergola(m);
    planting(m);
  },
};

/** the site: lawn, front path, driveway, back terrace (one merged node), and a small pond */
function site(m: Model): void {
  merged(m, 'Site', 'site', [
    { name: 'Lawn', material: 'lawn', boxes: [[-54, -52, G.lawn - 0.1, 66, 62, G.lawn]], extras: { kind: 'ground' } },
    { name: 'Front path', material: 'path_gravel', boxes: [[8.8, -8, G.lawn, 10.2, -EXT, -0.02]] },
    { name: 'Front step', material: 'terrace_stone', boxes: [[8.6, -1.2, G.lawn, 10.4, -EXT, 0]] },
    { name: 'Driveway', material: 'concrete', boxes: [[13.0, -8, G.lawn, 18.0, -EXT, -0.12]] },
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
