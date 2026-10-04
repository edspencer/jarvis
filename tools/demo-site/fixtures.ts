import { Shape, type V3 } from './geometry.ts';
import { CEIL0, CEIL1, D, EXT, UP } from './dims.ts';

// ------------------------------------------------------------------ fixtures
export interface Fixture {
  id: string;
  kind: 'can' | 'pendant' | 'flush' | 'bar' | 'lantern' | 'wall' | 'floor_lamp';
  group: string;
  room: string;
  at: V3;
  /** wall fixtures: the direction they face (yaw, radians, about plan Z: 0 = facing plan -Y... see fixtureShape) */
  yaw?: number;
}
export const FIXTURES: Fixture[] = [
  ...[
    [2, 1.5],
    [5, 1.5],
    [2, 3.5],
    [5, 3.5],
  ].map(([x, y], i) => ({
    id: `living.can.${i + 1}`,
    kind: 'can' as const,
    group: 'fixture.cans.living',
    room: 'living_room',
    at: [x, y, CEIL0] as V3,
  })),
  ...[2, 3.5, 5].map((x, i) => ({
    id: `kitchen.pendant.${i + 1}`,
    kind: 'pendant' as const,
    group: 'fixture.pendants.kitchen',
    room: 'kitchen',
    at: [x, 7, CEIL0] as V3,
  })),
  { id: 'hall.pendant', kind: 'pendant', group: 'fixture.hall', room: 'hall', at: [9, 1.6, CEIL0] },
  { id: 'study.ceiling', kind: 'flush', group: 'fixture.study', room: 'study', at: [8.8, 6.5, CEIL0] },
  { id: 'bedroom_1.ceiling', kind: 'flush', group: 'fixture.bedroom_1', room: 'bedroom_1', at: [3.5, 2.5, CEIL1] },
  { id: 'bedroom_2.ceiling', kind: 'flush', group: 'fixture.bedroom_2', room: 'bedroom_2', at: [3.5, 7, CEIL1] },
  { id: 'landing.ceiling', kind: 'flush', group: 'fixture.landing', room: 'landing', at: [8.8, 6, CEIL1] },
  // a 1.3 m vanity bar: the viewer lights anything longer than 1.2 m as a line of lights
  { id: 'bathroom.vanity', kind: 'bar', group: 'fixture.bathroom', room: 'bathroom', at: [9.8, 0.05, UP + 2.0] },
  { id: 'porch.lantern', kind: 'lantern', group: 'fixture.porch', room: 'exterior', at: [8.6, -EXT, 2.0] },
  ...[3.6, 7.2].map((x, i) => ({
    id: `terrace.wall.${i + 1}`,
    kind: 'wall' as const,
    group: 'fixture.terrace',
    room: 'exterior',
    at: [x, D + EXT, 2.2] as V3,
    yaw: Math.PI,
  })),
];

/** a fixture's shape, about its mounting point (plan frame, before the node's yaw) */
export function fixtureShape(kind: Fixture['kind']): Shape {
  const s = new Shape();
  switch (kind) {
    case 'can':
      s.on('fixture_trim').lathe(0, 0, [
        [-0.012, 0.085],
        [0, 0.085],
      ]);
      s.on('lens').lathe(0, 0, [
        [-0.016, 0.06],
        [-0.012, 0.06],
      ]);
      break;
    case 'pendant':
      s.on('fixture_metal').lathe(0, 0, [
        [-0.03, 0.06],
        [0, 0.06],
      ]);
      s.on('fixture_metal').box(-0.005, -0.005, -0.62, 0.005, 0.005, -0.03);
      s.on('lamp_shade').lathe(
        0,
        0,
        [
          [-0.9, 0.17],
          [-0.75, 0.13],
          [-0.62, 0.04],
        ],
        12,
      );
      s.on('bulb').lathe(0, 0, [
        [-0.8, 0.0],
        [-0.77, 0.035],
        [-0.72, 0.035],
        [-0.68, 0.0],
      ]);
      break;
    case 'flush':
      s.on('fixture_trim').lathe(0, 0, [
        [-0.02, 0.19],
        [0, 0.19],
      ]);
      s.on('globe').lathe(
        0,
        0,
        [
          [-0.1, 0],
          [-0.09, 0.1],
          [-0.06, 0.16],
          [-0.02, 0.17],
        ],
        12,
      );
      break;
    case 'bar':
      // on the south wall, facing north (+Y)
      s.on('fixture_metal').box(-0.65, 0, -0.04, 0.65, 0.05, 0.04);
      s.on('led_diffuser').box(-0.63, 0.05, -0.03, 0.63, 0.07, 0.03);
      break;
    case 'lantern':
      // on the south wall's outer face, facing south (-Y)
      s.on('fixture_metal').box(-0.05, -0.08, -0.2, 0.05, 0, 0.12);
      s.on('fixture_metal').box(-0.1, -0.28, 0.12, 0.1, -0.08, 0.16);
      s.on('lantern_glass').box(-0.08, -0.26, -0.15, 0.08, -0.1, 0.12);
      s.on('fixture_metal').box(-0.1, -0.28, -0.19, 0.1, -0.08, -0.15);
      break;
    case 'wall':
      // a wall up-and-down light, facing -Y before the node's yaw
      s.on('fixture_metal').box(-0.06, -0.12, -0.12, 0.06, 0, 0.12);
      s.on('led_diffuser').box(-0.045, -0.125, -0.13, 0.045, -0.02, -0.12);
      s.on('led_diffuser').box(-0.045, -0.125, 0.12, 0.045, -0.02, 0.13);
      break;
    case 'floor_lamp':
      s.on('black_steel').lathe(0, 0, [
        [0, 0.16],
        [0.025, 0.16],
      ]);
      s.on('black_steel').box(-0.012, -0.012, 0.025, 0.012, 0.012, 1.3);
      s.on('lamp_shade').lathe(
        0,
        0,
        [
          [1.25, 0.22],
          [1.6, 0.18],
        ],
        12,
      );
      s.on('bulb').lathe(0, 0, [
        [1.3, 0],
        [1.34, 0.04],
        [1.4, 0.04],
        [1.44, 0],
      ]);
      break;
  }
  return s;
}
