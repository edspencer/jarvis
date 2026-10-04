// Energy mode in the scene: the house ghosted (every mesh gets one faint see-through material), the metered rooms'
// floors and the metered nodes and fixtures tinted by load, and a marker (a disc that grows with the load, drawn over
// everything) at each metered registry item, wall plate, fixture and node, which is also what a click picks. The
// materials are swapped, not edited, and put back when the mode goes off; a mesh whose material someone else swapped
// meanwhile (the lights plugin preparing a fixture) keeps theirs and is ghosted again on the next update.
import * as THREE from 'three';
import type { ModelInfo } from '../../plugin-api';

export interface Anchor {
  /** the store reference ('pins:elec.panel.a', 'plates:KIT-O-H', 'fixture:den.lamp', 'node:Furn_fridge') */
  ref: string;
  at: THREE.Vector3;
  colour: string;
  /** 0-1: the marker's size */
  size: number;
}

export interface Tint {
  /** nodes (and everything under them) -> colour; rooms' floors are drawn translucent */
  nodes: Map<THREE.Object3D, string>;
  rooms: Map<THREE.Object3D, string>;
  anchors: Anchor[];
}

const GHOST = new THREE.MeshBasicMaterial({
  color: '#9fb3c8',
  transparent: true,
  opacity: 0.06,
  depthWrite: false,
});
GHOST.name = 'energy.ghost';

export function createEnergyScene(deps: { scene: THREE.Scene; model: ModelInfo; camera: THREE.Camera }) {
  const { scene, model, camera } = deps;
  /** mesh -> its own material, while ghosted or tinted */
  const saved = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  const mats = new Map<string, THREE.MeshBasicMaterial>();
  const mine = new Set<THREE.Material>([GHOST]);
  let on = false;
  let anchors: Anchor[] = [];

  const matFor = (colour: string, room: boolean) => {
    const k = `${colour}|${room}`;
    let m = mats.get(k);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color: colour,
        transparent: true,
        opacity: room ? 0.5 : 0.9,
        depthWrite: !room,
      });
      m.name = `energy.${room ? 'room' : 'load'}.${colour}`;
      mats.set(k, m);
      mine.add(m);
    }
    return m;
  };

  // the markers: one instanced disc per anchor, facing the camera, over everything
  const disc = new THREE.CircleGeometry(1, 24);
  const markMat = new THREE.MeshBasicMaterial({
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95,
  });
  const ringMat = new THREE.MeshBasicMaterial({
    color: '#10141a',
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.8,
  });
  let marks: THREE.InstancedMesh | null = null;
  let cap = 0;
  let rings: THREE.InstancedMesh | null = null;

  function roots(): THREE.Object3D[] {
    const out = new Set<THREE.Object3D>([model.root]);
    for (const list of Object.values(model.groups)) for (const n of list) out.add(n);
    return [...out];
  }

  function swap(mesh: THREE.Mesh, m: THREE.Material): void {
    const cur = mesh.material;
    const ours = Array.isArray(cur) ? cur.every((x) => mine.has(x)) : mine.has(cur);
    if (!ours) saved.set(mesh, cur); // first time, or someone swapped it since: theirs is the one to put back
    if (mesh.material !== m) mesh.material = m;
  }

  /** ghost everything, then tint what has a colour */
  function apply(t: Tint): void {
    const tinted = new Map<THREE.Mesh, THREE.Material>();
    const mark = (n: THREE.Object3D, colour: string, room: boolean) =>
      n.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) tinted.set(o as THREE.Mesh, matFor(colour, room));
      });
    for (const [n, c] of t.rooms) mark(n, c, true);
    for (const [n, c] of t.nodes) mark(n, c, false);
    const seen = new Set<THREE.Object3D>();
    for (const r of roots())
      r.traverse((o) => {
        if (seen.has(o) || !(o as THREE.Mesh).isMesh || o.userData.energyMarker) return;
        seen.add(o);
        swap(o as THREE.Mesh, tinted.get(o as THREE.Mesh) ?? GHOST);
      });
  }

  function restore(): void {
    for (const [mesh, m] of saved) {
      const cur = mesh.material;
      if (!Array.isArray(cur) && mine.has(cur)) mesh.material = m;
    }
    saved.clear();
  }

  function drawMarkers(list: Anchor[]): void {
    anchors = list;
    if (!marks || cap < list.length) {
      for (const m of [marks, rings])
        if (m) {
          scene.remove(m);
          m.dispose();
        }
      cap = Math.max(16, list.length * 2);
      marks = new THREE.InstancedMesh(disc, markMat, cap);
      rings = new THREE.InstancedMesh(disc, ringMat, cap);
      for (const m of [marks, rings]) {
        m.userData.energyMarker = true;
        m.frustumCulled = false;
        m.renderOrder = 998;
        scene.add(m);
      }
      marks.renderOrder = 999;
    }
    marks.count = rings!.count = list.length;
    const c = new THREE.Color();
    list.forEach((a, i) => marks!.setColorAt(i, c.set(a.colour)));
    if (marks.instanceColor) marks.instanceColor.needsUpdate = true;
    marks.visible = rings!.visible = on && list.length > 0;
    face();
  }

  const q = new THREE.Quaternion(),
    s = new THREE.Vector3(),
    mtx = new THREE.Matrix4(),
    cam = new THREE.Vector3();
  /** turn the discs to the camera and size them (a constant size on screen, about 10-22 px) */
  function face(): void {
    if (!marks || !rings || !on) return;
    camera.getWorldQuaternion(q);
    camera.getWorldPosition(cam);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 50;
    const px = (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2)) / Math.max(innerHeight, 1);
    anchors.forEach((a, i) => {
      const d = a.at.distanceTo(cam);
      const r = (5 + 7 * a.size) * px * d;
      mtx.compose(a.at, q, s.setScalar(r));
      marks!.setMatrixAt(i, mtx);
      mtx.compose(a.at, q, s.setScalar(r * 1.25));
      rings!.setMatrixAt(i, mtx);
    });
    marks.instanceMatrix.needsUpdate = true;
    rings.instanceMatrix.needsUpdate = true;
  }

  const v = new THREE.Vector3();
  /** the anchor under a screen point (NDC), within its disc plus a few pixels */
  function at(ndc: THREE.Vector2): Anchor | null {
    if (!on) return null;
    const w = innerWidth / 2,
      h = innerHeight / 2;
    let best: Anchor | null = null,
      bestD = Infinity;
    for (const a of anchors) {
      v.copy(a.at).project(camera);
      if (v.z < -1 || v.z > 1) continue;
      const d = Math.hypot((v.x - ndc.x) * w, (v.y - ndc.y) * h);
      if (d <= 6 + 7 * a.size + 4 && d < bestD) {
        best = a;
        bestD = d;
      }
    }
    return best;
  }

  return {
    get on() {
      return on;
    },
    /** turn energy mode on with this tint, or update it */
    show(t: Tint): void {
      on = true;
      apply(t);
      drawMarkers(t.anchors);
    },
    hide(): void {
      on = false;
      restore();
      if (marks) marks.visible = rings!.visible = false;
    },
    /** every frame while on: keep the discs facing the camera */
    frame(): void {
      if (on) face();
    },
    at,
    /** the materials it swapped in (for tests: is this mesh ghosted?) */
    isOurs: (m: THREE.Material) => mine.has(m),
    ghost: GHOST,
    dispose(): void {
      restore();
      for (const m of [marks, rings])
        if (m) {
          scene.remove(m);
          m.dispose();
        }
      disc.dispose();
      markMat.dispose();
      ringMat.dispose();
      for (const m of mats.values()) m.dispose();
    },
  };
}

export type EnergyScene = ReturnType<typeof createEnergyScene>;
