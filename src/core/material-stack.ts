// Material overrides: the one way to change what a model mesh is drawn with for a while (energy mode's ghost, the
// blueprint fade, a light fixture's glowing copy). Each mesh keeps its own material (its base) and a stack of layers,
// lowest priority first (ties: the earlier push lower); what it shows is the top of the stack, where a layer given as
// a function makes its material from the one beneath it. Pushes and disposals in any order put back exactly what the
// remaining layers say, and the base when none is left. While a mesh has layers its base is also in
// userData.baseMaterial (for readers that only have the mesh). Pure three.js objects, no renderer: unit-tested.
import type * as THREE from 'three';
import type { MaterialLayer, MaterialOverride, MaterialsApi } from './plugin/types';

interface Layer {
  m: MaterialLayer;
  priority: number;
  seq: number;
}
interface Stack {
  base: THREE.Material;
  layers: Layer[];
}

export interface MaterialStack extends MaterialsApi {
  /** the same, with every override still alive disposed by `own`'s disposer (a plugin's stop) */
  scoped(own: (d: { dispose(): void }) => void): MaterialsApi;
  /** how many meshes have layers (tests) */
  size(): number;
}

const isMeshLike = (x: unknown): x is THREE.Mesh => (x as THREE.Mesh)?.isMesh === true;

export function createMaterialStack(): MaterialStack {
  const stacks = new Map<THREE.Mesh, Stack>();
  let seq = 0;

  function resolve(mesh: THREE.Mesh): void {
    const s = stacks.get(mesh);
    if (!s) return;
    if (!s.layers.length) {
      stacks.delete(mesh);
      mesh.material = s.base;
      delete mesh.userData.baseMaterial;
      return;
    }
    let m = s.base;
    for (const l of s.layers) m = typeof l.m === 'function' ? l.m(m, mesh) : l.m;
    if (mesh.material !== m) mesh.material = m;
  }

  function push(
    meshes: THREE.Mesh | Iterable<THREE.Mesh>,
    m: MaterialLayer,
    opts: { priority?: number } = {},
  ): MaterialOverride {
    const layer: Layer = { m, priority: opts.priority ?? 0, seq: seq++ };
    const list = [...new Set(isMeshLike(meshes) ? [meshes] : meshes)];
    for (const mesh of list) {
      let s = stacks.get(mesh);
      if (!s) {
        s = { base: mesh.material as THREE.Material, layers: [] };
        stacks.set(mesh, s);
        mesh.userData.baseMaterial = s.base;
      }
      s.layers.push(layer);
      s.layers.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      resolve(mesh);
    }
    let live = true;
    return {
      set(next) {
        if (!live) return;
        layer.m = next;
        list.forEach(resolve);
      },
      refresh() {
        if (live) list.forEach(resolve);
      },
      dispose() {
        if (!live) return;
        live = false;
        for (const mesh of list) {
          const s = stacks.get(mesh);
          if (!s) continue;
          s.layers = s.layers.filter((l) => l !== layer);
          resolve(mesh);
        }
      },
    };
  }

  const base = (mesh: THREE.Mesh): THREE.Material => (stacks.get(mesh)?.base ?? mesh.material) as THREE.Material;

  return {
    push,
    base,
    size: () => stacks.size,
    scoped(own) {
      const alive = new Set<MaterialOverride>();
      own({ dispose: () => [...alive].forEach((o) => o.dispose()) });
      return {
        base,
        push(meshes, m, opts) {
          const o = push(meshes, m, opts);
          alive.add(o);
          return {
            set: o.set,
            refresh: o.refresh,
            dispose: () => (alive.delete(o), o.dispose()),
          };
        },
      };
    },
  };
}
