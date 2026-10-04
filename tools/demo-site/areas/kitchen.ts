// The kitchen and dining (kitchen): docs/demo-house.md#kitchen-and-dining-kitchen
import type { V3 } from '../geometry.ts';
import { CEIL0, INT } from '../dims.ts';
import { item, merged } from '../model.ts';
import { place, type Area, type Fixture, type PlateSpec } from '../area.ts';

const pendants: Fixture[] = [2, 3.5, 5].map((x, i) => ({
  id: `kitchen.pendant.${i + 1}`,
  kind: 'pendant',
  group: 'fixture.pendants.kitchen',
  room: 'kitchen',
  at: [x, 7, CEIL0] as V3,
  breaker: '7',
}));

const KT_S_A: PlateSpec = {
  id: 'KT-S-A',
  room: 'kitchen',
  kind: 'switch',
  at: [4.6, 5 + INT / 2, 1.2],
  normal: [0, 1],
  positions: [{ pos: 1, role: 'kitchen pendants', breaker: '7', fixture_ids: pendants.map((f) => f.id) }],
};

export const kitchen: Area = {
  id: 'kitchen',
  fixtures: pendants,
  plates: [KT_S_A],
  pins: [
    {
      id: 'appliance.fridge',
      name: 'Fridge-freezer',
      category: 'appliance',
      room: 'kitchen',
      at: [6.6, 8.6, 1.0],
      make: 'Example Appliances',
      model: 'FF-70',
      breaker: '11',
    },
    {
      id: 'fixture.kitchen-pendants',
      name: 'Kitchen pendants',
      category: 'fixture',
      room: 'kitchen',
      at: [3.5, 7, CEIL0 - 0.7],
      fixtures: pendants.map((f) => f.id),
      ha: pendants.map((_, i) => `light.kitchen_pendant_${i + 1}`),
      breaker: '7',
    },
  ],
  devices: [
    ...pendants.map((f, k) => {
      const i = k + 1;
      return {
        id: `demo-kitchen-pendant-${i}`,
        name: `Kitchen pendant ${i}`,
        integration: 'hue',
        make: 'Example Lighting',
        model: 'A19 bulb',
        area: 'Kitchen',
        place: place('fixture', f.id, 'kitchen', f.at),
        fixtures: [f.id],
        unavailable_means: {
          off: `the kitchen pendants wall switch (${KT_S_A.id})`,
          unless_on: [1, 2, 3].filter((j) => j !== i).map((j) => `light.kitchen_pendant_${j}`),
        },
        health: { avail: [`light.kitchen_pendant_${i}`], update: [`update.kitchen_pendant_${i}_firmware`] },
      };
    }),
    {
      id: 'demo-leak-sensor',
      name: 'Leak sensor (kitchen sink)',
      integration: 'zha',
      make: 'Example Sensors',
      model: 'WL-1',
      area: 'Kitchen',
      place: place('area', 'kitchen', 'kitchen', [1.5, 8.7, 0.1]),
      health: { avail: ['binary_sensor.kitchen_leak'], battery: ['sensor.kitchen_leak_battery'] },
    },
  ],
  haMap: Object.fromEntries(
    pendants.map((f, i) => [
      f.id,
      { entity_id: `light.kitchen_pendant_${i + 1}`, conf: 'high', group: f.group, unavailable_means: 'off' },
    ]),
  ),
  // the counter outlets, and the range (not modelled yet)
  nodeFeeds: [
    ['Kitchen_units', '9'],
    ['Kitchen_units', '1+3'],
  ],
  buildMain(m) {
    merged(
      m,
      'Kitchen_units',
      'kitchen_units',
      [
        { name: 'Base units (west)', material: 'cabinet', boxes: [[0, 5.6, 0, 0.6, 8.9, 0.86]] },
        { name: 'Worktop (west)', material: 'worktop', boxes: [[0, 5.6, 0.86, 0.62, 8.9, 0.9]] },
        { name: 'Base units (north)', material: 'cabinet', boxes: [[0.6, 8.4, 0, 4.2, 9, 0.86]] },
        { name: 'Worktop (north)', material: 'worktop', boxes: [[0.6, 8.38, 0.86, 4.2, 9, 0.9]] },
        { name: 'Tall unit (fridge)', material: 'cabinet', boxes: [[6.3, 8.3, 0, 6.94, 9, 2.1]] },
      ],
      { room: 'kitchen' },
    );
  },
  buildFurniture(m) {
    // table and four chairs (the chairs one merged node, with a parts file)
    item(m, 'Furn_dining_table', 'kitchen', 'dining table, 1.6 × 0.9 m', [
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
      (
        [
          [3.1, 5.8, 1],
          [3.9, 5.8, 1],
          [3.1, 7.3, -1],
          [3.9, 7.3, -1],
        ] as const
      ).map(([x, y, f], i) => ({
        name: `Dining chair ${i + 1}`,
        material: 'wood_walnut',
        boxes: chair(x, y, f),
        extras: { product: 'dining chair' },
      })),
      { room: 'kitchen' },
    );
  },
};
