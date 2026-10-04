// Picking: what is under the crosshair (walking) or the mouse (overview). Screen-space markers (pins, fault markers)
// win, then the model: the object hit, and for a merged node the original object from the parts file. Plugins turn a
// model hit into their own subject (a wall plate's instance) through resolvers.
import * as THREE from 'three';
import { isShown, matOf } from './three-utils';
import type { PartsIndex, PickResult } from './types';
import type { Disposable, PickApi, Subject } from './plugin/types';

/** Which source object of a merged node was hit: the smallest of its parts whose box holds the point, preferring parts
 * that carry the hit material. null if the node isn't merged or parts.json isn't loaded yet. */
export function partAt(
  parts: PartsIndex,
  point: { x: number; y: number; z: number },
  mergedKey: string | null | undefined,
  materialName: string | undefined,
): { name: string; props: Record<string, unknown> } | null {
  const list = mergedKey && parts[mergedKey];
  if (!list) return null;
  const p = point,
    e = 0.02,
    mn = materialName;
  let best: (typeof list)[number] | null = null,
    bestV = Infinity,
    bestMat = false;
  for (const it of list) {
    const b = it[1];
    if (p.x < b[0] - e || p.y < b[1] - e || p.z < b[2] - e || p.x > b[3] + e || p.y > b[4] + e || p.z > b[5] + e)
      continue;
    const hasMat = it[2].includes(mn as string);
    const vol = (b[3] - b[0] + e) * (b[4] - b[1] + e) * (b[5] - b[2] + e);
    if ((hasMat && !bestMat) || (hasMat === bestMat && vol < bestV)) {
      best = it;
      bestV = vol;
      bestMat = hasMat;
    }
  }
  return best && { name: best[0], props: best[3] };
}

export type Picker = PickApi & {
  /** the same API, with registrations collected for one plugin's disposal */
  scoped(collect: (d: Disposable) => void): PickApi;
};

export function createPicker({
  camera,
  root,
  parts,
  ownerOf,
  isGlass,
}: {
  camera: THREE.Camera;
  root: THREE.Object3D;
  parts: PartsIndex;
  ownerOf: (o: THREE.Object3D) => THREE.Object3D;
  isGlass: (m: THREE.Material) => boolean;
}): Picker {
  const picker = new THREE.Raycaster();
  picker.firstHitOnly = false;
  const screen: { id: string; order: number; at(ndc: THREE.Vector2): Subject | null }[] = [];
  const resolvers: ((p: PickResult) => Subject | null)[] = [];

  function model(ndc: THREE.Vector2): PickResult | null {
    // the camera may have moved since the last frame (a mode switch handled in the same task as the click)
    camera.updateMatrixWorld();
    picker.setFromCamera(ndc, camera);
    picker.far = 80;
    const hits = picker.intersectObjects(root.children, true);
    for (const h of hits) {
      if (!isShown(h.object)) continue;
      const mat = (h.object as THREE.Mesh).material ? matOf(h.object as THREE.Mesh) : undefined;
      const mn = mat?.name;
      if (mat && isGlass(mat) && hits.length > 1 && h !== hits[hits.length - 1]) continue; // look through glass
      const po = h.object.userData.plantOwners as THREE.Object3D[] | undefined; // a plant: one instance
      if (po && h.instanceId != null) return { node: po[h.instanceId], hit: h, part: null };
      // gltfpack hangs a node's mesh under it, so the extras can be a level up
      let o: THREE.Object3D | null = h.object;
      while (o && o !== root && !o.userData.merged) o = o.parent;
      const key = o && (o.userData.merged as string | undefined);
      return { node: ownerOf(h.object), hit: h, part: partAt(parts, h.point, key, mn) };
    }
    return null;
  }

  function at(ndc: THREE.Vector2): Subject | null {
    for (const p of screen) {
      try {
        const s = p.at(ndc);
        if (s) return s;
      } catch (err) {
        console.error(`picker ${p.id} failed`, err);
      }
    }
    const p = model(ndc);
    if (!p) return null;
    for (const r of resolvers) {
      try {
        const s = r(p);
        if (s) return s;
      } catch (err) {
        console.error('a pick resolver failed', err);
      }
    }
    return { kind: 'object', node: p.node, part: p.part, hit: p.hit };
  }

  const remove = <T>(list: T[], x: T) => {
    const i = list.indexOf(x);
    if (i >= 0) list.splice(i, 1);
  };
  const api: PickApi = {
    at,
    model,
    addScreenPicker(p) {
      const rec = { id: p.id, order: p.order ?? 50, at: p.at };
      screen.push(rec);
      screen.sort((a, b) => a.order - b.order);
      return { dispose: () => remove(screen, rec) };
    },
    addResolver(fn) {
      resolvers.push(fn);
      return { dispose: () => remove(resolvers, fn) };
    },
  };
  return {
    ...api,
    scoped: (collect) => ({
      ...api,
      addScreenPicker: (p) => {
        const d = api.addScreenPicker(p);
        collect(d);
        return d;
      },
      addResolver: (fn) => {
        const d = api.addResolver(fn);
        collect(d);
        return d;
      },
    }),
  };
}
