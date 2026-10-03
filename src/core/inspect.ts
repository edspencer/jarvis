// Picking and the inspect panel: what is under the crosshair (walking) or the mouse (overview), its glTF extras, and
// for a merged node the original object from the parts file. Plugins add rows and sections (a fixture's Home Assistant
// state, its registry item) and own their markers' panels.
import * as THREE from 'three';
import { isShown, matOf, nodeName } from './three-utils';
import type { DomLookup, Escape, PartsIndex, PickResult, PluginSlots } from './types';
import { toPlan } from './units';

export interface Inspect {
  pick(ndc: THREE.Vector2): PickResult | null;
  pickName(p: PickResult): string;
  showInfo(p: PickResult | null): void;
  hover(ndc: THREE.Vector2, px?: { x: number; y: number } | null): void;
  /** what the panel shows now, so a Home Assistant change can refresh it */
  info: { shown: PickResult | null };
}

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

export function createInspect({
  camera,
  root,
  parts,
  ownerOf,
  isGlass,
  plugins,
  $,
  esc,
}: {
  camera: THREE.Camera;
  root: THREE.Object3D;
  parts: PartsIndex;
  ownerOf: (o: THREE.Object3D) => THREE.Object3D;
  isGlass: (m: THREE.Material) => boolean;
  plugins: PluginSlots;
  $: DomLookup;
  esc: Escape;
}): Inspect {
  const picker = new THREE.Raycaster();
  picker.firstHitOnly = false;
  const info: Inspect['info'] = { shown: null };

  function pick(ndc: THREE.Vector2): PickResult | null {
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
      const plate = plugins.switches?.plateOf(h); // a wall plate: one instance of an instanced mesh
      if (plate) return { node: plate.node, hit: h, part: null, plate };
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

  const pickName = (p: PickResult): string =>
    p.plate
      ? `${p.plate.box || 'unknown plate'} (${String(p.plate.d.room).replace(/_/g, ' ')})`
      : p.part
        ? p.part.name
        : nodeName(p.node);

  const hitAt = (p: PickResult): string => {
    const at = toPlan(p.hit.point);
    return `<tr><td>hit at</td><td>plan X ${at.X.toFixed(2)}, Y ${at.Y.toFixed(2)}, Z ${at.Z.toFixed(2)} ft</td></tr>`;
  };

  function showInfo(p: PickResult | null): void {
    const el = $('info');
    const { ha, pins, switches } = plugins;
    if (!p) {
      el.style.display = 'none';
      info.shown = null;
      switches?.select(null);
      return;
    }
    switches?.select(null);
    if (p.plate) {
      // a wall plate: its own panel (switches plugin)
      pins?.select(null);
      info.shown = p;
      switches!.info(p.plate, [hitAt(p)]);
      return;
    }
    const u: Record<string, unknown> = p.part
      ? { ...p.part.props, 'merged into': nodeName(p.node) }
      : { ...p.node.userData };
    delete u.box;
    delete u.name;
    delete u.merged;
    const rows = Object.entries(u).map(
      ([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</td></tr>`,
    );
    // a light fixture: its Home Assistant entity, state and last change, at the top
    const fid = p.node.userData.fixture_id as string | undefined;
    if (fid && ha)
      rows.unshift(...ha.infoRows(fid).map(([k, v]) => `<tr class="ha"><td>${esc(k)}</td><td>${esc(v)}</td></tr>`));
    info.shown = p;
    // a fixture that is a registry item: link to it rather than pin it twice
    const reg = fid && pins?.byFixture(fid);
    if (reg) rows.unshift(`<tr class="conn"><td>registry</td><td>${pins!.link(reg.id)}</td></tr>`);
    pins?.select(null);
    const mat = (p.hit.object as THREE.Mesh).material as THREE.Material | undefined;
    rows.push(`<tr><td>material</td><td>${esc(mat?.name || '')}</td></tr>`);
    rows.push(hitAt(p));
    el.innerHTML = `<span class="close" id="infoclose">✕</span><h2>${esc(pickName(p))}</h2><table>${rows.join('')}</table>`;
    const sw = fid && ha?.panel(fid); // Home Assistant: switch this light
    if (sw) el.querySelector('h2')!.after(sw);
    el.style.display = 'block';
    $('infoclose').onclick = () => showInfo(null);
  }

  function placeLabel(el: HTMLElement, px?: { x: number; y: number } | null): void {
    el.style.display = 'block';
    if (px) {
      el.style.left = `${px.x}px`;
      el.style.top = `${px.y + 18}px`;
    } else {
      el.style.left = '';
      el.style.top = '';
    }
  }

  function hover(ndc: THREE.Vector2, px?: { x: number; y: number } | null): void {
    const el = $('hover');
    const { ha, faults, pins } = plugins;
    const dev = faults?.at(ndc); // a device fault marker (through walls) wins over everything
    if (dev) {
      el.textContent = `${dev.name}: ${dev.why[0]?.text || dev.off || 'ok'}${dev.place?.approx ? ' (room only)' : ''}`;
      placeLabel(el, px);
      return;
    }
    const pin = pins?.at(ndc);
    if (pin) {
      el.textContent = `${pin.name}${pin.approx ? ' (room only)' : ''}`;
      placeLabel(el, px);
      return;
    }
    const p = pick(ndc);
    if (!p) {
      el.style.display = 'none';
      return;
    }
    const fid = p.node.userData.fixture_id as string | undefined;
    el.textContent = pickName(p) + (ha && fid ? ha.hoverSuffix(fid) : '');
    placeLabel(el, px);
  }

  return { pick, pickName, showInfo, hover, info };
}
