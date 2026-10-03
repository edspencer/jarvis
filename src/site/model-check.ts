// Checks a model file against docs/model-format.md (jarvis-model/1) and the site's naming rules, from the glTF JSON
// alone (nothing is decoded: positions come from the accessors' min / max, so a compressed model checks as fast as a
// plain one). Pure: the caller reads the bytes. Used by `npm run validate-site`.
import { matches, type NodeFacts, type Site } from './resolve.ts';

export const MODEL_FORMAT = 'jarvis-model/1';

/** glTF extensions the viewer can load when a model requires them */
export const SUPPORTED_REQUIRED = new Set([
  'KHR_mesh_quantization',
  'EXT_meshopt_compression',
  'KHR_texture_basisu',
  'KHR_texture_transform',
  'EXT_texture_webp',
  'KHR_materials_emissive_strength',
  'KHR_materials_ior',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_unlit',
  'KHR_lights_punctual',
  'EXT_mesh_gpu_instancing',
]);

interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extras?: Record<string, unknown>;
}
interface Gltf {
  asset?: { version?: string; generator?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives: { attributes: Record<string, number>; material?: number }[] }[];
  materials?: { name?: string; extras?: Record<string, unknown> }[];
  accessors?: { min?: number[]; max?: number[]; normalized?: boolean; componentType?: number }[];
  extensionsUsed?: string[];
  extensionsRequired?: string[];
}

export interface ModelReport {
  errors: string[];
  warnings: string[];
  /** what was found, for the summary line */
  stats: {
    nodes: number;
    topLevel: number;
    fixtures: number;
    rooms: number;
    merged: number;
    /** layer id -> top-level nodes it takes */
    layers: Record<string, number>;
    /** world box, metres (three.js frame: Y up), or null if it couldn't be worked out */
    box: { min: [number, number, number]; max: [number, number, number] } | null;
  };
  /** the `merged` keys the model uses (to check against the parts file) */
  mergedKeys: string[];
}

/** the JSON of a .glb (or a .gltf's text) */
export function readGltfJson(bytes: Uint8Array): Gltf {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 20 && dv.getUint32(0, true) === 0x46546c67) {
    // 'glTF' header, then the first chunk, which must be JSON
    const version = dv.getUint32(4, true);
    if (version !== 2) throw new Error(`glb version ${version}; glTF 2 is needed`);
    const len = dv.getUint32(12, true),
      type = dv.getUint32(16, true);
    if (type !== 0x4e4f534a) throw new Error("the glb's first chunk isn't JSON");
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len))) as Gltf;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as Gltf;
}

// ------------------------------------------------------------------ transforms (column-major 4x4, as glTF)
type M4 = number[];
const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: M4, b: M4): M4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function local(n: GltfNode): M4 {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ]; // prettier-ignore
}
/** the largest value of a normalised integer component type */
const NORM: Record<number, number> = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/** Check a model's JSON. `site` gives the layer, room and collider rules; `isMain` the main model (fixtures, rooms
 * expected there). */
export function checkModel(gltf: Gltf, site: Site, isMain: boolean): ModelReport {
  const errors: string[] = [],
    warnings: string[] = [];
  if (gltf.asset?.version !== '2.0')
    errors.push(`asset.version is ${JSON.stringify(gltf.asset?.version)}; glTF 2.0 is needed`);
  for (const ext of gltf.extensionsRequired || [])
    if (!SUPPORTED_REQUIRED.has(ext))
      errors.push(
        `requires ${ext}, which the viewer doesn't load${ext === 'KHR_draco_mesh_compression' ? ' (use meshopt: gltfpack -cc)' : ''}`,
      );
  const nodes = gltf.nodes || [];
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  const top = scene?.nodes || [];
  if (!scene) errors.push('no scene');
  const matName = (i: number | undefined) => (i === undefined ? '' : gltf.materials?.[i]?.name || '');

  // world box from the accessors' bounds, through the node transforms (a quantised mesh's dequantisation is a node
  // transform, so this comes out in metres)
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  let boxed = true;
  const facts = new Map<number, NodeFacts>();
  const mergedKeys = new Set<string>();
  const fixtureIds = new Map<string, string>();
  let fixtures = 0,
    rooms = 0;
  function walk(i: number, parent: M4, top: number): void {
    const n = nodes[i];
    if (!n) return;
    const m = mul(parent, local(n));
    if (typeof n.extras?.merged === 'string') mergedKeys.add(n.extras.merged);
    if (n.mesh !== undefined) {
      for (const p of gltf.meshes?.[n.mesh]?.primitives || []) {
        (facts.get(top)!.materials as Set<string>).add(matName(p.material));
        const a = gltf.accessors?.[p.attributes.POSITION];
        if (!a?.min || !a.max) {
          boxed = false;
          continue;
        }
        const k = a.normalized ? NORM[a.componentType || 0] || 1 : 1;
        for (let c = 0; c < 8; c++) {
          const v = [0, 1, 2].map((d) => ((c >> d) & 1 ? a.max![d] : a.min![d]) / k);
          for (let r = 0; r < 3; r++) {
            const w = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r];
            lo[r] = Math.min(lo[r], w);
            hi[r] = Math.max(hi[r], w);
          }
        }
      }
    }
    for (const c of n.children || []) walk(c, m, top);
  }
  for (const i of top) {
    const n = nodes[i] || {};
    facts.set(i, { name: n.name || '', extras: n.extras || {}, materials: new Set<string>() });
    walk(i, IDENTITY, i);
  }

  const layerCounts: Record<string, number> = Object.fromEntries(site.layers.map((l) => [l.id, 0]));
  let unnamed = 0;
  for (const i of top) {
    const f = facts.get(i)!;
    if (!f.name) unnamed++;
    const fid = f.extras.fixture_id;
    if (fid !== undefined) {
      if (typeof fid !== 'string' || !fid) errors.push(`node ${f.name || i}: fixture_id must be a non-empty string`);
      else if (fixtureIds.has(fid)) errors.push(`fixture_id ${fid} is on both ${fixtureIds.get(fid)} and ${f.name}`);
      else fixtureIds.set(fid, f.name);
      fixtures++;
    }
    if (f.name.startsWith(site.floorPrefix) && f.extras.room) rooms++;
    if (f.extras.room !== undefined && typeof f.extras.room !== 'string')
      warnings.push(`node ${f.name}: room should be a string`);
    for (const l of site.layers) if (matches(l.match, f)) layerCounts[l.id]++;
  }
  if (unnamed)
    warnings.push(
      `${unnamed} top-level node${unnamed > 1 ? 's have' : ' has'} no name (the inspect panel shows names)`,
    );

  if (isMain) {
    if (!rooms)
      warnings.push(
        `no room floors (top-level nodes named ${site.floorPrefix}* with a \`room\` extra): the room list and "where am I" stay empty`,
      );
    if (!fixtures && site.plugins['home-assistant'])
      warnings.push('no light fixtures (nodes with a `fixture_id` extra): Home Assistant has nothing to light');
    for (const l of site.layers)
      if (!layerCounts[l.id] && !l.model && l.code)
        warnings.push(`layer "${l.id}" takes no node: its key (${l.key}) will do nothing`);
    if (site.plugins.switches && !top.some((i) => facts.get(i)!.extras.layer === 'switches'))
      warnings.push('the switches plugin is configured but there is no top-level group with extras layer: switches');
  }

  let box: ModelReport['stats']['box'] = null;
  if (boxed && Number.isFinite(lo[0])) {
    box = { min: lo as [number, number, number], max: hi as [number, number, number] };
    const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    if (isMain && size > 5000)
      warnings.push(
        `the model is ${Math.round(size)} m across: glTF is in metres (was it exported in millimetres or feet?)`,
      );
    if (isMain && size < 2)
      warnings.push(`the model is ${size.toFixed(2)} m across: glTF is in metres (was it scaled down?)`);
  } else if (isMain)
    warnings.push("some positions have no min / max in their accessor: the model's size wasn't checked");

  return {
    errors,
    warnings,
    stats: {
      nodes: nodes.length,
      topLevel: top.length,
      fixtures,
      rooms,
      merged: mergedKeys.size,
      layers: layerCounts,
      box,
    },
    mergedKeys: [...mergedKeys],
  };
}

/** Check a parts file's shape: { parts: { key: [[name, [6 numbers], [materials], {extras}]] } }; returns its keys. */
export function checkParts(json: unknown): { errors: string[]; keys: Set<string> } {
  const errors: string[] = [];
  const parts = (json as { parts?: unknown })?.parts;
  if (!parts || typeof parts !== 'object' || Array.isArray(parts))
    return { errors: ['expected { "parts": { <merged key>: [ … ] } }'], keys: new Set() };
  for (const [k, list] of Object.entries(parts)) {
    if (!Array.isArray(list)) {
      errors.push(`parts.${k}: expected a list`);
      continue;
    }
    list.forEach((e, i) => {
      const ok =
        Array.isArray(e) &&
        typeof e[0] === 'string' &&
        Array.isArray(e[1]) &&
        e[1].length === 6 &&
        e[1].every((x: unknown) => typeof x === 'number') &&
        Array.isArray(e[2]) &&
        e[3] &&
        typeof e[3] === 'object';
      if (!ok && errors.length < 20)
        errors.push(`parts.${k}[${i}]: expected [name, [min x, y, z, max x, y, z], [materials], {extras}]`);
    });
  }
  return { errors, keys: new Set(Object.keys(parts)) };
}
