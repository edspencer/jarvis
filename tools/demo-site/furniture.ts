import { Shape } from './geometry.ts';
import { UP } from './dims.ts';
import { Model, merged } from './model.ts';
import { fixtureShape } from './fixtures.ts';

// ------------------------------------------------------------------ furniture (an extra model, layer: furniture)
export function buildFurniture(): Model {
  const m = new Model('jarvis tools/make-demo-site.ts (furniture)');
  const item = (name: string, room: string, product: string, parts: [string, number[]][], storey = 0) => {
    const s = new Shape();
    const z = storey ? UP : 0;
    for (const [mat, b] of parts) s.on(mat).box(b[0], b[1], b[2] + z, b[3], b[4], b[5] + z);
    m.node(name, s, { room, product });
  };
  // living room
  item('Furn_sofa', 'living_room', 'three-seat sofa', [
    ['fabric_grey', [0.3, 1.2, 0.1, 1.2, 3.4, 0.45]],
    ['fabric_grey', [0.3, 1.2, 0.45, 0.5, 3.4, 0.85]],
    ['fabric_grey', [0.3, 1.0, 0.1, 1.2, 1.2, 0.6]],
    ['fabric_grey', [0.3, 3.4, 0.1, 1.2, 3.6, 0.6]],
    ['wood_walnut', [0.35, 1.05, 0, 1.15, 3.55, 0.1]],
  ]);
  item('Furn_coffee_table', 'living_room', 'oak coffee table', [
    ['wood_ash', [2.0, 1.8, 0.36, 2.7, 2.9, 0.4]],
    ['wood_ash', [2.05, 1.85, 0, 2.1, 1.9, 0.36]],
    ['wood_ash', [2.6, 1.85, 0, 2.65, 1.9, 0.36]],
    ['wood_ash', [2.05, 2.8, 0, 2.1, 2.85, 0.36]],
    ['wood_ash', [2.6, 2.8, 0, 2.65, 2.85, 0.36]],
  ]);
  item('Furn_media_unit', 'living_room', 'low media unit', [
    ['wood_walnut', [6.45, 0.4, 0, 6.9, 2.3, 0.5]],
    ['black_steel', [6.75, 0.75, 0.75, 6.8, 1.95, 1.45]],
  ]);
  item('Furn_rug', 'living_room', 'wool rug, 2 × 2.4 m', [['rug', [1.5, 1.1, 0, 3.5, 3.5, 0.012]]]);
  item('Furn_bookcase', 'living_room', 'bookcase', [
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
  item('Furn_picture', 'living_room', 'framed print', [
    ['black_steel', [0.6, 4.9, 1.25, 2.0, 4.94, 2.05]],
    ['art_print', [0.65, 4.895, 1.3, 1.95, 4.9, 2.0]],
  ]);
  // kitchen: table and four chairs (one merged node, with a parts file)
  item('Furn_dining_table', 'kitchen', 'dining table, 1.6 × 0.9 m', [
    ['wood_ash', [2.7, 6.1, 0.72, 4.3, 7.0, 0.76]],
    ['wood_ash', [2.8, 6.2, 0, 2.86, 6.26, 0.72]],
    ['wood_ash', [4.14, 6.2, 0, 4.2, 6.26, 0.72]],
    ['wood_ash', [2.8, 6.84, 0, 2.86, 6.9, 0.72]],
    ['wood_ash', [4.14, 6.84, 0, 4.2, 6.9, 0.72]],
  ]);
  const chair = (x: number, y: number, facing: 1 | -1): number[][] => [
    [x - 0.22, y - 0.22, 0.44, x + 0.22, y + 0.22, 0.48],
    [x - 0.22, facing > 0 ? y - 0.22 : y + 0.18, 0.48, x + 0.22, facing > 0 ? y - 0.18 : y + 0.22, 0.9],
    [x - 0.2, y - 0.2, 0, x - 0.17, y - 0.17, 0.44],
    [x + 0.17, y - 0.2, 0, x + 0.2, y - 0.17, 0.44],
    [x - 0.2, y + 0.17, 0, x - 0.17, y + 0.2, 0.44],
    [x + 0.17, y + 0.17, 0, x + 0.2, y + 0.2, 0.44],
  ];
  merged(
    m,
    'Furn_dining_chairs',
    'dining_chairs',
    [
      {
        name: 'Dining chair 1',
        material: 'wood_walnut',
        boxes: chair(3.1, 5.8, 1),
        extras: { product: 'dining chair' },
      },
      {
        name: 'Dining chair 2',
        material: 'wood_walnut',
        boxes: chair(3.9, 5.8, 1),
        extras: { product: 'dining chair' },
      },
      {
        name: 'Dining chair 3',
        material: 'wood_walnut',
        boxes: chair(3.1, 7.3, -1),
        extras: { product: 'dining chair' },
      },
      {
        name: 'Dining chair 4',
        material: 'wood_walnut',
        boxes: chair(3.9, 7.3, -1),
        extras: { product: 'dining chair' },
      },
    ],
    { room: 'kitchen' },
  );
  // study
  item('Furn_desk', 'study', 'desk, 1.4 × 0.7 m', [
    ['wood_ash', [8.9, 8.2, 0.72, 10.3, 8.9, 0.75]],
    ['black_steel', [8.95, 8.25, 0, 9.0, 8.85, 0.72]],
    ['black_steel', [10.2, 8.25, 0, 10.25, 8.85, 0.72]],
  ]);
  item('Furn_desk_chair', 'study', 'task chair', [
    ['black_steel', [9.35, 7.45, 0, 9.85, 7.95, 0.05]],
    ['fabric_blue', [9.35, 7.45, 0.45, 9.85, 7.95, 0.52]],
    ['fabric_blue', [9.35, 7.4, 0.52, 9.85, 7.48, 1.0]],
    ['black_steel', [9.58, 7.68, 0.05, 9.62, 7.72, 0.45]],
  ]);
  // bedrooms
  item(
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
  item(
    'Furn_bed_2',
    'bedroom_2',
    'double bed',
    [
      ['wood_ash', [4.6, 5.6, 0, 6.6, 7.0, 0.3]],
      ['fabric_blue', [4.6, 5.6, 0.3, 6.6, 7.0, 0.5]],
      ['wood_ash', [6.6, 5.55, 0, 6.85, 7.05, 1.0]],
    ],
    1,
  );
  // a lamp in the furniture model: a light fixture outside the main model
  m.node(
    'Fixture_living.floor_lamp',
    m.mesh('fixture_floor_lamp', fixtureShape('floor_lamp')),
    {
      fixture_id: 'living.floor_lamp',
      fixture_kind: 'floor lamp',
      fixture_group: 'fixture.lamp.living',
      room: 'living_room',
    },
    { at: [0.55, 4.4, 0] },
  );
  return m;
}
