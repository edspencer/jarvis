// Builds small glTF binaries for the tests: boxes as top-level nodes, with names, extras and material names.

export interface TestNode {
  name?: string;
  extras?: Record<string, unknown>;
  material?: string;
  /** min and max corner, metres (three.js frame) */
  box?: [[number, number, number], [number, number, number]];
  children?: TestNode[];
}

export function buildGlb(
  top: TestNode[],
  opts: { required?: string[]; materialExtras?: Record<string, Record<string, unknown>> } = {},
): Uint8Array {
  const nodes: Record<string, unknown>[] = [],
    meshes: unknown[] = [],
    accessors: unknown[] = [],
    materials: { name: string; extras?: Record<string, unknown> }[] = [];
  const bin: number[] = [];
  const matIndex = (name: string) => {
    let i = materials.findIndex((m) => m.name === name);
    if (i < 0) {
      i = materials.length;
      materials.push({ name, ...(opts.materialExtras?.[name] ? { extras: opts.materialExtras[name] } : {}) });
    }
    return i;
  };
  function add(n: TestNode): number {
    const node: Record<string, unknown> = {};
    if (n.name) node.name = n.name;
    if (n.extras) node.extras = n.extras;
    const i = nodes.length;
    nodes.push(node);
    if (n.box) {
      const [lo, hi] = n.box;
      const offset = bin.length * 4;
      for (const c of [lo, hi]) bin.push(...c);
      accessors.push({
        bufferView: 0,
        byteOffset: offset,
        componentType: 5126,
        count: 2,
        type: 'VEC3',
        min: lo,
        max: hi,
      });
      meshes.push({
        primitives: [{ attributes: { POSITION: accessors.length - 1 }, material: matIndex(n.material || 'plain') }],
      });
      node.mesh = meshes.length - 1;
    }
    if (n.children) node.children = n.children.map(add);
    return i;
  }
  const roots = top.map(add);
  const binBytes = new Uint8Array(new Float32Array(bin).buffer);
  const json = {
    asset: { version: '2.0', generator: 'jarvis tests' },
    scene: 0,
    scenes: [{ nodes: roots }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: [{ buffer: 0, byteLength: binBytes.length }],
    buffers: [{ byteLength: binBytes.length }],
    ...(opts.required ? { extensionsUsed: opts.required, extensionsRequired: opts.required } : {}),
  };
  let js = new TextEncoder().encode(JSON.stringify(json));
  const pad = (b: Uint8Array, fill: number) => {
    const n = Math.ceil(b.length / 4) * 4;
    const o = new Uint8Array(n).fill(fill);
    o.set(b);
    return o;
  };
  js = pad(js, 0x20);
  const bb = pad(binBytes, 0);
  const total = 12 + 8 + js.length + 8 + bb.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, js.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(js, 20);
  dv.setUint32(20 + js.length, bb.length, true);
  dv.setUint32(24 + js.length, 0x004e4942, true);
  out.set(bb, 28 + js.length);
  return out;
}

/** the cottage of tests/fixtures/site: a floor, walls, a roof, a ceiling, a door leaf, a light, a shed */
export const cottage = (): TestNode[] => [
  {
    name: 'Floor_main',
    extras: { room: 'main_room' },
    box: [
      [0, 0, -6],
      [8, 0.1, 0],
    ],
  },
  {
    name: 'Wall_south',
    material: 'plaster',
    extras: { merged: 'walls' },
    box: [
      [0, 0, -0.2],
      [8, 2.6, 0],
    ],
  },
  {
    name: 'Roof_main',
    material: 'slate',
    box: [
      [-0.5, 2.6, -6.5],
      [8.5, 4.5, 0.5],
    ],
  },
  {
    name: 'Ceil_main',
    box: [
      [0, 2.5, -6],
      [8, 2.6, 0],
    ],
  },
  {
    name: 'Door_front',
    extras: { door_leaf: true },
    box: [
      [3.5, 0, -0.1],
      [4.4, 2, 0],
    ],
  },
  {
    name: 'Win_south',
    material: 'glass',
    box: [
      [1, 1, -0.1],
      [2, 2, 0],
    ],
  },
  {
    name: 'Fixture_main.pendant',
    extras: { fixture_id: 'main.pendant', room: 'main_room' },
    box: [
      [3.9, 2, -3.1],
      [4.1, 2.5, -2.9],
    ],
  },
  {
    name: 'Shed',
    extras: { layer: 'shed' },
    box: [
      [10, 0, -2],
      [12, 2, 0],
    ],
  },
];
