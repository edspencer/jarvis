// Blueprint overlays: a scanned sheet as line art (dark ink, transparent paper) in the plan frame (the site's sheet index
// and one image per sheet; docs/model-format.md). Plans lie at their floor (a ceiling / roof plan at its ceiling, or
// on its floor with "on floor"); elevations stand where their corners put them (just outside their facade). While one
// is shown, the model fades (default 20 %, depthWrite off: a faded copy of each material, pushed as a material override
// under energy mode's) and the sheet is drawn last with no depth test, so it reads crisply through everything. Images
// load on demand and are cached.
import * as THREE from 'three';
import type { BlueprintsConfig } from '../../site';
import { isMesh } from '../../core/three-utils';
import type { Groups } from '../../core/types';
import { MATERIAL_PRIORITY, type MaterialOverride, type MaterialsApi } from '../../plugin-api';
import { P, planUnit } from '../../core/units';

type Corner = [number, number, number];

export interface BlueprintSheet {
  id: string;
  title: string;
  kind: 'plan' | 'elevation';
  file: string;
  /** an elevation's facade */
  face?: 'north' | 'south' | 'east' | 'west';
  /** the floor of the sheet's storey, plan units */
  z_floor?: number | null;
  /** the image's corners in the plan frame */
  corners: { tl: Corner; tr: Corner; bl: Corner; br: Corner };
  /** the fit's error, plan units (shown in the list) */
  rms?: number | null;
}

/** a sheet as the index writes it: `corners`, `z_floor`, `rms`, or the same with an `_ft` suffix */
type SheetEntry = Omit<BlueprintSheet, 'corners' | 'z_floor' | 'rms'> & {
  corners?: BlueprintSheet['corners'];
  corners_ft?: BlueprintSheet['corners'];
  z_floor?: number | null;
  z_floor_ft?: number | null;
  rms?: number | null;
  rms_ft?: number | null;
};

const normaliseSheet = (s: SheetEntry): BlueprintSheet => ({
  ...s,
  corners: (s.corners || s.corners_ft)!,
  z_floor: s.z_floor ?? s.z_floor_ft ?? null,
  rms: s.rms ?? s.rms_ft ?? null,
});

export interface BlueprintState {
  index: BlueprintSheet[] | null;
  active: BlueprintSheet | null;
  last: string | null;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;
  cache: Record<string, Promise<THREE.Texture>>;
  fade: number;
  hideAbove: boolean;
  onFloor: boolean;
  /** material -> its faded copy, while a sheet is shown */
  faded: Map<THREE.Material, THREE.Material>;
  /** what "hide above" hides for the active sheet */
  hidden: THREE.Object3D[];
}

export interface Blueprints {
  bp: BlueprintState;
  /** fetch the sheet index; resolves with it (empty: no sheets) */
  loadIndex(): Promise<BlueprintSheet[]>;
  showBlueprint(id: string | null): Promise<void>;
  setBlueprintFade(f: number): void;
  fadeModel(on: boolean): void;
  blueprintHidden(s: BlueprintSheet): THREE.Object3D[];
  /** B: the last sheet shown, or the default the first time; or none if one is showing */
  toggle(): void;
  /** an extra model arrived: fade it and re-work "hide above" if a sheet is up */
  onModelAdded(): void;
  setHideAbove(on: boolean): void;
  setOnFloor(on: boolean): void;
  /** does the "on floor" option apply to this sheet (a ceiling or roof plan above its floor)? */
  floorOption(s: BlueprintSheet): boolean;
}

export function createBlueprints({
  config,
  scene,
  renderer,
  owners,
  groups,
  materials,
  applyVisibility,
  onChange,
}: {
  config: BlueprintsConfig;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  owners: THREE.Object3D[];
  groups: Groups;
  materials: MaterialsApi;
  applyVisibility: () => void;
  /** the sheet or an option changed (the panel, the legend) */
  onChange: () => void;
}): Blueprints {
  const bp: BlueprintState = {
    index: null,
    active: null,
    last: null,
    mesh: null,
    cache: {},
    fade: 0.2,
    hideAbove: true,
    onFloor: false,
    faded: new Map(),
    hidden: [],
  };

  async function loadIndex(): Promise<BlueprintSheet[]> {
    let j: { sheets?: SheetEntry[] } | null = null;
    try {
      const r = await fetch(config.index);
      j = r.ok ? ((await r.json()) as { sheets?: SheetEntry[] }) : null;
    } catch (err) {
      console.warn(`blueprints: no sheet index (${(err as Error).message})`); // the walkthrough just has no blueprints
    }
    bp.index = (j?.sheets || []).map(normaliseSheet);
    return bp.index;
  }

  // model fade: every mesh in the model is drawn with a copy of its material (or of whatever is beneath the fade in its
  // stack: a light's glowing copy), transparent at fade x its own opacity, without depth writes
  // (one copy per material, made the first time a mesh shows it; the copy of a light's glow that a fixture's mesh
  // leaves behind when the lights stop stays cached until the fade goes off)
  let fade: MaterialOverride | null = null;
  type Lit = THREE.Material & { emissive?: THREE.Color; emissiveIntensity?: number };
  function fadedOf(below: Lit): THREE.Material {
    let f = bp.faded.get(below) as Lit | undefined;
    if (!f) {
      f = below.clone() as Lit;
      // a wire screen's shader tweak (core/materials.ts) isn't part of a clone
      f.onBeforeCompile = below.onBeforeCompile;
      f.customProgramCacheKey = below.customProgramCacheKey;
      Object.assign(f, { transparent: true, opacity: below.opacity * bp.fade, depthWrite: false });
      bp.faded.set(below, f);
    } else if (below.emissive && f.emissive) {
      // the stack runs again: what changes live beneath the fade is a light's glow (lights refresh their override)
      f.emissive.copy(below.emissive);
      f.emissiveIntensity = below.emissiveIntensity;
    }
    return f;
  }
  function fadeModel(on: boolean): void {
    fade?.dispose();
    fade = null;
    if (on) {
      const meshes: THREE.Mesh[] = [];
      for (const o of owners)
        o.traverse((m) => {
          if (isMesh(m)) meshes.push(m);
        });
      fade = materials.push(meshes, fadedOf, { priority: MATERIAL_PRIORITY.fade });
    } else {
      for (const f of bp.faded.values()) f.dispose();
      bp.faded.clear();
    }
  }

  function setBlueprintFade(f: number): void {
    bp.fade = THREE.MathUtils.clamp(f, 0, 1);
    for (const [below, copy] of bp.faded) copy.opacity = below.opacity * bp.fade; // the copies are what is drawn
    onChange();
  }

  // the sheet's quad from its corners (plan frame), wound to face outwards for an elevation (invisible from inside)
  function blueprintMesh(s: BlueprintSheet, tex: THREE.Texture) {
    const c = s.corners;
    const dz = s.kind === 'plan' && bp.onFloor && s.z_floor != null ? s.z_floor - c.tl[2] : 0;
    const v = (['tl', 'tr', 'bl', 'br'] as const).map((k) => P(c[k][0], c[k][1], c[k][2] + dz + 0.02));
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        v.flatMap((p) => [p.x, p.y, p.z]),
        3,
      ),
    );
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 0, 0, 1, 0], 2));
    let idx = [0, 2, 1, 1, 2, 3];
    let side: THREE.Side = THREE.DoubleSide;
    if (s.kind === 'elevation') {
      const out = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] }[s.face!];
      const n = new THREE.Vector3().subVectors(v[2], v[0]).cross(new THREE.Vector3().subVectors(v[1], v[0]));
      if (n.dot(P(out[0], out[1], 0)) < 0) idx = [0, 1, 2, 1, 3, 2];
      side = THREE.FrontSide;
    }
    g.setIndex(idx);
    const m = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.renderOrder = 1000;
    mesh.frustumCulled = false;
    mesh.name = `Blueprint_${s.id}`;
    return mesh;
  }

  // what "hide above" hides for a plan: anything starting more than 2.4 m over the floor of the sheet's storey, and
  // roofs and ceilings more than 1 m over it (a hip's eave hangs below its plate). For a roof or ceiling plan that also
  // takes the ceilings and roofs it describes, so the drawing isn't hidden behind them.
  function blueprintHidden(s: BlueprintSheet): THREE.Object3D[] {
    if (s.kind !== 'plan') return [];
    const zf = (s.z_floor ?? s.corners.tl[2]) * planUnit(); // the sheet's storey, even for a ceiling plan
    const rc = new Set([...groups.roof, ...groups.ceiling]);
    return owners.filter((o) => {
      const box = o.userData.box as THREE.Box3 | undefined;
      return box && (box.min.y > zf + 2.4 || (rc.has(o) && box.min.y > zf + 1.0));
    });
  }

  async function showBlueprint(id: string | null): Promise<void> {
    const s = bp.index?.find((x) => x.id === id) || null;
    if (bp.mesh) {
      scene.remove(bp.mesh);
      bp.mesh.geometry.dispose();
      bp.mesh.material.dispose();
      bp.mesh = null;
    }
    bp.active = s;
    onChange();
    if (!s) {
      fadeModel(false);
      bp.hidden = [];
      applyVisibility();
      return;
    }
    bp.last = s.id;
    if (!bp.cache[s.id]) {
      bp.cache[s.id] = new THREE.TextureLoader().loadAsync(new URL(s.file, config.index).href).then((t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        return t;
      });
    }
    let tex: THREE.Texture;
    try {
      tex = await bp.cache[s.id];
    } catch (err) {
      delete bp.cache[s.id];
      console.warn(`blueprint ${s.file} not loaded (${(err as Error).message})`);
      await showBlueprint(null);
      throw new Error(`${s.title}: the sheet's image didn't load`, { cause: err });
    }
    if (bp.active !== s) return; // another sheet was chosen while this one loaded
    bp.mesh = blueprintMesh(s, tex);
    scene.add(bp.mesh);
    fadeModel(true);
    bp.hidden = blueprintHidden(s);
    applyVisibility();
    onChange();
  }

  const floorOption = (s: BlueprintSheet) =>
    s.kind === 'plan' && s.z_floor != null && Math.abs(s.z_floor - s.corners.tl[2]) * planUnit() > 0.1524;

  function toggle(): void {
    showBlueprint(
      bp.active ? null : bp.last || (bp.index?.find((x) => x.id === config.default) || bp.index?.[0])?.id || null,
    );
  }

  function onModelAdded(): void {
    if (bp.active) {
      fadeModel(true);
      bp.hidden = blueprintHidden(bp.active);
    }
  }

  function setHideAbove(on: boolean): void {
    bp.hideAbove = on;
    applyVisibility();
    onChange();
  }
  function setOnFloor(on: boolean): void {
    bp.onFloor = on;
    onChange();
    if (bp.active) showBlueprint(bp.active.id);
  }

  return {
    bp,
    loadIndex,
    showBlueprint,
    setBlueprintFade,
    fadeModel,
    blueprintHidden,
    toggle,
    onModelAdded,
    setHideAbove,
    setOnFloor,
    floorOption,
  };
}
