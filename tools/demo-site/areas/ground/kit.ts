// Helpers for the ground floor's areas (living, kitchen, hall): pieces of furniture as lists of boxes, drawn about
// their own origin, then either baked into a room's merged node (turned by quarter turns and moved) or placed as a node
// of their own (turned by any angle; a repeated piece shares one mesh).
//
// What a demo model costs is mostly its glTF JSON: every (mesh, material) pair is a primitive with its own accessors
// and buffer views (about 1 KB each). So the rooms' static furniture is one merged node per room (model.ts's merged(),
// with a parts entry per piece and material), pieces use few materials, and a box is drawn whole (full boxes share
// their normals' accessors) unless it is a "decal": one face of a thin box, just proud of what it is on, in a big node.
//
// A piece's local frame: plan metres, its footprint centred on the origin, its floor at z = 0 and its **front facing
// -Y**. Turning is anticlockwise in plan (seen from above): a piece faces south at 0°, east at 90°, north at 180°, west
// at -90°.
import type { Mesh, Node } from '@gltf-transform/core';
import { Geo, Shape, type V3 } from '../../geometry.ts';
import { hex, type MaterialDef, type Model } from '../../model.ts';

/** a box's face, by its outward direction */
export type Dir = 'x-' | 'x+' | 'y-' | 'y+' | 'z-' | 'z+';
const DIRS: Dir[] = ['x-', 'x+', 'y-', 'y+', 'z-', 'z+'];
/** [material, [x0, y0, z0, x1, y1, z1], faces?]: with faces ('y-', 'x+z+', …) only those are drawn */
export type Box = [string, number[]] | [string, number[], string];

/** a box's faces into a Geo (all six, or only those listed) */
function addBox(g: Geo, b: number[], only?: string): void {
  const [x0, y0, z0, x1, y1, z1] = b;
  if (!only) return g.box(x0, y0, z0, x1, y1, z1);
  const c: V3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const face: Record<Dir, V3[]> = {
    'x-': [
      [x0, y0, z0],
      [x0, y1, z0],
      [x0, y1, z1],
      [x0, y0, z1],
    ],
    'x+': [
      [x1, y0, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x1, y0, z1],
    ],
    'y-': [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y0, z1],
      [x0, y0, z1],
    ],
    'y+': [
      [x0, y1, z0],
      [x1, y1, z0],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
    'z-': [
      [x0, y0, z0],
      [x1, y0, z0],
      [x1, y1, z0],
      [x0, y1, z0],
    ],
    'z+': [
      [x0, y0, z1],
      [x1, y0, z1],
      [x1, y1, z1],
      [x0, y1, z1],
    ],
  };
  for (const d of DIRS) if (only.includes(d)) g.face(face[d], c);
}

/** a shape of boxes */
export function boxes(parts: Box[], s = new Shape()): Shape {
  for (const [mat, b, only] of parts) addBox(s.on(mat), b, only);
  return s;
}

/** a piece's boxes turned by quarter turns (anticlockwise) about its origin, then moved to a plan point */
export function moved(parts: Box[], at: V3, quarter = 0): Box[] {
  const q = ((quarter % 4) + 4) % 4;
  const turnDir: Record<string, string> = { 'x+': 'y+', 'y+': 'x-', 'x-': 'y-', 'y-': 'x+' };
  return parts.map(([mat, b, only]) => {
    let [x0, y0, x1, y1] = [b[0], b[1], b[3], b[4]];
    let faces = only;
    for (let i = 0; i < q; i++) {
      [x0, y0, x1, y1] = [-y1, x0, -y0, x1];
      faces = faces?.replace(/[xy][+-]/g, (d) => turnDir[d]);
    }
    const box = [x0 + at[0], y0 + at[1], b[2] + at[2], x1 + at[0], y1 + at[1], b[5] + at[2]];
    return faces ? [mat, box, faces] : [mat, box];
  });
}

/** a flat disc (n-gon) facing up at height z */
export function disc(s: Shape, mat: string, x: number, y: number, z: number, r: number, n = 8): void {
  const pts: V3[] = Array.from({ length: n }, (_, i) => {
    const a = Math.PI / n + (i / n) * 2 * Math.PI;
    return [x + r * Math.cos(a), y + r * Math.sin(a), z];
  });
  s.on(mat).face(pts, [x, y, z - 1]);
}

/** one piece of a merged node: its boxes (any materials) and what the parts file says of it */
export interface Part {
  name: string;
  boxes: Box[];
  extras?: Record<string, unknown>;
}
/** a merged node of pieces (model.ts's merged(), with the boxes above and pieces of several materials): a parts
 * entry per piece, its box round all of its boxes and the materials it uses */
export function mergedParts(
  m: Model,
  name: string,
  key: string,
  parts: Part[],
  extras: Record<string, unknown> = {},
): Node {
  const shape = new Shape();
  m.parts[key] = parts.map((p) => {
    boxes(p.boxes, shape);
    const lo = [0, 1, 2].map((k) => Math.min(...p.boxes.map(([, b]) => b[k])));
    const hi = [3, 4, 5].map((k) => Math.max(...p.boxes.map(([, b]) => b[k])));
    const mats = [...new Set(p.boxes.map(([mat]) => mat))];
    return [p.name, Geo.gltfBox(lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]), mats, p.extras ?? {}];
  });
  return m.node(name, shape, { merged: key, ...extras });
}

/** a node of boxes placed by their plan coordinates (like model.ts's item()) */
export function furn(m: Model, name: string, room: string, product: string, parts: Box[]): Node {
  return m.node(name, boxes(parts), { room, product });
}

const meshes = new WeakMap<Model, Map<string, Mesh>>();
/** a mesh made once per model, by key */
export function sharedMesh(m: Model, key: string, make: () => Shape): Mesh {
  let byKey = meshes.get(m);
  if (!byKey) meshes.set(m, (byKey = new Map()));
  let mesh = byKey.get(key);
  if (!mesh) byKey.set(key, (mesh = m.mesh(key, make())));
  return mesh;
}

/** a node of a piece at a plan point, turned by yawDeg (anticlockwise; 0: its front faces south) */
export function put(
  m: Model,
  name: string,
  what: Shape | Mesh,
  extras: Record<string, unknown>,
  at: V3,
  yawDeg = 0,
): void {
  m.node(name, what, extras, { at, yaw: (yawDeg * Math.PI) / 180 });
}

/** the materials of the pieces below (registered by the living area, the first of the ground floor's) */
export const KIT_MATERIALS: Record<string, MaterialDef> = {
  fabric_sofa: { c: hex('#9a9da3'), rough: 1 },
  fabric_mustard: { c: hex('#c99a3a'), rough: 1 },
  fabric_teal: { c: hex('#3f7a78'), rough: 1 },
  led_red: { c: hex('#d23b2f'), rough: 0.4 },
  art_mat: { c: hex('#f7f4ec'), rough: 0.9 },
  art_sky: { c: hex('#9cc3dc'), rough: 0.7 },
  art_hill: { c: hex('#5e8f4a'), rough: 0.7 },
  art_field: { c: hex('#d9b25a'), rough: 0.7 },
};

// ------------------------------------------------------------------ pieces (front -Y, footprint centred)

/** four legs inset from a w × d footprint's corners */
export function legs(mat: string, w: number, d: number, h: number, t = 0.04, inset = 0.03): Box[] {
  const out: Box[] = [];
  for (const x of [-w / 2 + inset, w / 2 - inset - t])
    for (const y of [-d / 2 + inset, d / 2 - inset - t]) out.push([mat, [x, y, 0, x + t, y + t, h]]);
  return out;
}

/** a three-seat sofa, 2.1 × 0.95 m */
export function sofa(): Box[] {
  const w = 1.05,
    d = 0.475;
  const out: Box[] = [
    ['fabric_grey', [-w, -d + 0.03, 0.1, w, d, 0.42]],
    ['fabric_grey', [-w, -d + 0.03, 0.42, -w + 0.18, d, 0.64]],
    ['fabric_grey', [w - 0.18, -d + 0.03, 0.42, w, d, 0.64]],
    ['fabric_grey', [-w + 0.18, d - 0.2, 0.42, w - 0.18, d, 0.86]],
    ...legs('wood_walnut', 2 * w - 0.1, 2 * d - 0.1, 0.1, 0.05),
  ];
  // three seat cushions and three back cushions
  const cw = (2 * (w - 0.18)) / 3;
  for (let i = 0; i < 3; i++) {
    const x0 = -w + 0.18 + i * cw + 0.006,
      x1 = x0 + cw - 0.012;
    out.push(['fabric_sofa', [x0, -d + 0.01, 0.42, x1, d - 0.2, 0.53]]);
    out.push(['fabric_sofa', [x0, d - 0.36, 0.53, x1, d - 0.2, 0.82]]);
  }
  // throw pillows in the corners
  out.push(['fabric_mustard', [-w + 0.2, d - 0.48, 0.53, -w + 0.6, d - 0.36, 0.86]]);
  out.push(['fabric_mustard', [w - 0.6, d - 0.48, 0.53, w - 0.2, d - 0.36, 0.86]]);
  return out;
}

/** an upholstered armchair, 0.85 × 0.85 m */
export function armchair(): Shape {
  const w = 0.425,
    d = 0.425;
  return boxes([
    ['fabric_teal', [-w, -d + 0.03, 0.12, w, d, 0.42]],
    ['fabric_teal', [-w, -d + 0.03, 0.42, -w + 0.14, d, 0.65]],
    ['fabric_teal', [w - 0.14, -d + 0.03, 0.42, w, d, 0.65]],
    ['fabric_teal', [-w + 0.14, d - 0.18, 0.42, w - 0.14, d, 0.92]],
    ['fabric_sofa', [-w + 0.15, -d + 0.01, 0.42, w - 0.15, d - 0.18, 0.52]],
    ...legs('wood_walnut', 2 * w - 0.06, 2 * d - 0.06, 0.12),
  ]);
}

/** a bookcase, 1.6 m wide, 0.36 deep, 2 m tall, full of books: its back on the wall (y +0.18) */
export function bookcase(): Box[] {
  const w = 0.8,
    d = 0.18;
  const out: Box[] = [
    ['wood_walnut', [-w, -d, 0, w, d, 0.06]],
    ['wood_walnut', [-w, -d, 0, -w + 0.03, d, 2.0]],
    ['wood_walnut', [w - 0.03, -d, 0, w, d, 2.0]],
    ['wood_walnut', [-w, d - 0.02, 0, w, d, 2.0]],
    ['wood_walnut', [-w, -d, 1.97, w, d, 2.0]],
  ];
  for (const z of [0.42, 0.82, 1.22, 1.6]) out.push(['wood_walnut', [-w + 0.03, -d, z, w - 0.03, d - 0.02, z + 0.025]]);
  // books: two runs of spines on each shelf
  const shelves = [0.06, 0.445, 0.845, 1.245, 1.625];
  const runs: [number, number, number, string][] = [
    [-0.74, -0.2, 0.3, 'books_red'],
    [0.05, 0.6, 0.26, 'books_blue'],
    [-0.7, -0.05, 0.27, 'books_blue'],
    [0.25, 0.72, 0.3, 'books_red'],
    [-0.74, -0.35, 0.25, 'books_red'],
    [-0.3, 0.3, 0.29, 'books_blue'],
    [0.1, 0.74, 0.27, 'books_blue'],
    [-0.72, 0.0, 0.22, 'books_red'],
    [-0.6, -0.1, 0.24, 'books_blue'],
    [0.3, 0.62, 0.2, 'books_red'],
  ];
  // each run a few books of a few heights, the odd one pulled forward
  runs.forEach(([x0, x1, h, mat], i) => {
    const z = shelves[Math.floor(i / 2)];
    const n = Math.max(2, Math.round((x1 - x0) / 0.2));
    const w = (x1 - x0) / n;
    for (let k = 0; k < n; k++) {
      const hk = h - [0, 0.035, 0.015, 0.05][(k + i) % 4];
      const y0 = -d + ((k + i) % 3 === 0 ? 0.04 : 0.06);
      out.push([mat, [x0 + k * w + 0.004, y0, z, x0 + (k + 1) * w - 0.004, d - 0.03, z + hk]]);
    }
  });
  return out;
}

/** a dining chair, its back at +Y (so it faces -Y) */
export function sideChair(): Box[] {
  return [
    ['wood_walnut', [-0.22, -0.22, 0.41, 0.22, 0.22, 0.45]],
    ['wood_walnut', [-0.22, 0.18, 0.45, 0.22, 0.22, 0.9]],
    ...legs('wood_walnut', 0.44, 0.44, 0.41, 0.03, 0.02),
  ];
}

/** a counter stool (seat at 0.66 m), its low back at +Y */
export function stool(): Box[] {
  return [
    ['wood_walnut', [-0.19, -0.19, 0.62, 0.19, 0.19, 0.66]],
    ['wood_walnut', [-0.17, 0.14, 0.66, 0.17, 0.18, 0.88]],
    ...legs('black_steel', 0.34, 0.34, 0.62, 0.025, 0.02),
    ['black_steel', [-0.15, -0.15, 0.25, 0.15, -0.13, 0.27]],
    ['black_steel', [-0.15, 0.13, 0.25, 0.15, 0.15, 0.27]],
  ];
}

/** a ceiling smoke (round) or CO (square) alarm, hanging below z = 0 */
export function alarm(kind: 'smoke' | 'co'): Shape {
  const s = new Shape();
  if (kind === 'smoke')
    s.on('plate_white').lathe(0, 0, [
      [-0.04, 0.07],
      [0, 0.07],
    ]);
  else boxes([['plate_white', [-0.06, -0.06, -0.035, 0.06, 0.06, 0]]], s);
  boxes([['led_red', [0.02, -0.005, kind === 'smoke' ? -0.042 : -0.037, 0.03, 0.005, -0.03], 'z-']], s);
  return s;
}

/** a framed picture on a wall, w × h, its back at y = 0 (on the wall), its bottom at z = 0: a light frame, a white
 * mat and a landscape (sky, a hill, a field) */
export function framedArt(w: number, h: number): Box[] {
  const fw = 0.045,
    mat = 0.09,
    y0 = -0.035;
  const x = w / 2;
  const px0 = -x + fw + mat,
    px1 = x - fw - mat,
    pz0 = fw + mat,
    pz1 = h - fw - mat;
  const ph = pz1 - pz0,
    pw = px1 - px0;
  return [
    ['wood_ash', [-x, y0, 0, x, 0, fw]],
    ['wood_ash', [-x, y0, h - fw, x, 0, h]],
    ['wood_ash', [-x, y0, fw, -x + fw, 0, h - fw]],
    ['wood_ash', [x - fw, y0, fw, x, 0, h - fw]],
    // the mat a little behind the frame's face, the picture's bands a little in front of the mat
    ['art_mat', [-x + fw, y0 + 0.01, fw, x - fw, 0, h - fw], 'y-'],
    ['art_sky', [px0, y0 + 0.007, pz0 + ph * 0.45, px1, 0, pz1], 'y-'],
    ['art_hill', [px0, y0 + 0.006, pz0 + ph * 0.25, px0 + pw * 0.65, 0, pz0 + ph * 0.6], 'y-'],
    ['art_hill', [px0 + pw * 0.65, y0 + 0.006, pz0 + ph * 0.25, px1, 0, pz0 + ph * 0.45], 'y-'],
    ['art_field', [px0, y0 + 0.007, pz0, px1, 0, pz0 + ph * 0.25], 'y-'],
    ['art_field', [px0 + pw * 0.72, y0 + 0.006, pz0 + ph * 0.7, px0 + pw * 0.82, 0, pz0 + ph * 0.84], 'y-'],
  ];
}
