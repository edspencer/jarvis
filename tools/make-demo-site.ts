// npm run demo-site: generates examples/demo-site, a small synthetic two-storey house that exercises most of the viewer
// (docs/model-format.md): rooms with Floor_* nodes, walls with door and window openings, a stair, ceilings, a hip roof,
// glazing, light fixtures, wall plates, plants, a pond, a pergola the K key toggles, a furniture model, parts files,
// blueprint sheets and the plugins' data files (a mock Home Assistant map and controls, registry pins, a device map,
// an energy map).
// Deterministic: running it again writes the same bytes (CI checks that the committed copy is up to date).
//
// Plan frame: X east, Y north, Z up, metres (the manifest's frame.units is "m"); the origin is the house's south-west
// corner at finished ground-floor level. The footprint is 12 × 9 m.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Logger, NodeIO, type Material, type Mesh, type Node, type Scene } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import * as prettier from 'prettier';
import { Geo, Shape, toGltf, type V3 } from './demo-site/geometry.ts';
import { Canvas } from './demo-site/png.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'examples/demo-site');
const REPO = 'https://github.com/edspencer/jarvis';

// ------------------------------------------------------------------ the building's dimensions (plan metres)
const W = 12, // east-west
  D = 9; // north-south
const EXT = 0.25, // exterior wall thickness (outside the footprint)
  INT = 0.12; // interior walls (centred on their line)
const UP = 3.2; // first-floor level
const SLAB = 2.9; // underside of the first floor
const CEIL0 = 2.7, // ground-floor ceilings
  CEIL1 = 5.6; // first-floor ceilings
const EAVE = 5.95; // top of the roof at the eaves line... the wall plate
const OVERHANG = 0.5;
const PITCH = 30; // degrees
// the stair: 18 risers from 0 to UP, 17 treads running north from y = 3.0 along the east wall
const RISERS = 18,
  TREAD = 0.27,
  STAIR_Y0 = 3.0,
  STAIR_X = [10.66, 12] as const;
const STAIR_Y1 = STAIR_Y0 + (RISERS - 1) * TREAD; // 7.59: the top tread meets the landing

const G = { lawn: -0.15 };

// ------------------------------------------------------------------ materials
type Rgba = [number, number, number, number];
const hex = (h: string, a = 1): Rgba => {
  const n = parseInt(h.slice(1), 16);
  // glTF colours are linear
  const lin = (c: number) => {
    const s = c / 255;
    return Math.round((s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * 1e4) / 1e4;
  };
  return [lin(n >> 16), lin((n >> 8) & 255), lin(n & 255), a];
};
const MATERIALS: Record<string, { c: Rgba; rough?: number; metal?: number; blend?: boolean; double?: boolean }> = {
  render_white: { c: hex('#e9e4d8'), rough: 0.9 },
  plaster: { c: hex('#f1ede4'), rough: 0.95 },
  plaster_bath: { c: hex('#dfe9ea'), rough: 0.8 },
  floor_oak: { c: hex('#a77b4f'), rough: 0.6 },
  floor_tile: { c: hex('#c9c2b4'), rough: 0.5 },
  carpet: { c: hex('#8d8f99'), rough: 1 },
  ceiling: { c: hex('#f7f5f0'), rough: 1 },
  slab_edge: { c: hex('#cfc8ba'), rough: 0.9 },
  roof_tile: { c: hex('#8c4a36'), rough: 0.85 },
  soffit: { c: hex('#f4f1ea'), rough: 0.9 },
  stair_oak: { c: hex('#8a6038'), rough: 0.55 },
  rail: { c: hex('#f2f2f2'), rough: 0.5 },
  glass: { c: hex('#bcd4e6', 0.3), rough: 0.05, blend: true },
  window_frame: { c: hex('#f5f5f2'), rough: 0.4 },
  door_oak: { c: hex('#9a6a3c'), rough: 0.55 },
  entry_door: { c: hex('#2e4a6b'), rough: 0.4 },
  terrace_stone: { c: hex('#bdb3a0'), rough: 0.85 },
  path_gravel: { c: hex('#cfc4ad'), rough: 1 },
  lawn: { c: hex('#6a9447'), rough: 1 },
  water: { c: hex('#3d6f8f', 0.75), rough: 0.05, blend: true },
  pond_stone: { c: hex('#8f8a80'), rough: 0.9 },
  pergola_timber: { c: hex('#7b5a3b'), rough: 0.8 },
  cabinet: { c: hex('#e7e3da'), rough: 0.5 },
  worktop: { c: hex('#3b3b3d'), rough: 0.3 },
  sanitary: { c: hex('#fbfbfb'), rough: 0.2 },
  fixture_metal: { c: hex('#2b2b2b'), rough: 0.4, metal: 0.8 },
  fixture_trim: { c: hex('#f2f2f2'), rough: 0.4 },
  lamp_shade: { c: hex('#f3ead2'), rough: 0.8, double: true },
  bulb: { c: hex('#fff6e0'), rough: 0.2 },
  lens: { c: hex('#fbf8ee'), rough: 0.3 },
  globe: { c: hex('#f6f3ea'), rough: 0.3 },
  led_diffuser: { c: hex('#fdfbf5'), rough: 0.3 },
  lantern_glass: { c: hex('#fff1c9', 0.85), rough: 0.1, blend: true },
  plate_white: { c: hex('#f6f5f0'), rough: 0.35 },
  rocker_white: { c: hex('#ecebe6'), rough: 0.3 },
  receptacle: { c: hex('#e2e0d8'), rough: 0.4 },
  bark: { c: hex('#5d4532'), rough: 1 },
  foliage: { c: hex('#3f7234'), rough: 0.9 },
  foliage_light: { c: hex('#6e9a3c'), rough: 0.9 },
  // furniture
  fabric_grey: { c: hex('#7d8086'), rough: 1 },
  fabric_blue: { c: hex('#45607e'), rough: 1 },
  wood_walnut: { c: hex('#5c3f2a'), rough: 0.5 },
  wood_ash: { c: hex('#c9ab82'), rough: 0.6 },
  linen: { c: hex('#ece6da'), rough: 1 },
  rug: { c: hex('#b4553c'), rough: 1 },
  books_red: { c: hex('#9c3b32'), rough: 0.8 },
  books_blue: { c: hex('#33557a'), rough: 0.8 },
  art_print: { c: hex('#6d9bb8'), rough: 0.6 },
  black_steel: { c: hex('#1f1f21'), rough: 0.5, metal: 0.6 },
};

/** a glTF document with the demo's materials, made on first use */
class Model {
  doc = new Document().setLogger(new Logger(Logger.Verbosity.WARN));
  buffer = this.doc.createBuffer();
  scene: Scene = this.doc.createScene('Scene');
  private mats = new Map<string, Material>();
  /** merged key -> parts entries (docs/model-format.md §7) */
  parts: Record<string, [string, number[], string[], Record<string, unknown>][]> = {};
  constructor(generator: string) {
    this.doc.getRoot().getAsset().generator = generator;
    this.doc.getRoot().setDefaultScene(this.scene);
  }
  material(name: string): Material {
    let m = this.mats.get(name);
    if (m) return m;
    const d = MATERIALS[name];
    if (!d) throw new Error(`no material ${name}`);
    m = this.doc
      .createMaterial(name)
      .setBaseColorFactor(d.c)
      .setRoughnessFactor(d.rough ?? 0.8)
      .setMetallicFactor(d.metal ?? 0)
      .setDoubleSided(!!d.double);
    if (d.blend) m.setAlphaMode('BLEND');
    this.mats.set(name, m);
    return m;
  }
  mesh(name: string, shape: Shape): Mesh {
    const mesh = this.doc.createMesh(name);
    for (const [mat, g] of [...shape.byMaterial].sort(([a], [b]) => a.localeCompare(b))) {
      if (g.empty) continue;
      const acc = (
        type: 'VEC3' | 'SCALAR',
        arr: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>,
      ) => this.doc.createAccessor().setType(type).setArray(arr).setBuffer(this.buffer);
      const n = g.positions.length / 3;
      mesh.addPrimitive(
        this.doc
          .createPrimitive()
          .setAttribute('POSITION', acc('VEC3', new Float32Array(g.positions)))
          .setAttribute('NORMAL', acc('VEC3', new Float32Array(g.normals)))
          .setIndices(acc('SCALAR', n > 65535 ? new Uint32Array(g.indices) : new Uint16Array(g.indices)))
          .setMaterial(this.material(mat)),
      );
    }
    return mesh;
  }
  /** a node; added to the scene unless a parent is given */
  node(
    name: string,
    what: Shape | Mesh | null,
    extras: Record<string, unknown> = {},
    opts: { at?: V3; yaw?: number; parent?: Node } = {},
  ): Node {
    const n = this.doc.createNode(name);
    if (what) n.setMesh(what instanceof Shape ? this.mesh(name, what) : what);
    if (Object.keys(extras).length) n.setExtras(extras);
    if (opts.at) n.setTranslation(toGltf(opts.at));
    if (opts.yaw) n.setRotation([0, Math.sin(opts.yaw / 2), 0, Math.cos(opts.yaw / 2)]);
    if (opts.parent) opts.parent.addChild(n);
    else this.scene.addChild(n);
    return n;
  }
  async write(file: string): Promise<number> {
    await MeshoptEncoder.ready;
    this.doc.createExtension(KHRMeshQuantization);
    this.doc.createExtension(EXTMeshoptCompression).setRequired(true);
    await this.doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const io = new NodeIO()
      .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
      .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
    const bytes = await io.writeBinary(this.doc);
    await writeFile(file, bytes);
    return bytes.byteLength;
  }
}

/** a solid built of boxes, all one material, recorded as one part of a merged node */
interface Piece {
  name: string;
  material: string;
  boxes: number[][];
  extras?: Record<string, unknown>;
}
function merged(model: Model, name: string, key: string, pieces: Piece[], extras: Record<string, unknown> = {}): Node {
  const shape = new Shape();
  const list: [string, number[], string[], Record<string, unknown>][] = [];
  for (const p of pieces) {
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (const b of p.boxes) {
      shape.on(p.material).box(b[0], b[1], b[2], b[3], b[4], b[5]);
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], b[i]);
        hi[i] = Math.max(hi[i], b[i + 3]);
      }
    }
    list.push([p.name, Geo.gltfBox(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]), [p.material], p.extras || {}]);
  }
  model.parts[key] = list;
  return model.node(name, shape, { merged: key, ...extras });
}

// ------------------------------------------------------------------ rooms
interface Room {
  id: string;
  name: string;
  storey: 0 | 1;
  /** floor rectangles [x0, y0, x1, y1] */
  rects: number[][];
  floor: string;
  /** ceiling rectangles, if not the floor's */
  ceil?: number[][];
}
const ROOMS: Room[] = [
  { id: 'living_room', name: 'Living room', storey: 0, rects: [[0, 0, 7, 5]], floor: 'floor_oak' },
  { id: 'kitchen', name: 'Kitchen', storey: 0, rects: [[0, 5, 7, 9]], floor: 'floor_tile' },
  {
    id: 'hall',
    name: 'Hall',
    storey: 0,
    rects: [
      [7, 0, 12, 4],
      [10.6, 4, 12, 9],
    ],
    floor: 'floor_tile',
    ceil: [
      [7, 0, 12, STAIR_Y0],
      [7, STAIR_Y0, 10.6, 4],
    ],
  },
  { id: 'study', name: 'Study', storey: 0, rects: [[7, 4, 10.6, 9]], floor: 'floor_oak' },
  { id: 'bedroom_1', name: 'Bedroom 1', storey: 1, rects: [[0, 0, 7, 5]], floor: 'carpet' },
  { id: 'bedroom_2', name: 'Bedroom 2', storey: 1, rects: [[0, 5, 7, 9]], floor: 'carpet' },
  { id: 'bathroom', name: 'Bathroom', storey: 1, rects: [[7, 0, 12, 3]], floor: 'floor_tile' },
  {
    id: 'landing',
    name: 'Landing',
    storey: 1,
    // around the stairwell (x 10.6-12, y 3.0-7.6)
    rects: [
      [7, 3, 10.6, 9],
      [10.6, STAIR_Y1, 12, 9],
    ],
    floor: 'carpet',
    ceil: [[7, 3, 12, 9]],
  },
];
const roomCentre = (r: Room): V3 => {
  const [x0, y0, x1, y1] = r.rects[0];
  return [(x0 + x1) / 2, (y0 + y1) / 2, r.storey ? UP : 0];
};

// ------------------------------------------------------------------ walls and openings
interface Opening {
  /** along the wall, plan metres */
  a: number;
  b: number;
  sill: number;
  head: number;
  kind: 'window' | 'door' | 'glazed' | 'open';
  id?: string;
  material?: string;
}
interface Wall {
  name: string;
  storey: 0 | 1;
  /** 'x': runs east-west at y in [c0, c1]; 'y': runs north-south at x in [c0, c1] */
  dir: 'x' | 'y';
  c0: number;
  c1: number;
  from: number;
  to: number;
  z0: number;
  z1: number;
  material: string;
  openings: Opening[];
  exterior?: boolean;
}
const win = (id: string, a: number, b: number, sill = 0.9, head = 2.2): Opening => ({
  id,
  a,
  b,
  sill,
  head,
  kind: 'window',
});
const door = (id: string, a: number, b: number, material = 'door_oak'): Opening => ({
  id,
  a,
  b,
  sill: 0,
  head: 2.1,
  kind: 'door',
  material,
});
const open = (a: number, b: number, head = 2.3): Opening => ({ a, b, sill: 0, head, kind: 'open' });

const ext = (name: string, storey: 0 | 1, side: 'S' | 'N' | 'W' | 'E', openings: Opening[]): Wall => {
  const z0 = storey ? UP : 0,
    z1 = storey ? EAVE : UP;
  const ew = side === 'S' || side === 'N';
  const [c0, c1] = side === 'S' ? [-EXT, 0] : side === 'N' ? [D, D + EXT] : side === 'W' ? [-EXT, 0] : [W, W + EXT];
  return {
    name,
    storey,
    dir: ew ? 'x' : 'y',
    c0,
    c1,
    from: ew ? -EXT : 0,
    to: ew ? W + EXT : D,
    z0,
    z1,
    material: 'render_white',
    openings: openings.map((o) => ({ ...o, sill: o.sill + z0, head: o.head + z0 })),
    exterior: true,
  };
};
const int = (
  name: string,
  storey: 0 | 1,
  dir: 'x' | 'y',
  c: number,
  from: number,
  to: number,
  openings: Opening[] = [],
  material = 'plaster',
  z1?: number,
): Wall => {
  const z0 = storey ? UP : 0;
  return {
    name,
    storey,
    dir,
    c0: c - INT / 2,
    c1: c + INT / 2,
    from,
    to,
    z0,
    z1: z1 ?? (storey ? CEIL1 : SLAB),
    material,
    openings: openings.map((o) => ({ ...o, sill: o.sill + z0, head: o.head + z0 })),
  };
};

const WALLS: Wall[] = [
  // ground floor
  ext('South wall (ground)', 0, 'S', [
    win('living_s1', 1.2, 3.0),
    win('living_s2', 4.0, 5.8),
    door('front', 9.0, 10.0, 'entry_door'),
    win('hall_s', 10.8, 11.6, 1.0),
  ]),
  ext('North wall (ground)', 0, 'N', [
    win('kitchen_n', 1.2, 3.2, 1.05),
    { ...win('patio', 4.4, 6.4, 0, 2.2), kind: 'glazed' },
    win('study_n', 8.0, 9.6),
  ]),
  ext('West wall (ground)', 0, 'W', [win('living_w', 1.8, 3.4), win('kitchen_w', 6.0, 7.4, 1.05)]),
  ext('East wall (ground)', 0, 'E', [win('stair_e', 5.0, 6.4, 1.4, 2.6)]),
  int('Living / hall wall', 0, 'y', 7, 0, 5, [open(2.6, 3.8)]),
  int('Kitchen / study wall', 0, 'y', 7, 5, 9),
  int('Living / kitchen wall', 0, 'x', 5, 0, 6.94, [open(2.4, 4.4)]),
  int('Hall / study wall', 0, 'x', 4, 7.06, 10.66, [door('study', 8.0, 8.9)]),
  int('Study / stair wall', 0, 'y', 10.6, 4, 9),
  // first floor
  ext('South wall (first)', 1, 'S', [
    win('bed1_s1', 1.2, 3.0),
    win('bed1_s2', 4.0, 5.8),
    win('bath_s', 9.2, 10.4, 1.4, 2.2),
  ]),
  ext('North wall (first)', 1, 'N', [win('bed2_n', 2.0, 4.0), win('landing_n', 8.0, 9.6)]),
  ext('West wall (first)', 1, 'W', [win('bed1_w', 1.8, 3.4), win('bed2_w', 6.0, 7.4)]),
  ext('East wall (first)', 1, 'E', [win('stairwell_e', 5.0, 6.4, 0.6, 1.8)]),
  int('Bedrooms / landing wall', 1, 'y', 7, 0, 9, [door('bed1', 3.7, 4.6), door('bed2', 6.6, 7.5)]),
  int('Bedroom 1 / 2 wall', 1, 'x', 5, 0, 6.94),
  int('Bathroom / landing wall', 1, 'x', 3, 7.06, 12, [door('bath', 7.6, 8.5)], 'plaster_bath'),
];

/** the boxes of a wall, around its openings */
function wallBoxes(w: Wall): number[][] {
  const out: number[][] = [];
  const box = (a: number, b: number, z0: number, z1: number) => {
    if (b - a < 1e-3 || z1 - z0 < 1e-3) return;
    out.push(w.dir === 'x' ? [a, w.c0, z0, b, w.c1, z1] : [w.c0, a, z0, w.c1, b, z1]);
  };
  let at = w.from;
  for (const o of [...w.openings].sort((p, q) => p.a - q.a)) {
    box(at, o.a, w.z0, w.z1);
    box(o.a, o.b, w.z0, o.sill);
    box(o.a, o.b, o.head, w.z1);
    at = o.b;
  }
  box(at, w.to, w.z0, w.z1);
  return out;
}

// ------------------------------------------------------------------ fixtures
interface Fixture {
  id: string;
  kind: 'can' | 'pendant' | 'flush' | 'bar' | 'lantern' | 'wall' | 'floor_lamp';
  group: string;
  room: string;
  at: V3;
  /** wall fixtures: the direction they face (yaw, radians, about plan Z: 0 = facing plan -Y... see fixtureShape) */
  yaw?: number;
}
const FIXTURES: Fixture[] = [
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
function fixtureShape(kind: Fixture['kind']): Shape {
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

// ------------------------------------------------------------------ wall plates (docs/model-format.md §8)
interface PlateSpec {
  id: string;
  room: string;
  kind: 'switch' | 'outlet';
  /** the plate's centre on the wall face, and the face's outward normal (plan) */
  at: V3;
  normal: [number, number];
  positions: Record<string, unknown>[];
  notes?: string;
}
const PLATES: PlateSpec[] = [
  {
    id: 'LV-S-A',
    room: 'living_room',
    kind: 'switch',
    at: [7 - INT / 2, 2.45, 1.2],
    normal: [-1, 0],
    positions: [
      {
        pos: 1,
        role: 'living room cans',
        breaker: '7',
        fixture_ids: FIXTURES.filter((f) => f.group === 'fixture.cans.living').map((f) => f.id),
        ha_entity: 'light.living_room_cans',
      },
      {
        pos: 2,
        role: 'hall pendant (three-way with HL-S-A)',
        breaker: '7',
        fixture_ids: ['hall.pendant'],
        link: { box: 'HL-S-A', pos: 2, dir: 'with' },
      },
    ],
    notes: 'Two-gang; position 2 is three-way with HL-S-A by the front door.',
  },
  {
    id: 'HL-S-A',
    room: 'hall',
    kind: 'switch',
    at: [10.35, 0, 1.2],
    normal: [0, 1],
    positions: [
      { pos: 1, role: 'porch lantern', breaker: '9', fixture_ids: ['porch.lantern'], ha_entity: 'light.porch' },
      {
        pos: 2,
        role: 'hall pendant (three-way with LV-S-A)',
        breaker: '7',
        fixture_ids: ['hall.pendant'],
        ha_entity: 'light.hall',
        link: { box: 'LV-S-A', pos: 2, dir: 'with' },
      },
    ],
  },
  {
    id: 'KT-S-A',
    room: 'kitchen',
    kind: 'switch',
    at: [4.6, 5 + INT / 2, 1.2],
    normal: [0, 1],
    positions: [
      {
        pos: 1,
        role: 'kitchen pendants',
        breaker: '11',
        fixture_ids: FIXTURES.filter((f) => f.group === 'fixture.pendants.kitchen').map((f) => f.id),
      },
    ],
  },
  {
    id: 'LV-O-A',
    room: 'living_room',
    kind: 'outlet',
    at: [0, 4.2, 0.35],
    normal: [1, 0],
    positions: [{ pos: 1, role: 'floor lamp (switched half)', breaker: '5', fixture_ids: ['living.floor_lamp'] }],
  },
  {
    id: 'BA-S-A',
    room: 'landing',
    kind: 'switch',
    at: [8.75, 3 + INT / 2, UP + 1.2],
    normal: [0, 1],
    positions: [
      {
        pos: 1,
        role: 'vanity light',
        breaker: '14',
        fixture_ids: ['bathroom.vanity'],
        ha_entity: 'switch.bathroom_vanity',
      },
    ],
  },
];

// ------------------------------------------------------------------ the main model
function buildMain(): Model {
  const m = new Model('jarvis tools/make-demo-site.ts');

  // the site: lawn, front path, back terrace (one merged node)
  merged(m, 'Site', 'site', [
    { name: 'Lawn', material: 'lawn', boxes: [[-54, -52, G.lawn - 0.1, 66, 62, G.lawn]], extras: { kind: 'ground' } },
    { name: 'Front path', material: 'path_gravel', boxes: [[8.8, -8, G.lawn, 10.2, -EXT, -0.02]] },
    { name: 'Front step', material: 'terrace_stone', boxes: [[8.6, -1.2, G.lawn, 10.4, -EXT, 0]] },
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

  // floors (one node per room: the room list and "where am I") and ceilings
  for (const r of ROOMS) {
    const s = new Shape();
    const z1 = r.storey ? UP : 0,
      z0 = r.storey ? SLAB : -0.1;
    for (const [x0, y0, x1, y1] of r.rects) s.on(r.floor).box(x0, y0, z1 - 0.02, x1, y1, z1);
    if (r.storey) for (const [x0, y0, x1, y1] of r.rects) s.on('slab_edge').box(x0, y0, z0, x1, y1, z1 - 0.02);
    else for (const [x0, y0, x1, y1] of r.rects) s.on('slab_edge').box(x0, y0, z0, x1, y1, z1 - 0.02);
    m.node(`Floor_${r.id}`, s, { room: r.id, storey: r.storey ? 'first' : 'ground' });
    const c = new Shape();
    const cz = r.storey ? CEIL1 : CEIL0;
    for (const [x0, y0, x1, y1] of r.ceil || r.rects) c.on('ceiling').box(x0, y0, cz, x1, y1, cz + 0.02);
    m.node(`Ceil_${r.id}`, c, { room: r.id });
  }

  // walls, by storey (merged: the parts file names each wall)
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

  // windows and doors in the openings
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
        m.node(`Door_${o.id}`, s, { door_leaf: true, width_m: +(o.b - o.a).toFixed(2) });
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

  // the stair: solid treads (a step of 0.178 m, under walk.maxStep), merged
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
    boxes: Array.from({ length: RISERS - 1 }, (_, i) => {
      const z = ((i + 1) * UP) / RISERS + 0.9;
      return [STAIR_X[0] - 0.02, STAIR_Y0 + i * TREAD, z, STAIR_X[0] + 0.02, STAIR_Y0 + (i + 1) * TREAD, z + 0.05];
    }),
    extras: { kind: 'handrail' },
  });
  merged(m, 'Stair', 'stair', treads, { room: 'hall' });

  // built-ins: kitchen run, bath, vanity
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
  merged(
    m,
    'Bathroom_fittings',
    'bathroom_fittings',
    [
      {
        name: 'Bath',
        material: 'sanitary',
        boxes: [[10.2, 1.25, UP, 12, 2.95, UP + 0.55]],
        extras: { product: '1700 × 700 bath' },
      },
      { name: 'Vanity unit', material: 'cabinet', boxes: [[9.3, 0, UP, 10.3, 0.5, UP + 0.85]] },
      { name: 'Basin', material: 'sanitary', boxes: [[9.45, 0.05, UP + 0.85, 10.15, 0.45, UP + 0.9]] },
      { name: 'WC', material: 'sanitary', boxes: [[7.4, 0.1, UP, 7.8, 0.75, UP + 0.42]] },
    ],
    { room: 'bathroom' },
  );

  // the roof: a hip roof on the walls, with soffits (all in the roof layer)
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

  // the pergola over the back terrace: the site's own layer (key K)
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

  // light fixtures: one node each, sharing a mesh per kind
  const fxMesh = new Map<string, Mesh>();
  for (const f of FIXTURES) {
    if (!fxMesh.has(f.kind)) fxMesh.set(f.kind, m.mesh(`fixture_${f.kind}`, fixtureShape(f.kind)));
    m.node(
      `Fixture_${f.id}`,
      fxMesh.get(f.kind)!,
      { fixture_id: f.id, fixture_kind: f.kind, fixture_group: f.group, room: f.room },
      { at: f.at, yaw: f.yaw },
    );
  }

  // wall plates: one group (layer: switches), a node per plate (+Z out of the wall), a child per part
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

  // plants: one group (layer: plants), a node per plant, sharing a mesh per kind
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
    ['tree.2', 'tree', 'Field maple (Acer campestre)', 17, 3],
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

  return m;
}

// ------------------------------------------------------------------ furniture (an extra model, layer: furniture)
function buildFurniture(): Model {
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

// ------------------------------------------------------------------ the plugins' data
/** plan point -> viewer (three.js) metres */
const pos = (p: V3) => toGltf(p).map((v) => +v.toFixed(4)) as V3;
const eye = (r: Room): V3 => {
  const [x, y, z] = roomCentre(r);
  return pos([x, y, z + 1.2]);
};

function haMap() {
  const map: Record<string, unknown> = {};
  for (const f of FIXTURES.filter((f) => f.group === 'fixture.cans.living'))
    map[f.id] = { entity_id: 'light.living_room_cans', conf: 'high', group: f.group };
  for (const [i, f] of FIXTURES.filter((f) => f.group === 'fixture.pendants.kitchen').entries())
    map[f.id] = { entity_id: `light.kitchen_pendant_${i + 1}`, conf: 'high', group: f.group, unavailable_means: 'off' };
  map['hall.pendant'] = { entity_id: 'light.hall', conf: 'high', group: 'fixture.hall' };
  map['study.ceiling'] = { entity_id: 'light.study', conf: 'med', group: 'fixture.study' };
  map['bedroom_1.ceiling'] = { entity_id: 'light.bedroom_1', conf: 'high', group: 'fixture.bedroom_1' };
  map['bedroom_2.ceiling'] = { entity_id: null, conf: 'low', group: 'fixture.bedroom_2' };
  map['landing.ceiling'] = { entity_id: null, conf: 'low', group: 'fixture.landing' };
  map['bathroom.vanity'] = {
    entity_id: 'switch.bathroom_vanity',
    conf: 'high',
    group: 'fixture.bathroom',
    switch_is_light: true,
  };
  map['porch.lantern'] = { entity_id: 'light.porch', conf: 'high', group: 'fixture.porch' };
  for (const f of FIXTURES.filter((f) => f.group === 'fixture.terrace'))
    map[f.id] = { entity_id: 'light.terrace_wall_lights', conf: 'high', group: f.group };
  map['living.floor_lamp'] = { entity_id: 'light.floor_lamp', conf: 'high', group: 'fixture.lamp.living' };
  return map;
}

const haControls = () => ({
  controls: [
    {
      id: 'film',
      label: 'Film night',
      entity_id: 'script.film_night',
      action: 'run',
      mock: { lights_off: ['living_room', 'kitchen', 'hall'] },
    },
    {
      id: 'goodnight',
      label: 'Good night',
      entity_id: 'script.goodnight',
      action: 'run',
      confirm: 'Run Good night? It turns off every light in the house.',
      mock: { lights_off: ['*'] },
    },
    {
      id: 'fountain',
      label: 'Pond pump',
      entity_id: 'switch.pond_pump',
      action: 'toggle',
      power: 'sensor.pond_pump_power',
    },
  ],
  fixture_toggle: { light: true, switch_marked_as_light: true },
});

interface Pin {
  id: string;
  name: string;
  category: string;
  room: string;
  at: V3;
  make?: string;
  model?: string;
  approx?: 'room-centroid' | 'z-guess' | null;
  fixtures?: string[];
  ha?: string[];
  specs?: [string, string][];
  note?: string;
}
const PINS: Pin[] = [
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
    note: 'In the cupboard under the landing.',
  },
  {
    id: 'hvac.thermostat',
    name: 'Thermostat',
    category: 'hvac',
    room: 'hall',
    at: [7 + INT / 2 + 0.01, 0.8, 1.5],
    make: 'Example Controls',
    model: 'T-100',
    ha: ['climate.thermostat'],
  },
  {
    id: 'elec.panel',
    name: 'Consumer unit',
    category: 'elec',
    room: 'hall',
    at: [W - 0.02, 1.0, 1.6],
    make: 'Example Electric',
    model: 'CU-18',
    specs: [
      ['ways', '18'],
      ['main', '100 A'],
    ],
  },
  {
    id: 'net.router',
    name: 'Router',
    category: 'net',
    room: 'study',
    at: [10.1, 8.6, 0.85],
    make: 'Example Networks',
    model: 'R-6',
    ha: ['device_tracker.router'],
  },
  {
    id: 'net.access-point',
    name: 'Wi-Fi access point (upstairs)',
    category: 'net',
    room: 'landing',
    at: [8.8, 6, UP + 2.2],
    approx: 'room-centroid',
    note: 'On the landing ceiling; exactly where is not recorded.',
  },
  {
    id: 'plumb.water-heater',
    name: 'Water heater',
    category: 'plumb',
    room: 'kitchen',
    at: [0.35, 8.65, 1.6],
    make: 'Example Water',
    model: 'WH-50',
    specs: [['capacity', '190 l']],
  },
  { id: 'plumb.stopcock', name: 'Main stopcock', category: 'plumb', room: 'kitchen', at: [0.3, 5.9, 0.25] },
  {
    id: 'appliance.fridge',
    name: 'Fridge-freezer',
    category: 'appliance',
    room: 'kitchen',
    at: [6.6, 8.6, 1.0],
    make: 'Example Appliances',
    model: 'FF-70',
  },
  {
    id: 'safety.smoke.landing',
    name: 'Smoke alarm (landing)',
    category: 'safety',
    room: 'landing',
    at: [9.6, 5, CEIL1 - 0.03],
    ha: ['binary_sensor.smoke_landing'],
  },
  {
    id: 'site.irrigation',
    name: 'Irrigation controller',
    category: 'site',
    room: 'exterior',
    at: [-EXT - 0.05, 6.5, 1.3],
    make: 'Example Garden',
    model: 'IC-4',
  },
  {
    id: 'fixture.kitchen-pendants',
    name: 'Kitchen pendants',
    category: 'fixture',
    room: 'kitchen',
    at: [3.5, 7, CEIL0 - 0.7],
    fixtures: ['kitchen.pendant.1', 'kitchen.pendant.2', 'kitchen.pendant.3'],
    ha: ['light.kitchen_pendant_1', 'light.kitchen_pendant_2', 'light.kitchen_pendant_3'],
  },
];

function registryPins() {
  const pins = PINS.map((p) => {
    const r = ROOMS.find((x) => x.id === p.room);
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      status: 'in-service',
      conf: 'high',
      room: p.room,
      pos: pos(p.at),
      plan: p.at.map((v) => +v.toFixed(3)),
      loc_conf: p.approx ? 'low' : 'high',
      approx: p.approx || null,
      loc_note: p.note || null,
      room_centre: r ? eye(r) : null,
      make: p.make || null,
      model: p.model || null,
      serial: null,
      aliases: [],
      specs: p.specs || [],
      connections:
        p.id === 'hvac.thermostat' ? [{ key: 'controls', text: 'the air handler', refs: ['hvac.air-handler'] }] : [],
      documents: p.model ? [{ text: `${p.model} manual (example)`, url: null }] : [],
      photos: [],
      open_questions: [],
      fixtures: p.fixtures || [],
      ha: { entities: p.ha || [] },
      health: null,
      file: 'examples/demo-site/registry_pins.json',
      referenced_by: p.id === 'hvac.air-handler' ? [{ id: 'hvac.thermostat', key: 'controls' }] : [],
    };
  });
  return {
    generated_by: 'tools/make-demo-site.ts',
    frame: 'pos: viewer metres, three.js (X, Z, -Y) of plan metres (X east, Y north, Z up); plan: plan metres',
    count: { items: pins.length + 1, pins: pins.length, unplaced: 1 },
    pins,
    unplaced: [{ id: 'envelope.gutters', name: 'Gutters and downspouts', room: 'exterior', note: 'Not modelled.' }],
  };
}

function haDevices() {
  const place = (src: string, ref: string | string[] | undefined, room: string, at: V3, approx = false) => {
    const r = ROOMS.find((x) => x.id === room);
    return {
      src,
      ref,
      plan: at.map((v) => +v.toFixed(3)),
      room: r?.name || room,
      approx,
      conf: approx ? 'low' : 'high',
      pos: pos(at),
      centre: r ? eye(r) : null,
    };
  };
  const fx = (id: string) => FIXTURES.find((f) => f.id === id)!;
  const devices = [
    ...[1, 2, 3].map((i) => ({
      id: `demo-kitchen-pendant-${i}`,
      name: `Kitchen pendant ${i}`,
      integration: 'hue',
      make: 'Example Lighting',
      model: 'A19 bulb',
      area: 'Kitchen',
      place: place('fixture', `kitchen.pendant.${i}`, 'kitchen', fx(`kitchen.pendant.${i}`).at),
      fixtures: [`kitchen.pendant.${i}`],
      unavailable_means: {
        off: 'the kitchen pendants wall switch (KT-S-A)',
        unless_on: [1, 2, 3].filter((j) => j !== i).map((j) => `light.kitchen_pendant_${j}`),
      },
      health: { avail: [`light.kitchen_pendant_${i}`], update: [`update.kitchen_pendant_${i}_firmware`] },
    })),
    {
      id: 'demo-living-dimmer',
      name: 'Living room dimmer',
      integration: 'zwave_js',
      make: 'Example Controls',
      model: 'ZD-1',
      area: 'Living room',
      place: place('plate', 'LV-S-A', 'living_room', PLATES[0].at),
      health: { avail: ['light.living_room_cans'], node_status: ['sensor.living_dimmer_node_status'] },
    },
    {
      id: 'demo-thermostat',
      name: 'Thermostat',
      integration: 'zwave_js',
      make: 'Example Controls',
      model: 'T-100',
      area: 'Hall',
      place: place('registry', 'hvac.thermostat', 'hall', PINS[1].at),
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
      place: place('area', 'hall', 'hall', [9.5, 2, 2.2], true),
      health: {
        avail: ['binary_sensor.hall_motion'],
        battery: ['sensor.hall_motion_battery'],
        seen: ['sensor.hall_motion_temperature'],
        signal: [{ entity: 'sensor.hall_motion_lqi', kind: 'lqi' }],
      },
    },
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
    {
      id: 'demo-router',
      name: 'Router',
      integration: 'mqtt',
      make: 'Example Networks',
      model: 'R-6',
      area: 'Study',
      place: place('registry', 'net.router', 'study', PINS[3].at),
      health: { avail: ['device_tracker.router'], update: ['update.router_firmware'] },
    },
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
    {
      id: 'demo-floor-lamp',
      name: 'Floor lamp bulb',
      integration: 'hue',
      make: 'Example Lighting',
      model: 'E27 bulb',
      area: 'Living room',
      place: place('fixture', 'living.floor_lamp', 'living_room', [0.55, 4.4, 1.4]),
      fixtures: ['living.floor_lamp'],
      powered_by: 'switch.living_outlet',
      health: { avail: ['light.floor_lamp'] },
    },
    {
      id: 'demo-smoke-landing',
      name: 'Smoke alarm (landing)',
      integration: 'zwave_js',
      make: 'Example Safety',
      model: 'SA-3',
      area: 'Landing',
      place: place('registry', 'safety.smoke.landing', 'landing', PINS[8].at),
      health: {
        avail: ['binary_sensor.smoke_landing'],
        node_status: ['sensor.smoke_landing_node_status'],
        battery: ['sensor.smoke_landing_battery'],
      },
    },
    {
      id: 'demo-doorbell',
      name: 'Doorbell',
      integration: 'mqtt',
      make: 'Example Security',
      model: 'DB-1',
      area: null,
      place: null,
      health: { avail: ['binary_sensor.doorbell'] },
    },
  ];
  return {
    generated_by: 'tools/make-demo-site.ts',
    thresholds: {
      battery_pct: 20,
      lqi_weak: 50,
      rssi_weak_dbm: -85,
      wifi_weak_pct: 30,
      stale_h: { zha: 25, mqtt: 25 },
    },
    devices,
  };
}

// ------------------------------------------------------------------ the energy plugin's map (docs/plugins/energy.md)
// The grid feed, the main panel and its circuits (breakers as on the wall plates), a smart plug and the pond pump's
// switch below their circuits (so there is an Other), PV and a battery. The sensors are invented: ?ha=mock makes up
// their values. Every feed names a real object: registry pins, wall plate boxes, fixture ids, rooms, model nodes.
function energyMap() {
  const SRC = 'tools/make-demo-site.ts';
  type Feed = { registry?: string; plate?: string; fixture?: string; node?: string; room?: string };
  const circuit = (
    id: string,
    label: string,
    breaker: number | number[],
    feeds: Feed[],
    extra: Record<string, unknown> = {},
  ) => {
    const two = Array.isArray(breaker);
    const sensor = id.replace(/^circuit\./, '').replace(/\W/g, '_');
    return {
      id,
      label,
      ...(two
        ? { power: [`sensor.${sensor}_l1_power`, `sensor.${sensor}_l2_power`], legs: ['L1', 'L2'], volts: 240 }
        : { power: `sensor.${sensor}_power` }),
      energy: { today: `sensor.${sensor}_energy_today` },
      panel: 'Main panel',
      breaker,
      ...(feeds.length ? { feeds } : {}),
      conf: 'high',
      src: SRC,
      ...extra,
    };
  };
  const fixtures = (group: string) => FIXTURES.filter((f) => f.group === group).map((f) => ({ fixture: f.id }));
  return {
    $schema: '../../schema/energy.schema.json',
    jarvis: 'jarvis-energy/1',
    scale: { idle: 5, max: 5000 },
    meters: [
      {
        id: 'grid',
        label: 'Grid',
        kind: 'load',
        power: 'sensor.grid_power',
        conf: 'high',
        src: SRC,
        children: [
          {
            id: 'panel.main',
            label: 'Main panel',
            power: ['sensor.main_panel_l1_power', 'sensor.main_panel_l2_power'],
            legs: ['L1', 'L2'],
            remainder: 'sensor.main_panel_balance_power',
            energy: { today: 'sensor.main_panel_energy_today', month: 'sensor.main_panel_energy_month' },
            volts: 240,
            feeds: [{ registry: 'elec.panel' }],
            conf: 'high',
            src: SRC,
            children: [
              circuit('circuit.kitchen_counter', 'Kitchen counter outlets', 1, [
                { node: 'Kitchen_units' },
                { room: 'kitchen' },
              ]),
              circuit('circuit.fridge', 'Fridge-freezer', 3, [{ registry: 'appliance.fridge' }]),
              circuit('circuit.range', 'Range', [2, 4], [{ node: 'Kitchen_units' }]),
              circuit('circuit.living_outlets', 'Living room outlets', 5, [
                { plate: 'LV-O-A' },
                { fixture: 'living.floor_lamp' },
                { room: 'living_room' },
              ]),
              circuit('circuit.lights_ground', 'Lighting, ground floor', 7, [
                { plate: 'LV-S-A' },
                ...fixtures('fixture.cans.living'),
                { fixture: 'hall.pendant' },
                { plate: 'HL-S-A' },
                { room: 'living_room' },
                { room: 'hall' },
              ]),
              circuit('circuit.lights_outside', 'Outside lights', 9, [
                { fixture: 'porch.lantern' },
                ...fixtures('fixture.terrace'),
              ]),
              circuit('circuit.lights_kitchen', 'Kitchen lights', 11, [
                { plate: 'KT-S-A' },
                ...fixtures('fixture.pendants.kitchen'),
                { registry: 'fixture.kitchen-pendants' },
              ]),
              circuit('circuit.study', 'Study outlets', 13, [{ room: 'study' }, { registry: 'net.router' }], {
                children: [
                  {
                    id: 'plug.desk',
                    label: 'Desk (smart plug)',
                    power: 'sensor.desk_plug_power',
                    energy: { today: 'sensor.desk_plug_energy_today' },
                    feeds: [{ node: 'Furn_desk' }],
                    conf: 'high',
                    src: SRC,
                  },
                ],
              }),
              circuit('circuit.lights_upstairs', 'Lighting, upstairs', 14, [
                { plate: 'BA-S-A' },
                { fixture: 'bathroom.vanity' },
                { fixture: 'bedroom_1.ceiling' },
                { fixture: 'bedroom_2.ceiling' },
                { fixture: 'landing.ceiling' },
                { room: 'bedroom_1' },
                { room: 'bedroom_2' },
                { room: 'bathroom' },
                { room: 'landing' },
              ]),
              circuit('circuit.bedroom_outlets', 'Bedroom outlets', 15, [{ room: 'bedroom_1' }, { room: 'bedroom_2' }]),
              circuit('circuit.garden', 'Garden and pond', 17, [{ node: 'Pond' }, { registry: 'site.irrigation' }], {
                children: [
                  {
                    id: 'switch.pond_pump',
                    label: 'Pond pump',
                    power: 'sensor.pond_pump_power',
                    feeds: [{ node: 'Pond' }],
                    conf: 'high',
                    src: SRC,
                  },
                ],
              }),
              circuit('circuit.heat_pump', 'Heat pump and air handler', [6, 8], [{ registry: 'hvac.air-handler' }]),
              circuit('circuit.water_heater', 'Water heater', [10, 12], [{ registry: 'plumb.water-heater' }]),
              circuit('circuit.dryer', 'Dryer', [16, 18], [], {
                energy: undefined,
                conf: 'low',
                question: 'The model has no laundry: where is the dryer, and is 16+18 really its breaker?',
              }),
            ],
          },
        ],
      },
      {
        id: 'pv',
        label: 'Solar',
        kind: 'source',
        power: 'sensor.solar_power',
        energy: { today: 'sensor.solar_energy_today', month: 'sensor.solar_energy_month' },
        conf: 'high',
        src: SRC,
      },
      {
        id: 'battery',
        label: 'Battery',
        kind: 'storage',
        power: 'sensor.battery_power',
        conf: 'high',
        src: SRC,
      },
    ],
  };
}

// ------------------------------------------------------------------ blueprints: one plan per storey
function blueprint(storey: 0 | 1): Uint8Array {
  const PX = 40; // pixels per metre
  const X0 = -1,
    Y1 = 10;
  const cv = new Canvas(14 * PX, 11 * PX);
  const ink = [24, 40, 72, 255],
    pale = [24, 40, 72, 70];
  const to = (x: number, y: number) => [(x - X0) * PX, (Y1 - y) * PX];
  const rect = (x0: number, y0: number, x1: number, y1: number, c: number[]) => {
    const [a, b] = to(x0, y0),
      [c2, d] = to(x1, y1);
    cv.rect(a, b, c2, d, c);
  };
  for (const r of ROOMS.filter((r) => r.storey === storey))
    for (const [x0, y0, x1, y1] of r.rects) rect(x0 + 0.05, y0 + 0.05, x1 - 0.05, y1 - 0.05, [24, 40, 72, 14]);
  for (const w of WALLS.filter((w) => w.storey === storey)) {
    const z = (storey ? UP : 0) + 1.2; // cut at 1.2 m
    for (const b of wallBoxes(w)) if (b[2] <= z && b[5] >= z) rect(b[0], b[1], b[3], b[4], ink);
    for (const o of w.openings)
      if (o.kind === 'window' || o.kind === 'glazed') {
        const mid = (w.c0 + w.c1) / 2;
        if (w.dir === 'x') rect(o.a, mid - 0.02, o.b, mid + 0.02, ink);
        else rect(mid - 0.02, o.a, mid + 0.02, o.b, ink);
      }
  }
  // the stair: treads (ground floor) or the stairwell's outline (first floor)
  for (let i = 0; i < RISERS - 1; i++) {
    const y = STAIR_Y0 + i * TREAD;
    if (!storey || i > 8) rect(STAIR_X[0], y, STAIR_X[1], y + 0.02, storey ? pale : ink);
  }
  rect(STAIR_X[0], STAIR_Y0, STAIR_X[0] + 0.03, STAIR_Y1, storey ? pale : ink);
  return cv.png();
}

// ------------------------------------------------------------------ the manifest
function manifest() {
  return {
    $schema: '../../schema/site.schema.json',
    jarvis: 'jarvis-site/1',
    id: 'demo-house',
    name: 'Demo house',
    description: 'A synthetic two-storey house made by tools/make-demo-site.ts.',
    geo: { lat: 51.4779, lon: -0.0015, timeZone: 'Europe/London' },
    frame: { units: 'm', northAzimuth: 12 },
    centre: [6, 5],
    overview: { camera: [18, -6, 19] },
    ground: { z: G.lawn - 0.02 },
    models: {
      main: { url: 'demo.glb', parts: 'demo.parts.json' },
      extra: [{ id: 'furniture', url: 'furniture.glb', parts: 'furniture.parts.json', layer: 'furniture' }],
    },
    storeys: [
      { name: 'ground floor', z: 0 },
      { name: 'first floor', short: 'upstairs', z: UP, from: 1.8, objectsFrom: SLAB - 0.05 },
    ],
    viewpoints: [
      { name: 'Front path', at: [9.5, -6, G.lawn], yaw: 10 },
      { name: 'Living room', at: [5.6, 0.8, 0], yaw: 50 },
      { name: 'Kitchen', at: [6.2, 5.6, 0], yaw: 120 },
      { name: 'Foot of the stair', at: [11.3, 1.2, 0], yaw: 0 },
      { name: 'Landing', at: [11.3, 8.3, UP], yaw: 140 },
      { name: 'Bedroom 1', at: [5.8, 4.2, UP], yaw: 135 },
      { name: 'Back terrace', at: [6, 12.4, 0], yaw: 180 },
    ],
    startView: 2,
    layers: [
      { id: 'door', label: 'Doors', key: 'O', hidden: true, help: 'door leaves', match: { extra: ['door_leaf'] } },
      { id: 'pergola', label: 'Pergola', key: 'K', help: 'the pergola', match: { namePrefix: ['Pergola_'] } },
      { id: 'furniture', label: 'Furniture', key: 'F', help: 'the furniture' },
    ],
    walk: { maxStep: 0.35 },
    plugins: {
      'home-assistant': { url: 'https://homeassistant.example.org', controls: 'ha_controls.json' },
      lights: { map: 'ha_map.json' },
      faults: { devices: 'ha_devices.json', source: 'tools/make-demo-site.ts' },
      pins: { registry: 'registry_pins.json', sourceLink: `${REPO}/blob/main/{file}` },
      switches: { source: 'tools/make-demo-site.ts' },
      blueprints: { index: 'blueprints/index.json', default: 'A-1' },
      energy: { map: 'energy.json' },
      // (no assistant: it needs a server of its own, docs/assistant.md; the e2e test adds the section)
    },
  };
}

function blueprintIndex() {
  const corners = (z: number) => ({ tl: [-1, 10, z], tr: [13, 10, z], bl: [-1, -1, z], br: [13, -1, z] });
  return {
    sheets: [
      {
        id: 'A-1',
        title: 'A-1 ground floor plan',
        kind: 'plan',
        file: 'A-1.png',
        z_floor: 0,
        corners: corners(0.01),
        rms: 0,
      },
      {
        id: 'A-2',
        title: 'A-2 first floor plan',
        kind: 'plan',
        file: 'A-2.png',
        z_floor: UP,
        corners: corners(UP + 0.01),
        rms: 0,
      },
    ],
  };
}

// ------------------------------------------------------------------ write it all
const json = (o: unknown) => JSON.stringify(o, null, 2) + '\n';
async function main(): Promise<void> {
  await mkdir(join(OUT, 'blueprints'), { recursive: true });
  const main = buildMain(),
    furn = buildFurniture();
  const sizes: Record<string, number> = {};
  sizes['demo.glb'] = await main.write(join(OUT, 'demo.glb'));
  sizes['furniture.glb'] = await furn.write(join(OUT, 'furniture.glb'));
  const files: Record<string, string | Uint8Array> = {
    'site.json': json(manifest()),
    'demo.parts.json': json({
      about: 'tools/make-demo-site.ts: the objects merged into the main model',
      parts: main.parts,
    }),
    'furniture.parts.json': json({ about: 'tools/make-demo-site.ts: the furniture', parts: furn.parts }),
    'ha_map.json': json(haMap()),
    'ha_controls.json': json(haControls()),
    'ha_devices.json': json(haDevices()),
    'registry_pins.json': json(registryPins()),
    'energy.json': json(energyMap()),
    'blueprints/index.json': json(blueprintIndex()),
    'blueprints/A-1.png': blueprint(0),
    'blueprints/A-2.png': blueprint(1),
  };
  for (const [name, raw] of Object.entries(files)) {
    const file = join(OUT, name);
    // JSON as Prettier writes it, so the committed files pass format:check
    const data =
      typeof raw === 'string'
        ? await prettier.format(raw, { ...(await prettier.resolveConfig(file)), filepath: file })
        : raw;
    await writeFile(file, data);
    sizes[name] = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  }
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(sizes)) console.log(`${k.padEnd(24)} ${(v / 1024).toFixed(1).padStart(7)} KB`);
  console.log(`${'total'.padEnd(24)} ${(total / 1024).toFixed(1).padStart(7)} KB  -> ${OUT}`);
}
await main();
