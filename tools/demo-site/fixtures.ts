import { Shape } from './geometry.ts';

// ------------------------------------------------------------------ fixture shapes
// The built-in kinds of light fixture (areas may add their own: Area.fixtureShapes). Each is drawn about its mounting
// point, in the plan frame, before the node's yaw. The fixtures themselves are in the areas (tools/demo-site/areas).
/** a built-in fixture's shape, about its mounting point (plan frame, before the node's yaw) */
function builtinShape(kind: (typeof BUILTIN_KINDS)[number]): Shape {
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

const BUILTIN_KINDS = ['can', 'pendant', 'flush', 'bar', 'lantern', 'wall', 'floor_lamp'] as const;
export const FIXTURE_SHAPES: Record<string, () => Shape> = Object.fromEntries(
  BUILTIN_KINDS.map((k) => [k, () => builtinShape(k)]),
);
