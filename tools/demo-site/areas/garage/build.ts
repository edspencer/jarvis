// The garage wing's built-ins and appliances (the main model) and its furniture and car (the furniture model). Plan
// metres; the wing's slab is at WING.z, so heights are written above it with z(h).
import { Shape, type V3 } from '../../geometry.ts';
import { D, WING } from '../../dims.ts';
import { item, merged, type Model } from '../../model.ts';
import { ngon } from './panel-model.ts';

const z = (h: number) => WING.z + h;
const E = WING.x1, // the east wall's inner face
  Wx = WING.x0; // the west wall's (the block's east wall's) garage face

/** where things are (shared with garage.ts's pins, plates and devices) */
export const AT = {
  waterHeater: [12.65, 6.17] as const,
  stopcock: [Wx + 0.06, 5.5, z(1.0)] as V3,
  charger: { y0: 2.2, y1: 2.5 },
  battery: { y0: 6.8, y1: 7.55 },
  inverter: { y0: 7.75, y1: 8.25 },
  washer: { x0: 12.35, x1: 13.03 },
  dryer: { x0: 13.1, x1: 13.78 },
  appliancesY: [6.78, 7.53] as const,
  car: { x0: 15.73, x1: 17.58, y0: 0.6, y1: 5.25 },
};

/** a horizontal cylinder along X (an octagon prism) */
const wheel = (s: Shape, mat: string, x0: number, x1: number, y: number, zc: number, r: number) =>
  s.on(mat).prism(ngon([x0, y, zc], r, 'x'), [x1 - x0, 0, 0]);
/** a round thing on a face looking along ±Y (a washer's door) */
const disc = (s: Shape, mat: string, x: number, y0: number, y1: number, zc: number, r: number) =>
  s.on(mat).prism(ngon([x, y0, zc], r, 'y'), [0, y1 - y0, 0]);

export function buildGarageMain(m: Model): void {
  waterHeater(m);
  stopcock(m);
  evCharger(m);
  batteryAndInverter(m);
  conduit(m);
  opener(m);
  freezer(m);
  laundry(m);
}

/** the 50-gallon electric water heater on its stand, the expansion tank, pipes and the T&P discharge */
function waterHeater(m: Model): void {
  const [cx, cy] = AT.waterHeater;
  const s = new Shape();
  // the stand: a platform on four legs
  s.on('ga_steel').box(cx - 0.33, cy - 0.33, z(0.42), cx + 0.33, cy + 0.33, z(0.46));
  for (const [dx, dy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ])
    s.on('ga_steel').box(
      cx + dx * 0.3 - 0.025,
      cy + dy * 0.3 - 0.025,
      z(0),
      cx + dx * 0.3 + 0.025,
      cy + dy * 0.3 + 0.025,
      z(0.42),
    );
  s.on('ga_tank').lathe(
    cx,
    cy,
    [
      [z(0.46), 0.27],
      [z(0.5), 0.28],
      [z(1.92), 0.28],
      [z(1.97), 0.24],
      [z(1.99), 0],
    ],
    12,
  );
  // the element access covers and the data plate
  s.on('ga_steel').box(cx + 0.27, cy - 0.06, z(0.7), cx + 0.285, cy + 0.06, z(0.82));
  s.on('ga_steel').box(cx + 0.27, cy - 0.06, z(1.5), cx + 0.285, cy + 0.06, z(1.62));
  s.on('ga_label_card').box(cx + 0.275, cy - 0.1, z(1.05), cx + 0.285, cy + 0.1, z(1.3));
  // cold in and hot out, up to the ceiling
  for (const dx of [-0.08, 0.08])
    s.on('ga_copper').box(cx + dx - 0.012, cy - 0.012, z(1.99), cx + dx + 0.012, cy + 0.012, WING.ceil);
  // the expansion tank on a tee off the cold line, hanging east of the heater
  s.on('ga_copper').box(cx - 0.08, cy - 0.012, z(2.3), cx + 0.42, cy + 0.012, z(2.324));
  s.on('ga_expansion').lathe(
    cx + 0.42,
    cy,
    [
      [z(1.98), 0],
      [z(2.0), 0.1],
      [z(2.24), 0.11],
      [z(2.29), 0.03],
    ],
    10,
  );
  // the T&P relief line down to a few inches above the floor
  s.on('ga_copper').box(cx + 0.2, cy - 0.21, z(0.12), cx + 0.224, cy - 0.186, z(1.85));
  // the supply: flexible conduit from the top to a box on the wall
  s.on('ga_steel').box(cx - 0.02, cy + 0.15, z(1.97), cx + 0.02, cy + 0.19, z(2.3));
  s.on('ga_steel').box(Wx, cy + 0.15, z(2.3), cx + 0.02, cy + 0.19, z(2.34));
  m.node('Water_heater', s, { room: 'garage', kind: 'water heater', capacity_gal: 50 });
}

/** the main water shut-off: the supply up the west wall with a lever ball valve */
function stopcock(m: Model): void {
  const [x, y, zc] = AT.stopcock;
  merged(
    m,
    'Main_shutoff',
    'main_shutoff',
    [
      {
        name: 'Water main (riser)',
        material: 'ga_copper',
        boxes: [[x - 0.014, y - 0.014, z(0), x + 0.014, y + 0.014, WING.ceil]],
      },
      {
        name: 'Ball valve',
        material: 'ga_copper',
        boxes: [[x - 0.03, y - 0.03, zc - 0.04, x + 0.03, y + 0.03, zc + 0.04]],
      },
      {
        name: 'Valve lever',
        material: 'ga_valve_red',
        boxes: [
          [x + 0.03, y - 0.012, zc - 0.006, x + 0.055, y + 0.012, zc + 0.006],
          [x + 0.03, y - 0.012, zc - 0.006, x + 0.045, y + 0.14, zc + 0.006],
        ],
      },
    ],
    { room: 'garage' },
  );
}

/** the Level 2 charger on the east wall, its cable coiled on the holster */
function evCharger(m: Model): void {
  const { y0, y1 } = AT.charger;
  const s = new Shape();
  s.on('ga_charger_white').box(E - 0.11, y0, z(1.05), E, y1, z(1.45));
  s.on('ga_charger_black').box(E - 0.115, y0 + 0.03, z(1.12), E - 0.11, y1 - 0.03, z(1.4));
  s.on('ga_led').box(E - 0.118, y0 + 0.12, z(1.36), E - 0.115, y1 - 0.12, z(1.37));
  // the holster and the connector in it
  s.on('ga_charger_black').box(E - 0.08, y1 + 0.04, z(1.15), E, y1 + 0.12, z(1.3));
  s.on('ga_charger_black').box(E - 0.13, y1 + 0.05, z(1.1), E - 0.08, y1 + 0.11, z(1.28));
  // the cable: a loop hanging below the charger
  const c = 'ga_charger_black';
  s.on(c).box(E - 0.1, y0 + 0.13, z(0.62), E - 0.07, y0 + 0.17, z(1.05));
  s.on(c).box(E - 0.1, y1 + 0.05, z(0.62), E - 0.07, y1 + 0.09, z(1.1));
  s.on(c).box(E - 0.1, y0 + 0.13, z(0.6), E - 0.07, y1 + 0.09, z(0.64));
  m.node('EV_charger', s, { room: 'garage', kind: 'EV charger' });
}

/** the home battery (floor-standing, against the wall) and the PV inverter above it to the north */
function batteryAndInverter(m: Model): void {
  const b = AT.battery,
    i = AT.inverter;
  const s = new Shape();
  s.on('ga_battery').box(E - 0.16, b.y0, z(0.05), E, b.y1, z(1.15));
  s.on('ga_steel').box(E - 0.16, b.y0 + 0.05, z(0), E - 0.02, b.y1 - 0.05, z(0.05));
  s.on('ga_led').box(E - 0.165, b.y0 + 0.3, z(0.9), E - 0.16, b.y1 - 0.3, z(0.92));
  m.node('Home_battery', s, { room: 'garage', kind: 'home battery' });
  const t = new Shape();
  t.on('ga_inverter').box(E - 0.18, i.y0, z(1.15), E, i.y1, z(1.75));
  t.on('ga_charger_black').box(E - 0.185, i.y0 + 0.15, z(1.5), E - 0.18, i.y1 - 0.15, z(1.62));
  t.on('ga_inverter').box(E - 0.2, i.y0 + 0.05, z(1.1), E - 0.04, i.y1 - 0.05, z(1.15));
  m.node('PV_inverter', t, { room: 'garage', kind: 'PV inverter' });
}

/** the conduit runs on the east wall: the charger, the inverter and the battery back to the panel, along the wall
 * above the window */
function conduit(m: Model): void {
  const run = z(2.45),
    x0 = E - 0.04,
    x1 = E - 0.005;
  merged(
    m,
    'Conduit_east',
    'conduit_east',
    [
      {
        name: 'Conduit run (east wall)',
        material: 'ga_conduit',
        boxes: [
          [x0, AT.charger.y0 + 0.13, run, x1, AT.inverter.y0 + 0.25, run + 0.035],
          // drops: the charger, the panel, the inverter
          [x0, AT.charger.y0 + 0.13, z(1.45), x1, AT.charger.y0 + 0.165, run],
          [x0, 5.38, z(1.9), x1, 5.415, run],
          [x0, AT.inverter.y0 + 0.215, z(1.75), x1, AT.inverter.y0 + 0.25, run],
        ],
      },
    ],
    { room: 'garage' },
  );
}

/** the sectional door's opener on the ceiling (motor, rail), its wall button by the hall door, and the door's tracks */
function opener(m: Model): void {
  const x = 15.5,
    ceil = WING.ceil;
  merged(
    m,
    'Garage_door_opener',
    'garage_door_opener',
    [
      { name: 'Opener motor', material: 'ga_opener', boxes: [[x - 0.2, 3.6, ceil - 0.3, x + 0.2, 4.1, ceil - 0.1]] },
      {
        name: 'Opener light lens',
        material: 'lens',
        boxes: [[x - 0.12, 3.68, ceil - 0.31, x + 0.12, 3.95, ceil - 0.3]],
      },
      {
        name: 'Opener rail and hangers',
        material: 'ga_steel',
        boxes: [
          [x - 0.03, 0.05, ceil - 0.17, x + 0.03, 3.6, ceil - 0.13],
          [x - 0.25, 4.0, ceil - 0.1, x - 0.22, 4.03, ceil],
          [x + 0.22, 4.0, ceil - 0.1, x + 0.25, 4.03, ceil],
        ],
      },
      {
        name: 'Wall button',
        material: 'ga_opener',
        boxes: [[Wx, 2.83, z(1.33), Wx + 0.02, 2.9, z(1.43)]],
        extras: { kind: 'door opener button' },
      },
    ],
    { room: 'garage', kind: 'garage door opener' },
  );
  // the door's tracks: up each side of the opening, then back under the ceiling
  const tracks = (xa: number): number[][] => [
    [xa, 0.0, z(0), xa + 0.05, 0.07, z(2.25)],
    [xa, 0.0, z(2.22), xa + 0.05, 3.0, z(2.3)],
  ];
  merged(
    m,
    'Garage_door_tracks',
    'garage_door_tracks',
    [{ name: 'Door tracks', material: 'ga_steel', boxes: [...tracks(12.98), ...tracks(17.97)] }],
    { room: 'garage' },
  );
}

/** the chest freezer against the west wall */
function freezer(m: Model): void {
  const s = new Shape();
  s.on('ga_appliance').box(Wx + 0.05, 3.3, z(0.02), Wx + 0.73, 4.4, z(0.84));
  s.on('ga_charger_black').box(Wx + 0.05, 3.3, z(0.78), Wx + 0.735, 4.4, z(0.79));
  s.on('ga_charger_black').box(Wx + 0.735, 3.6, z(0.71), Wx + 0.76, 4.1, z(0.75));
  s.on('ga_charger_black').box(Wx + 0.05, 3.3, z(0), Wx + 0.73, 4.4, z(0.02));
  m.node('Chest_freezer', s, { room: 'garage', kind: 'chest freezer' });
}

/** the laundry: washer, dryer (with its vent duct up to the roof), wall cabinets, the utility sink */
function laundry(m: Model): void {
  const [y0, y1] = AT.appliancesY;
  const unit = (name: string, x0: number, x1: number, glass: string) => {
    const s = new Shape();
    const xc = (x0 + x1) / 2;
    s.on('ga_appliance').box(x0, y0, z(0.02), x1, y1, z(0.98));
    s.on('ga_charger_black').box(x0 + 0.02, y0 + 0.02, z(0), x1 - 0.02, y1 - 0.02, z(0.02));
    // the control panel along the top front, a dial and a display
    s.on('ga_chrome').box(x0 + 0.01, y1, z(0.84), x1 - 0.01, y1 + 0.01, z(0.96));
    s.on('ga_charger_black').box(xc + 0.08, y1 + 0.01, z(0.87), xc + 0.24, y1 + 0.015, z(0.93));
    disc(s, 'ga_chrome', x0 + 0.12, y1 + 0.01, y1 + 0.04, z(0.9), 0.035);
    // the round door: a chrome ring and the glass
    disc(s, 'ga_chrome', xc, y1, y1 + 0.03, z(0.47), 0.22);
    disc(s, glass, xc, y1 + 0.03, y1 + 0.045, z(0.47), 0.17);
    m.node(name, s, { room: 'laundry', kind: name.toLowerCase() });
  };
  unit('Washer', AT.washer.x0, AT.washer.x1, 'ga_door_glass');
  unit('Dryer', AT.dryer.x0, AT.dryer.x1, 'ga_door_glass');
  const wy = 6.6 + 0.06; // the laundry face of the laundry / garage wall
  merged(
    m,
    'Laundry_units',
    'laundry_units',
    [
      {
        name: 'Dryer vent duct',
        material: 'ga_duct',
        // out of the dryer's back, along behind it and up past the cabinets' end to the roof vent
        boxes: [
          [13.4, wy, z(0.3), 13.97, wy + 0.1, z(0.44)],
          [13.83, wy, z(0.44), 13.97, wy + 0.1, WING.ceil],
        ],
      },
      { name: 'Wall cabinets', material: 'cabinet', boxes: [[12.3, wy, z(1.55), 13.79, wy + 0.33, z(2.3)]] },
      {
        name: 'Shelf over the washer and dryer',
        material: 'cabinet',
        boxes: [[12.3, wy, z(1.3), 13.79, wy + 0.3, z(1.32)]],
      },
      {
        name: 'Utility sink',
        material: 'sanitary',
        boxes: [
          [14.3, 8.4, z(0.62), 14.9, D - 0.02, z(0.92)],
          [14.32, 8.42, z(0), 14.36, 8.46, z(0.62)],
          [14.84, 8.42, z(0), 14.88, 8.46, z(0.62)],
          [14.32, D - 0.08, z(0), 14.36, D - 0.04, z(0.62)],
          [14.84, D - 0.08, z(0), 14.88, D - 0.04, z(0.62)],
        ],
      },
      { name: 'Sink basin', material: 'ga_charger_black', boxes: [[14.36, 8.46, z(0.92), 14.84, D - 0.12, z(0.925)]] },
      {
        name: 'Sink faucet',
        material: 'ga_chrome',
        boxes: [
          [14.58, D - 0.1, z(0.92), 14.62, D - 0.06, z(1.12)],
          [14.58, D - 0.3, z(1.08), 14.62, D - 0.06, z(1.12)],
          [14.48, D - 0.1, z(0.94), 14.72, D - 0.07, z(0.97)],
        ],
      },
    ],
    { room: 'laundry' },
  );
}

// ------------------------------------------------------------------ furniture
export function buildGarageFurniture(m: Model): void {
  car(m);
  // a workbench under the north window, a vice and a toolbox on it
  const fz = WING.z;
  const bench = (b: number[]): number[] => [b[0], b[1], b[2] + fz, b[3], b[4], b[5] + fz];
  item(
    m,
    'Furn_workbench',
    'garage',
    'workbench, 1.8 × 0.6 m',
    (
      [
        ['wood_ash', [15.95, 8.36, 0.86, 17.75, 8.97, 0.92]],
        ['wood_ash', [16.0, 8.4, 0.18, 17.7, 8.93, 0.21]],
        ['black_steel', [15.98, 8.39, 0, 16.04, 8.45, 0.86]],
        ['black_steel', [17.66, 8.39, 0, 17.72, 8.45, 0.86]],
        ['black_steel', [15.98, 8.9, 0, 16.04, 8.96, 0.86]],
        ['black_steel', [17.66, 8.9, 0, 17.72, 8.96, 0.86]],
        ['black_steel', [16.05, 8.36, 0.92, 16.25, 8.5, 1.02]],
        ['ga_toolbox', [17.05, 8.6, 0.92, 17.55, 8.85, 1.12]],
        ['black_steel', [17.2, 8.71, 1.12, 17.4, 8.74, 1.17]],
        ['ga_toolbox', [16.3, 8.5, 0.21, 16.85, 8.85, 0.45]],
      ] as [string, number[]][]
    ).map(([mat, b]) => [mat, bench(b)]),
  );
  // steel shelving on the annex's west wall, with storage totes
  const shelves: [string, number[]][] = [];
  for (const [x, y] of [
    [15.47, 7.0],
    [15.87, 7.0],
    [15.47, 8.17],
    [15.87, 8.17],
  ])
    shelves.push(['black_steel', bench([x, y, 0, x + 0.03, y + 0.03, 1.8])]);
  for (const h of [0.15, 0.6, 1.05, 1.5]) shelves.push(['ga_steel', bench([15.47, 7.0, h, 15.9, 8.2, h + 0.02])]);
  for (const [i, h] of [0.17, 0.62, 1.07].entries())
    for (const [j, y] of [7.05, 7.62].entries())
      shelves.push([(i + j) % 2 ? 'ga_tote_blue' : 'ga_tote_grey', bench([15.5, y, h, 15.86, y + 0.52, h + 0.32])]);
  item(m, 'Furn_shelving', 'garage', 'steel shelving, 1.2 × 0.45 m, four shelves', shelves);
  // trash and recycling carts in the south-west corner
  const cart = (y: number, lid: string): [string, number[]][] => [
    ['ga_bin', bench([Wx + 0.08, y, 0.05, Wx + 0.66, y + 0.6, 1.0])],
    [lid, bench([Wx + 0.06, y - 0.02, 1.0, Wx + 0.7, y + 0.62, 1.05])],
    ['ga_tyre', bench([Wx + 0.06, y + 0.05, 0, Wx + 0.1, y + 0.17, 0.12])],
    ['ga_tyre', bench([Wx + 0.06, y + 0.43, 0, Wx + 0.1, y + 0.55, 0.12])],
  ];
  item(m, 'Furn_bins', 'garage', 'trash and recycling carts, 96 gal', [
    ...cart(0.12, 'ga_bin'),
    ...cart(0.8, 'ga_tote_blue'),
  ]);
}

/** an electric hatchback, nose in, in the east bay */
function car(m: Model): void {
  const { x0, x1, y0, y1 } = AT.car;
  const w = x1 - x0;
  const s = new Shape();
  const P = (y: number, h: number): V3 => [x0, y, z(h)];
  // the body: its side profile swept across the car
  s.on('ga_car_paint').prism(
    [
      P(y0, 0.22),
      P(y1 - 0.02, 0.22),
      P(y1, 0.55),
      P(y1 - 0.15, 0.8),
      P(y1 - 1.35, 0.94),
      P(y0 + 0.2, 0.98),
      P(y0, 0.7),
    ],
    [w, 0, 0],
  );
  // the glasshouse, a little narrower, and the roof
  const g = 0.12;
  s.on('ga_car_glass').prism(
    [
      [x0 + g, y1 - 1.35, z(0.94)],
      [x0 + g, y1 - 2.25, z(1.42)],
      [x0 + g, y0 + 1.0, z(1.45)],
      [x0 + g, y0 + 0.22, z(0.98)],
    ],
    [w - 2 * g, 0, 0],
  );
  s.on('ga_car_paint').box(x0 + g + 0.03, y0 + 1.05, z(1.43), x1 - g - 0.03, y1 - 2.3, z(1.48));
  // wheels, hubs
  for (const y of [y0 + 0.85, y1 - 0.95])
    for (const [a, b, hub] of [
      [x0 - 0.02, x0 + 0.24, x0 - 0.025],
      [x1 - 0.24, x1 + 0.02, x1 + 0.02],
    ]) {
      wheel(s, 'ga_tyre', a, b, y, z(0.33), 0.33);
      wheel(s, 'ga_hub', hub, hub + 0.005, y, z(0.33), 0.2);
    }
  // lights, mirrors, the charge-port flap
  s.on('ga_headlight').box(x0 + 0.12, y1 - 0.06, z(0.6), x0 + 0.5, y1 + 0.005, z(0.68));
  s.on('ga_headlight').box(x1 - 0.5, y1 - 0.06, z(0.6), x1 - 0.12, y1 + 0.005, z(0.68));
  s.on('ga_tail').box(x0 + 0.08, y0 - 0.005, z(0.78), x1 - 0.08, y0 + 0.08, z(0.84));
  for (const [a, b] of [
    [x0 - 0.12, x0 + 0.05],
    [x1 - 0.05, x1 + 0.12],
  ])
    s.on('ga_car_paint').box(a, y1 - 1.45, z(0.95), b, y1 - 1.33, z(1.05));
  s.on('ga_tyre').box(x1 - 0.003, y1 - 0.75, z(0.72), x1 + 0.003, y1 - 0.6, z(0.82));
  m.node('Furn_car', s, { room: 'garage', product: 'electric hatchback (5-door)' });
}
