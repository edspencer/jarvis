// Small typing helpers over three.js's loose object graph.
import type * as THREE from 'three';

export const isMesh = (o: THREE.Object3D): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true;

/** glTF meshes carry one standard (or physical) material; never an array */
export const matOf = (o: THREE.Mesh): THREE.MeshStandardMaterial => o.material as THREE.MeshStandardMaterial;

/** the node name the glb gave (gltfpack keeps it in extras when it renames) */
export const nodeName = (o: THREE.Object3D): string => (o.userData?.name as string | undefined) || o.name;

/** is `o` and every ancestor visible? */
export function isShown(o: THREE.Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false;
  return true;
}
