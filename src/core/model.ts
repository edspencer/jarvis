// The model. The main model (the building, its site and its light fixtures) loads first; as soon as it is in, you can
// walk. The site's extra models (furniture, say) follow in the background, or on their layer's first key press. A
// model build may merge static geometry into buckets (by material, storey, tile…), so a node is no longer one source
// object: the extras `merged` key names its entry in the model's parts file, which lists the objects that went in.
// Fixtures (`fixture_id`), door leaves, room floors and the pieces of an extra model stay their own nodes. The node,
// material and extras conventions are docs/model-format.md; which names mean what is the site manifest's (layers,
// materials, colliders, rooms).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { MeshBVH, acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh';
import { matches, upperFromY, type ResolvedModel, type Site } from '../site';
import { createMaterials } from './materials';
import { isMesh, matOf, nodeName } from './three-utils';
import type { Fixtures, Groups, PartsIndex } from './types';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;

export type ExtraStatus = 'none' | 'loading' | 'loaded' | 'failed';

/** an extra model's loading state */
export interface Extra {
  model: ResolvedModel;
  status: ExtraStatus;
  promise: Promise<void> | null;
}

export interface Plants {
  group: THREE.Group | null;
  owners: THREE.Object3D[];
}

export interface Model {
  root: THREE.Group;
  groups: Groups;
  /** fixture_id -> node */
  fixtures: Fixtures;
  /** top-level glTF nodes */
  owners: THREE.Object3D[];
  /** merged-node key -> its parts */
  parts: PartsIndex;
  /** room floor nodes (the floor prefix, with a `room` extra) */
  rooms: THREE.Object3D[];
  collider: THREE.Mesh | null;
  /** the main model's wall-plate group, handed to the switches plugin */
  switchRoot: THREE.Object3D | null;
  plants: Plants;
  /** the extra models by id */
  extras: Record<string, Extra>;
  /** the main model's box (world), once it is in */
  box: THREE.Box3;
  /** is this material see-through glass (picking looks through it)? */
  isGlass(m: THREE.Material): boolean;
  loadModel(onProgress: (pct: number) => void): Promise<void>;
  /** load an extra model (once); resolves when it is in, or failed */
  loadExtra(id: string): Promise<void>;
  /** the top-level node a descendant belongs to */
  ownerOf(o: THREE.Object3D): THREE.Object3D;
}

export function createModel({
  site,
  renderer,
  scene,
  onExtraStatus,
  onExtraLoaded,
}: {
  site: Site;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** an extra model started or failed loading (the HUD's flags) */
  onExtraStatus: () => void;
  /** an extra model is in the scene */
  onExtraLoaded: () => void;
}): Model {
  const root = new THREE.Group();
  scene.add(root);
  const groups: Groups = { upper: [] };
  for (const l of site.layers) groups[l.id] = [];
  const upperY = upperFromY(site);
  const mats = createMaterials(site.materials);
  const fixtures: Fixtures = {};
  const owners: THREE.Object3D[] = [];
  const parts: PartsIndex = {};
  const rooms: THREE.Object3D[] = [];
  const plants: Plants = { group: null, owners: [] };
  const tuned = new Set<THREE.Material>();

  const loader = new GLTFLoader()
    .setMeshoptDecoder(MeshoptDecoder)
    // no transcoder path: KTX2Loader finds basis_transcoder.js / .wasm next to itself (new URL(…, import.meta.url)),
    // which the bundler copies into the build, so it works offline
    .setKTX2Loader(new KTX2Loader().detectSupport(renderer));

  function ownerOf(o: THREE.Object3D): THREE.Object3D {
    while (o && o.parent && o.parent !== root) o = o.parent;
    return o;
  }

  // Sort one top-level node into the layers; returns true if it is solid (goes into the collider). `layer`: the extra
  // model's layer, which takes every node of that model.
  function registerNode(node: THREE.Object3D, layer: string | null = null): boolean {
    const name = nodeName(node);
    owners.push(node);
    const box = new THREE.Box3().setFromObject(node);
    node.userData.box = box;
    let isGlass = false,
      isWater = false;
    // a light fixture is one node with `fixture_id` (its parts as children)
    const isFixture = !!node.userData.fixture_id;
    const materials = new Set<string>();
    node.traverse((o) => {
      if (!isMesh(o)) return;
      const m = matOf(o),
        mn = m.name || '';
      materials.add(mn);
      const glass = mats.isGlass(m),
        water = mats.isWater(m);
      if (glass) isGlass = true;
      if (water) isWater = true;
      if (!tuned.has(m)) {
        tuned.add(m);
        mats.tune(m);
      }
      // fixtures are small and mostly under a ceiling: casting would only add shadow-map draw calls
      o.castShadow = !glass && !water && !m.transparent && !isFixture;
      o.receiveShadow = true;
      // indirect: leave the index alone. Primitives can share one index accessor (gltf-transform and gltfpack dedupe
      // them), and a BVH that reorders it in place breaks the BVH of every other mesh using it.
      o.geometry.computeBoundsTree({ indirect: true });
    });
    const facts = { name, extras: node.userData, materials };
    // every layer can be hidden, so none is solid: hiding one never leaves invisible walls (doors are open; roofs and
    // ceilings go with the cutaway)
    let inLayer = false;
    for (const l of site.layers)
      if (l.id === layer || matches(l.match, facts)) {
        groups[l.id].push(node);
        inLayer = true;
      }
    if (groups.roof.includes(node) || box.min.y > upperY) groups.upper.push(node);
    if (name.startsWith(site.floorPrefix) && node.userData.room) rooms.push(node);
    if (isFixture) fixtures[node.userData.fixture_id as string] = node;
    // collision: everything solid except the layers, glass, water, the light fixtures and what the site marks passable
    const passable = inLayer || isGlass || isWater || isFixture || matches(site.passable, facts);
    return !passable;
  }

  // World-space triangle soup of the solid meshes, as one BVH. Reads through getX(), so meshopt-quantised (normalised
  // int16) positions come out in metres.
  function buildCollider(solids: THREE.Mesh[]): THREE.Mesh {
    let n = 0;
    for (const o of solids) n += o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count;
    const arr = new Float32Array(n * 3),
      v = new THREE.Vector3();
    let k = 0;
    for (const o of solids) {
      const pos = o.geometry.attributes.position,
        idx = o.geometry.index;
      const cnt = idx ? idx.count : pos.count;
      for (let i = 0; i < cnt; i++) {
        v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld);
        arr[k++] = v.x;
        arr[k++] = v.y;
        arr[k++] = v.z;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    g.boundsTree = new MeshBVH(g);
    const c = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    c.updateMatrixWorld(true);
    return c;
  }

  // the provenance of merged objects, for the inspect panel; optional (an older drop has none)
  function loadParts(file: string): void {
    fetch(file)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { parts?: PartsIndex } | null) => {
        if (j) Object.assign(parts, j.parts);
      })
      .catch(() => {});
  }

  // The plants (extras layer: plants): one glb node per plant, every plant of a class sharing its class's mesh.
  // Each (geometry, material) pair becomes one THREE.InstancedMesh, so ~100 plants of ~40 classes cost ~40 draw calls.
  // The plant nodes are kept (out of the scene) as the inspect panel's owners: a hit on instance i shows plantOwners[i]'s
  // extras. Plants are passable and stay out of the collider (a tree is no wall), cast and receive shadows (alpha-tested
  // leaves), and no toggle hides them.
  function instancePlants(plantRoot: THREE.Object3D): void {
    plantRoot.updateMatrixWorld(true);
    const byKey = new Map<
      string,
      { geometry: THREE.BufferGeometry; material: THREE.Material; items: { m: THREE.Matrix4; owner: THREE.Object3D }[] }
    >();
    plantRoot.traverse((o) => {
      if (!isMesh(o)) return;
      let owner: THREE.Object3D | null = o;
      // a plant node carries the extra `plant_id`
      while (owner && !owner.userData?.plant_id) owner = owner.parent;
      const material = o.material as THREE.Material;
      const k = `${o.geometry.uuid}|${material.uuid}`;
      if (!byKey.has(k)) byKey.set(k, { geometry: o.geometry, material, items: [] });
      byKey.get(k)!.items.push({ m: o.matrixWorld.clone(), owner: owner || o });
    });
    const g = new THREE.Group();
    g.name = 'Plants_instanced';
    g.userData.layer = 'plants';
    for (const { geometry, material, items } of byKey.values()) {
      if (!tuned.has(material)) {
        tuned.add(material);
        mats.tune(material);
      }
      const im = new THREE.InstancedMesh(geometry, material, items.length);
      items.forEach((it, i) => im.setMatrixAt(i, it.m));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingBox();
      im.computeBoundingSphere();
      im.userData.plantOwners = items.map((it) => it.owner);
      im.castShadow = true;
      im.receiveShadow = true;
      im.name = `Plants_${geometry.name || byKey.size}`;
      g.add(im);
    }
    root.add(g);
    plants.group = g;
    plants.owners = [...new Set([...byKey.values()].flatMap((x) => x.items.map((it) => it.owner)))];
  }

  const model: Model = {
    root,
    groups,
    fixtures,
    owners,
    parts,
    rooms,
    collider: null,
    switchRoot: null,
    plants,
    extras: Object.fromEntries(site.models.extra.map((m) => [m.id, { model: m, status: 'none', promise: null }])),
    box: new THREE.Box3(),
    isGlass: mats.isGlass,
    loadModel,
    loadExtra,
    ownerOf,
  };

  async function loadModel(onProgress: (pct: number) => void): Promise<void> {
    const gltf = await loader.loadAsync(site.models.main.url, (e) => {
      if (e.total) onProgress(Math.round((100 * e.loaded) / e.total));
    });
    const top = gltf.scene;
    // the wall plates (a group with extras layer: switches) stay out of the collider and the layers: the switches
    // plugin swaps them for instanced meshes (until it loads, or without it, they are drawn as they are); likewise the
    // plants (layer: plants), instanced here
    model.switchRoot = top.children.find((n) => n.userData.layer === 'switches') || null;
    const plantRoot = top.children.find((n) => n.userData.layer === 'plants') || null;
    const nodes = [...top.children].filter((n) => n !== model.switchRoot && n !== plantRoot);
    for (const n of nodes) root.add(n);
    if (model.switchRoot) root.add(model.switchRoot);
    root.updateMatrixWorld(true);
    if (plantRoot) instancePlants(plantRoot);
    const solids: THREE.Mesh[] = [];
    for (const node of nodes) if (registerNode(node)) node.traverse((o) => isMesh(o) && solids.push(o));
    model.collider = buildCollider(solids);
    for (const n of nodes) model.box.union(n.userData.box as THREE.Box3);
    if (site.models.main.parts) loadParts(site.models.main.parts);
  }

  // An extra model, in the background once the main one is up (or on its layer's first key press). Passable (its
  // nodes join its layer), so the collider is untouched.
  function loadExtra(id: string): Promise<void> {
    const x = model.extras[id];
    if (!x) return Promise.resolve();
    if (x.promise) return x.promise;
    x.status = 'loading';
    onExtraStatus();
    x.promise = loader
      .loadAsync(x.model.url)
      .then((gltf) => {
        const nodes = [...gltf.scene.children];
        for (const n of nodes) root.add(n);
        root.updateMatrixWorld(true);
        for (const n of nodes) registerNode(n, x.model.layer);
        x.status = 'loaded';
        onExtraLoaded();
        if (x.model.parts) loadParts(x.model.parts);
      })
      .catch((err: Error) => {
        x.status = 'failed';
        onExtraStatus();
        console.warn(`${x.model.url} not loaded (${err.message}); the viewer works without it`);
      });
    return x.promise;
  }

  return model;
}
