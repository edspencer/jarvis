// Material overrides: the one way to change what a model mesh is drawn with for a while (energy mode's ghost, the
// blueprint fade, a light fixture's glowing copy). Each mesh keeps its own material (its base) and a stack of layers,
// lowest priority first (ties: the earlier push lower); what it shows is the top of the stack, where a layer given as
// a function makes its material from the one beneath it. Pushes and disposals in any order put back exactly what the
// remaining layers say, and the base when none is left. base(mesh) is how anything (core or plugin) reads a mesh's own
// material. While a mesh has layers its base is also left in userData.baseMaterial: internal (a devtools aid), not a
// contract; nothing reads it, don't start. Pure three.js objects, no renderer: unit-tested.
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
  /** the same, with every override still alive disposed by `own`'s disposer (a plugin's stop), and its warning
   * (something pushed that isn't a mesh with one material) through `warn` */
  scoped(own: (d: { dispose(): void }) => void, warn?: (msg: string) => void): MaterialsApi;
  /** how many meshes have layers (tests) */
  size(): number;
}

const isObject3D = (x: unknown): x is THREE.Object3D => (x as THREE.Object3D)?.isObject3D === true;
const SKIPPED = 'materials.push: skipped what is not a mesh with one material (this warning shows once)';

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
    objects: THREE.Object3D | Iterable<THREE.Object3D>,
    m: MaterialLayer,
    opts: { priority?: number } = {},
    warn: () => void = () => {},
  ): MaterialOverride {
    const layer: Layer = { m, priority: opts.priority ?? 0, seq: seq++ };
    const list: THREE.Mesh[] = [];
    for (const o of new Set(isObject3D(objects) ? [objects] : objects)) {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.material && !Array.isArray(mesh.material)) list.push(mesh);
      else warn();
    }
    for (const mesh of list) {
      let s = stacks.get(mesh);
      if (!s) {
        s = { base: mesh.material as THREE.Material, layers: [] };
        stacks.set(mesh, s);
        mesh.userData.baseMaterial = s.base; // internal: read base() instead
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

  // a covered mesh's base was its one material (push skips arrays), so it is the mesh's material type
  const base: MaterialsApi['base'] = (mesh) => (stacks.get(mesh)?.base ?? mesh.material) as typeof mesh.material;

  /** a warning that shows once */
  const once = (say: (msg: string) => void) => {
    let said = false;
    return () => {
      if (!said) say(SKIPPED);
      said = true;
    };
  };
  const warnCore = once((msg) => console.warn(msg));

  return {
    push: (objects, m, opts) => push(objects, m, opts, warnCore),
    base,
    size: () => stacks.size,
    scoped(own, say = (msg) => console.warn(msg)) {
      const alive = new Set<MaterialOverride>();
      const warn = once(say);
      own({
        dispose: () => {
          const all = [...alive];
          alive.clear();
          all.forEach((o) => o.dispose());
        },
      });
      return {
        base,
        push(objects, m, opts) {
          const o = push(objects, m, opts, warn);
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
