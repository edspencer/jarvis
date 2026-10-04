import type { Mesh } from '@gltf-transform/core';
import { encodeToKTX2 } from 'ktx2-encoder';
import { Shape, toGltf, type V3 } from './geometry.ts';
import { Canvas } from './png.ts';
import {
  CEIL0,
  CEIL1,
  D,
  EAVE,
  EXT,
  OVERHANG,
  PITCH,
  RISERS,
  SLAB,
  STAIR_X,
  STAIR_Y0,
  STAIR_Y1,
  TREAD,
  UP,
  W,
  WING,
} from './dims.ts';
import { Model, merged, type Piece } from './model.ts';
import { ROOMS, WALLS, floorZ, wallBoxes } from './layout.ts';
import { AREAS, FIXTURES, PLATES, fixtureShape } from './areas/index.ts';

// ------------------------------------------------------------------ the main model
/** the house-name plaque's picture, as KTX2 (Basis Universal UASTC, with mipmaps): a slate plate, a border and a
 * blocky "12". Encoding is deterministic, so the committed demo.glb stays what this script writes. */
export async function plaqueKtx2(): Promise<Uint8Array> {
  const c = new Canvas(128, 64);
  const ink = [236, 230, 214, 255];
  c.rect(0, 0, 128, 64, [44, 58, 66, 255]);
  for (const [x0, y0, x1, y1] of [
    [4, 4, 124, 7],
    [4, 57, 124, 60],
    [4, 4, 7, 60],
    [121, 4, 124, 60],
  ])
    c.rect(x0, y0, x1, y1, ink);
  // "1": a stem and a flag; "2": three bars and two uprights
  for (const [x0, y0, x1, y1] of [
    [44, 16, 52, 48],
    [38, 16, 44, 22],
    [62, 16, 88, 22],
    [82, 16, 88, 32],
    [62, 29, 88, 35],
    [62, 29, 68, 48],
    [62, 42, 90, 48],
  ])
    c.rect(x0, y0, x1, y1, ink);
  const log = console.log;
  console.log = () => {}; // the Basis encoder's progress lines
  try {
    return await encodeToKTX2(new Uint8Array(0), {
      isUASTC: true,
      generateMipmap: true,
      imageDecoder: async () => ({ data: c.px, width: c.w, height: c.h }),
    });
  } finally {
    console.log = log;
  }
}

/** the house-name plaque left of the front door, on the south wall's outer face (a KTX2 texture) */
function housePlaque(m: Model, plaque: Uint8Array): void {
  const py = -EXT - 0.01;
  m.texturedQuad(
    'Plaque_house_name',
    [
      [7.2, py, 1.35],
      [7.8, py, 1.35],
      [7.8, py, 1.65],
      [7.2, py, 1.65],
    ],
    [0, -1, 0],
    plaque,
    { kind: 'house name plaque' },
  );
}

/** floors (one node per room: the room list and "where am I") and ceilings */
function floors(m: Model): void {
  for (const r of ROOMS) {
    const s = new Shape();
    const z1 = floorZ(r),
      z0 = r.storey ? SLAB : z1 - 0.1;
    for (const [x0, y0, x1, y1] of r.rects) s.on(r.floor).box(x0, y0, z1 - 0.02, x1, y1, z1);
    for (const [x0, y0, x1, y1] of r.rects) s.on('slab_edge').box(x0, y0, z0, x1, y1, z1 - 0.02);
    m.node(`Floor_${r.id}`, s, { room: r.id, storey: r.storey ? 'first' : 'ground' });
    const c = new Shape();
    const cz = r.storey ? CEIL1 : CEIL0;
    for (const [x0, y0, x1, y1] of r.ceil || r.rects) c.on('ceiling').box(x0, y0, cz, x1, y1, cz + 0.02);
    m.node(`Ceil_${r.id}`, c, { room: r.id });
  }
}

/** walls, by storey (merged: the parts file names each wall) */
function walls(m: Model): void {
  for (const storey of [0, 1] as const) {
    const pieces: Piece[] = WALLS.filter((w) => w.storey === storey).map((w) => ({
      name: w.name,
      material: w.material,
      boxes: wallBoxes(w),
      extras: { kind: w.exterior ? 'exterior wall' : 'interior wall', thickness_m: +(w.c1 - w.c0).toFixed(2) },
    }));
    if (storey === 1)
      pieces.push({
        name: 'Stairwell balustrade',
        material: 'rail',
        boxes: [
          [10.6 - 0.04, STAIR_Y0 + 0.06, UP, 10.6 + 0.04, STAIR_Y1, UP + 0.95],
          [10.6 - 0.05, STAIR_Y0 + 0.06, UP + 0.95, 10.6 + 0.05, STAIR_Y1, UP + 1.0],
        ],
        extras: { kind: 'guard', height_m: 1.0 },
      });
    merged(m, storey ? 'Walls_first' : 'Walls_ground', storey ? 'walls_first' : 'walls_ground', pieces);
  }
}

/** windows and doors in the openings */
function openings(m: Model): void {
  for (const w of WALLS)
    for (const o of w.openings) {
      if (o.kind === 'open' || !o.id) continue;
      const mid = (w.c0 + w.c1) / 2;
      const span = (a: number, b: number, c0: number, c1: number, z0: number, z1: number) =>
        w.dir === 'x' ? [a, c0, z0, b, c1, z1] : [c0, a, z0, c1, b, z1];
      if (o.kind === 'door') {
        const s = new Shape();
        const b = span(o.a + 0.01, o.b - 0.01, mid - 0.02, mid + 0.02, o.sill + 0.01, o.head - 0.01);
        s.on(o.material || 'door_oak').box(b[0], b[1], b[2], b[3], b[4], b[5]);
        // a sectional door: grooves between its horizontal panels, on both faces
        for (let i = 1; i < (o.panels ?? 0); i++) {
          const z = o.sill + 0.01 + ((o.head - o.sill - 0.02) * i) / o.panels!;
          const g = span(o.a + 0.01, o.b - 0.01, mid - 0.024, mid + 0.024, z - 0.012, z + 0.012);
          s.on('garage_door_groove').box(g[0], g[1], g[2], g[3], g[4], g[5]);
        }
        m.node(`Door_${o.id}`, s, {
          door_leaf: true,
          width_m: +(o.b - o.a).toFixed(2),
          ...(o.panels ? { kind: 'sectional garage door', panels: o.panels } : {}),
        });
        continue;
      }
      const glass = new Shape(),
        frame = new Shape();
      const f = 0.05;
      const g = span(o.a + f, o.b - f, mid - 0.006, mid + 0.006, o.sill + f, o.head - f);
      glass.on('glass').box(g[0], g[1], g[2], g[3], g[4], g[5]);
      for (const b of [
        span(o.a, o.b, mid - 0.035, mid + 0.035, o.sill, o.sill + f),
        span(o.a, o.b, mid - 0.035, mid + 0.035, o.head - f, o.head),
        span(o.a, o.a + f, mid - 0.035, mid + 0.035, o.sill + f, o.head - f),
        span(o.b - f, o.b, mid - 0.035, mid + 0.035, o.sill + f, o.head - f),
      ])
        frame.on('window_frame').box(b[0], b[1], b[2], b[3], b[4], b[5]);
      m.node(`Win_${o.id}`, glass, { kind: o.kind === 'glazed' ? 'glazed door' : 'window' });
      m.node(`WinFrame_${o.id}`, frame);
      if (o.b - o.a > 1.5) {
        const mull = new Shape();
        const c = (o.a + o.b) / 2;
        const b = span(c - 0.025, c + 0.025, mid - 0.03, mid + 0.03, o.sill + f, o.head - f);
        mull.on('window_frame').box(b[0], b[1], b[2], b[3], b[4], b[5]);
        m.node(`WinMull_${o.id}`, mull);
      }
    }
}

/** the stair: solid treads (a step of 0.178 m, under walk.maxStep), merged */
function stair(m: Model): void {
  const treads: Piece[] = [];
  for (let i = 1; i < RISERS; i++) {
    const y0 = STAIR_Y0 + (i - 1) * TREAD;
    treads.push({
      name: `Stair tread ${i}`,
      material: 'stair_oak',
      boxes: [[STAIR_X[0], y0, 0, STAIR_X[1], y0 + TREAD, +((i * UP) / RISERS).toFixed(4)]],
      extras: { rise_m: +(UP / RISERS).toFixed(4), going_m: TREAD },
    });
  }
  treads.push({
    name: 'Stair handrail',
    material: 'rail',
    // newel posts at the foot and the head, a baluster on every other tread, and one sloped rail 0.9 m above the
    // nosings (a prism: its section in the plan's Y-Z plane, swept 4 cm across)
    boxes: [
      [STAIR_X[0] - 0.04, STAIR_Y0 - 0.04, 0, STAIR_X[0] + 0.04, STAIR_Y0 + 0.04, 1.05],
      [STAIR_X[0] - 0.04, STAIR_Y1 - 0.04, UP, STAIR_X[0] + 0.04, STAIR_Y1 + 0.04, UP + 1.05],
      ...Array.from({ length: Math.floor((RISERS - 2) / 2) }, (_, k) => {
        const i = 2 * k + 1,
          y = STAIR_Y0 + (i + 0.5) * TREAD,
          z = ((i + 1) * UP) / RISERS;
        return [STAIR_X[0] - 0.012, y - 0.012, z, STAIR_X[0] + 0.012, y + 0.012, z + 0.9];
      }),
    ],
    prisms: [
      [
        [
          [STAIR_X[0] - 0.02, STAIR_Y0, 0.9 + UP / RISERS],
          [STAIR_X[0] - 0.02, STAIR_Y1, 0.9 + UP],
          [STAIR_X[0] - 0.02, STAIR_Y1, 0.95 + UP],
          [STAIR_X[0] - 0.02, STAIR_Y0, 0.95 + UP / RISERS],
        ],
        [0.04, 0, 0],
      ],
    ],
    extras: { kind: 'handrail' },
  });
  merged(m, 'Stair', 'stair', treads, { room: 'hall' });
}

/** the roof: a hip roof on the walls, with soffits (all in the roof layer) */
function roof(m: Model): void {
  const roof = new Shape();
  const t = Math.tan((PITCH * Math.PI) / 180);
  const x0 = -EXT - OVERHANG,
    x1 = W + EXT + OVERHANG,
    y0 = -EXT - OVERHANG,
    y1 = D + EXT + OVERHANG;
  const half = (y1 - y0) / 2;
  const ridge = EAVE + half * t;
  const rx0 = x0 + half,
    rx1 = x1 - half,
    ry = (y0 + y1) / 2;
  const th = 0.12;
  const slab = (pts: V3[]) => {
    // thickness straight down, so the eaves line stays at EAVE on top
    roof.on('roof_tile').prism(
      pts.map(([x, y, z]) => [x, y, z - th] as V3),
      [0, 0, th],
    );
  };
  slab([
    [x0, y0, EAVE],
    [x1, y0, EAVE],
    [rx1, ry, ridge],
    [rx0, ry, ridge],
  ]);
  slab([
    [x1, y1, EAVE],
    [x0, y1, EAVE],
    [rx0, ry, ridge],
    [rx1, ry, ridge],
  ]);
  slab([
    [x0, y1, EAVE],
    [x0, y0, EAVE],
    [rx0, ry, ridge],
  ]);
  slab([
    [x1, y0, EAVE],
    [x1, y1, EAVE],
    [rx1, ry, ridge],
  ]);
  m.node('Roof_main', roof, { kind: 'hip roof', pitch_deg: PITCH, material: 'clay tile' });
  const soffit = new Shape();
  const sz = EAVE - th - 0.03;
  soffit.on('soffit').box(x0, y0, sz, x1, -EXT, sz + 0.02);
  soffit.on('soffit').box(x0, D + EXT, sz, x1, y1, sz + 0.02);
  soffit.on('soffit').box(x0, -EXT, sz, -EXT, D + EXT, sz + 0.02);
  soffit.on('soffit').box(W + EXT, -EXT, sz, x1, D + EXT, sz + 0.02);
  m.node('Roof_soffit', soffit);
}

/** the garage wing's roof: a lower hip roof, its west end against the block's east wall (its ridge, 4.4 m up, is
 * below the first floor's east window), with soffits; in the roof layer (Roof_ prefix) like the main roof */
function garageRoof(m: Model): void {
  const roof = new Shape();
  const t = Math.tan((WING.pitch * Math.PI) / 180);
  const x0 = WING.x0 + 0.005, // just clear of the wall's face
    x1 = WING.x1 + EXT + OVERHANG,
    y0 = -EXT - OVERHANG,
    y1 = D + EXT + OVERHANG;
  const half = (y1 - y0) / 2;
  const E = WING.eave,
    ridge = E + half * t;
  const rx1 = x1 - half,
    ry = (y0 + y1) / 2;
  const th = 0.12;
  const slab = (pts: V3[]) =>
    roof.on('roof_tile').prism(
      pts.map(([x, y, z]) => [x, y, z - th] as V3),
      [0, 0, th],
    );
  slab([
    [x0, y0, E],
    [x1, y0, E],
    [rx1, ry, ridge],
    [x0, ry, ridge],
  ]);
  slab([
    [x1, y1, E],
    [x0, y1, E],
    [x0, ry, ridge],
    [rx1, ry, ridge],
  ]);
  slab([
    [x1, y0, E],
    [x1, y1, E],
    [rx1, ry, ridge],
  ]);
  m.node('Roof_garage', roof, { kind: 'hip roof', pitch_deg: WING.pitch, material: 'clay tile', room: 'garage' });
  const soffit = new Shape();
  const sz = E - th - 0.03;
  soffit.on('soffit').box(x0, y0, sz, x1, -EXT, sz + 0.02);
  soffit.on('soffit').box(x0, D + EXT, sz, x1, y1, sz + 0.02);
  soffit.on('soffit').box(WING.x1 + EXT, -EXT, sz, x1, D + EXT, sz + 0.02);
  m.node('Roof_garage_soffit', soffit);
}

/** light fixtures: one node each, sharing a mesh per kind (the main model's, or the furniture model's: a lamp) */
export function lightFixtures(m: Model, model: 'main' | 'furniture'): void {
  const fxMesh = new Map<string, Mesh>();
  for (const f of FIXTURES.filter((x) => (x.model ?? 'main') === model)) {
    if (!fxMesh.has(f.kind)) fxMesh.set(f.kind, m.mesh(`fixture_${f.kind}`, fixtureShape(f.kind)));
    m.node(
      `Fixture_${f.id}`,
      fxMesh.get(f.kind)!,
      { fixture_id: f.id, fixture_kind: f.kind.replace(/_/g, ' '), fixture_group: f.group, room: f.room },
      { at: f.at, yaw: f.yaw },
    );
  }
}

/** wall plates: one group (layer: switches), a node per plate (+Z out of the wall), a child per part */
function wallPlates(m: Model): void {
  const pm = {
    plate1: m.mesh(
      'plate_1gang',
      ((s) => (s.on('plate_white').box(-0.035, -0.0575, 0, 0.035, 0.0575, 0.008), s))(new Shape()),
    ),
    plate2: m.mesh(
      'plate_2gang',
      ((s) => (s.on('plate_white').box(-0.0575, -0.0575, 0, 0.0575, 0.0575, 0.008), s))(new Shape()),
    ),
    rocker: m.mesh(
      'rocker',
      ((s) => (s.on('rocker_white').box(-0.016, -0.033, 0.008, 0.016, 0.033, 0.015), s))(new Shape()),
    ),
    socket: m.mesh(
      'receptacle',
      ((s) => (s.on('receptacle').box(-0.018, -0.02, 0.008, 0.018, 0.02, 0.014), s))(new Shape()),
    ),
  };
  const plates = m.node('Switches', null, { layer: 'switches' });
  for (const p of PLATES) {
    const gangs = p.positions.length;
    // local (x, y, z) of a part: glTF axes, before the plate's rotation. The plate faces +Z; Y is up.
    const yaw = Math.atan2(p.normal[0], -p.normal[1]);
    const node = m.doc.createNode(`Switch_${p.id}`).setExtras({
      plate_id: p.id,
      box_id: p.id,
      room: p.room,
      kind: p.kind,
      gangs,
      devices: p.kind === 'switch' ? p.positions.map(() => 'rocker') : ['duplex receptacle'],
      conf: 'high',
      notes: p.notes || '',
      file: 'examples/demo-site/README.md',
      positions: p.positions,
    });
    node.setTranslation(toGltf(p.at)).setRotation([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
    plates.addChild(node);
    const part = (name: string, mesh: Mesh, at: V3) =>
      node.addChild(m.doc.createNode(name).setMesh(mesh).setTranslation(at));
    if (p.kind === 'outlet') {
      part('plate', pm.plate1, [0, 0, 0]);
      part('receptacle_1', pm.socket, [0, 0.025, 0]);
      part('receptacle_2', pm.socket, [0, -0.025, 0]);
    } else {
      part('plate', gangs > 1 ? pm.plate2 : pm.plate1, [0, 0, 0]);
      for (let i = 0; i < gangs; i++) part(`rocker_${i + 1}`, pm.rocker, [gangs > 1 ? (i - 0.5) * 0.045 : 0, 0, 0]);
    }
  }
}

/** the main model: its parts in this order (the order of the nodes in demo.glb) */
export function buildMain(plaque: Uint8Array): Model {
  const m = new Model('jarvis tools/make-demo-site.ts');
  housePlaque(m, plaque);
  floors(m);
  walls(m);
  openings(m);
  stair(m);
  roof(m);
  garageRoof(m);
  for (const a of AREAS) a.buildMain?.(m);
  lightFixtures(m, 'main');
  wallPlates(m);
  return m;
}
