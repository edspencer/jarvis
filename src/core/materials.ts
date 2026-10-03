// Colours and textures come from the model (glTF materials). Only rendering choices are made here, by material role:
// glass, water and wire screens, named in the site manifest (or given as a material's `role` extra). No material may
// keep transmission: any one transmissive material makes three.js draw the whole opaque scene again into a
// transmission target every frame (one small lantern's glass alone doubled the draw calls), so it becomes alpha.
import type * as THREE from 'three';
import type { Site } from '../site';

type GltfMaterial = THREE.MeshStandardMaterial & { transmission?: number };

/** a GLSL float literal */
const glsl = (x: number): string => {
  const s = String(Number(x.toFixed(6)));
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
};

export interface Materials {
  isGlass(m: THREE.Material): boolean;
  isWater(m: THREE.Material): boolean;
  /** the rendering tweaks, once per material */
  tune(m: THREE.Material): void;
}

export function createMaterials(roles: Site['materials']): Materials {
  const glass = new Set(roles.glass),
    water = new Set(roles.water);
  const role = (m: THREE.Material): unknown => m.userData?.role;
  const isGlass = (m: THREE.Material) => glass.has(m.name) || role(m) === 'glass';
  const isWater = (m: THREE.Material) => water.has(m.name) || role(m) === 'water';
  /** a wire screen's wire fraction, or null */
  const wireOf = (m: THREE.Material): number | null => {
    const s = roles.screens[m.name];
    if (s) return s.wire;
    return role(m) === 'screen' && typeof m.userData.wire === 'number' ? m.userData.wire : null;
  };

  function tune(material: THREE.Material): void {
    const m = material as GltfMaterial;
    if ((m.transmission ?? 0) > 0) {
      Object.assign(m, {
        transparent: true,
        opacity: Math.min(m.opacity, Math.max(0.15, 1 - (m.transmission ?? 0))),
        depthWrite: false,
        transmission: 0,
      });
    }
    if (isGlass(m)) {
      Object.assign(m, {
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        roughness: 0.05,
        metalness: 0,
        transmission: 0,
      });
    }
    const w = wireOf(m);
    if (w !== null) {
      // a wire screen (alpha-blended). Seen from outside (the screen's faces point outwards), a wire mesh closes up at
      // grazing angles: open fraction (1 - w)(1 - w / cos t), so e.g. w = 0.19 gives 0.35 alpha head-on and opaque
      // beyond ~79 deg; from inside, the material's flat alpha
      Object.assign(m, { depthWrite: false });
      m.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
        if (gl_FrontFacing) {
          float cosT = max(abs(dot(normalize(normal), normalize(vViewPosition))), 1e-3);
          diffuseColor.a = 1.0 - ${glsl(1 - w)} * max(0.0, 1.0 - ${glsl(w)} / cosT);
        }`,
        );
      };
      m.customProgramCacheKey = () => `jarvis-screen:${w}`; // one program per wire fraction
      m.needsUpdate = true;
    }
    if (isWater(m)) {
      Object.assign(m, { transparent: true, opacity: 0.8, depthWrite: true, roughness: 0.05, transmission: 0 });
    }
    if (m.map) m.map.anisotropy = 8;
  }

  return { isGlass, isWater, tune };
}
