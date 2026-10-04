import { writeFile } from 'node:fs/promises';
import { Document, Logger, NodeIO, type Material, type Mesh, type Node, type Scene } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { Geo, Shape, toGltf, type V3 } from './geometry.ts';
import { UP } from './dims.ts';

// ------------------------------------------------------------------ materials
export type Rgba = [number, number, number, number];
export const hex = (h: string, a = 1): Rgba => {
  const n = parseInt(h.slice(1), 16);
  // glTF colours are linear
  const lin = (c: number) => {
    const s = c / 255;
    return Math.round((s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * 1e4) / 1e4;
  };
  return [lin(n >> 16), lin((n >> 8) & 255), lin(n & 255), a];
};
export interface MaterialDef {
  c: Rgba;
  rough?: number;
  metal?: number;
  blend?: boolean;
  double?: boolean;
}
/** the shared materials; areas add their own with addMaterials */
export const MATERIALS: Record<string, MaterialDef> = {
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
  door_paint: { c: hex('#f0eee8'), rough: 0.45 },
  entry_door: { c: hex('#2e4a6b'), rough: 0.4 },
  garage_door: { c: hex('#ecebe6'), rough: 0.5 },
  garage_door_groove: { c: hex('#c4c2bb'), rough: 0.6 },
  concrete: { c: hex('#b9b6ae'), rough: 0.95 },
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

/** add an area's materials to MATERIALS; a name that is already there is an error (areas must not redefine each
 * other's materials, nor the shared ones) */
export function addMaterials(defs: Record<string, MaterialDef>, owner: string): void {
  for (const [name, d] of Object.entries(defs)) {
    if (MATERIALS[name]) throw new Error(`area ${owner}: material ${name} is already defined`);
    MATERIALS[name] = d;
  }
}

/** a glTF document with the demo's materials, made on first use */
export class Model {
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
  /** a flat textured rectangle (plan corners, counter-clockwise seen from its front, from the bottom left), its
   * image KTX2: the demo's one texture, so the viewer's Basis transcoder (and the CSP it needs) is exercised */
  texturedQuad(name: string, corners: [V3, V3, V3, V3], normal: V3, ktx2: Uint8Array, extras = {}): Node {
    this.doc.createExtension(KHRTextureBasisu).setRequired(true);
    const tex = this.doc.createTexture(name).setImage(ktx2).setMimeType('image/ktx2');
    const mat = this.doc.createMaterial(name).setBaseColorTexture(tex).setRoughnessFactor(0.6).setMetallicFactor(0);
    const acc = (type: 'VEC2' | 'VEC3' | 'SCALAR', arr: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>) =>
      this.doc.createAccessor().setType(type).setArray(arr).setBuffer(this.buffer);
    const prim = this.doc
      .createPrimitive()
      .setAttribute('POSITION', acc('VEC3', new Float32Array(corners.flatMap(toGltf))))
      .setAttribute('NORMAL', acc('VEC3', new Float32Array([0, 1, 2, 3].flatMap(() => toGltf(normal)))))
      .setAttribute('TEXCOORD_0', acc('VEC2', new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])))
      .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 0, 2, 3])))
      .setMaterial(mat);
    return this.node(name, this.doc.createMesh(name).addPrimitive(prim), extras);
  }
  async write(file: string): Promise<number> {
    await MeshoptEncoder.ready;
    this.doc.createExtension(KHRMeshQuantization);
    this.doc.createExtension(EXTMeshoptCompression).setRequired(true);
    await this.doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
    const io = new NodeIO()
      .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization, KHRTextureBasisu])
      .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
    const bytes = await io.writeBinary(this.doc);
    await writeFile(file, bytes);
    return bytes.byteLength;
  }
}

/** a solid built of boxes, all one material, recorded as one part of a merged node */
export interface Piece {
  name: string;
  material: string;
  boxes: number[][];
  extras?: Record<string, unknown>;
}
export function merged(
  model: Model,
  name: string,
  key: string,
  pieces: Piece[],
  extras: Record<string, unknown> = {},
): Node {
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

/** a piece of furniture: one node of boxes ([material, [x0, y0, z0, x1, y1, z1]], z above the storey's floor) */
export function item(
  m: Model,
  name: string,
  room: string,
  product: string,
  parts: [string, number[]][],
  storey: 0 | 1 = 0,
): Node {
  const s = new Shape();
  const z = storey ? UP : 0;
  for (const [mat, b] of parts) s.on(mat).box(b[0], b[1], b[2] + z, b[3], b[4], b[5] + z);
  return m.node(name, s, { room, product });
}
