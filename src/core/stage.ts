// Renderer, scene, camera and the lights that don't depend on the model.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Sky } from 'three/addons/objects/Sky.js';
import type { Site } from '../site';
import { P } from './units';

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sky: Sky;
  hemi: THREE.HemisphereLight;
  /** a dim headlamp on the camera (walk mode only) */
  lamp: THREE.PointLight;
  sun: THREE.DirectionalLight;
  /** the building's centre, world space */
  centre: THREE.Vector3;
  /** how far from the centre the sun is placed (m) */
  sunDistance: number;
  /** size the sun's shadow square to the model's box, unless the site gives its own */
  fitShadows(box: THREE.Box3): void;
}

/** the far ground's colour when the site gives none (linear RGB: grass) */
const GRASS = [0.18, 0.32, 0.1] as const;

export function createStage(container: HTMLElement, site: Site): Stage {
  const centre = P(site.centre[0], site.centre[1], 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; // the scene is static: re-render shadows only on change
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 5000);
  camera.rotation.order = 'YXZ';

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;

  const sky = new Sky();
  sky.scale.setScalar(4000);
  const u = sky.material.uniforms;
  u.turbidity.value = 4;
  u.rayleigh.value = 1.2;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.8;
  scene.add(sky);

  const hemi = new THREE.HemisphereLight(0xe4eeff, 0x8b7d62, 0.7);
  scene.add(hemi);
  // unshadowed fill from a fixed direction, so walls facing different ways read apart indoors, plus a dim
  // headlamp on the camera that separates near and far surfaces (the sun can't reach most rooms)
  const fill = new THREE.DirectionalLight(0xfff6ea, 0.55);
  fill.position.set(0.6, 1, 0.35);
  scene.add(fill);
  const lamp = new THREE.PointLight(0xfff0dd, 1.1, 14, 1.6);
  camera.add(lamp);
  scene.add(camera);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  // the shadow camera: a square round the centre (the site's, or fitted to the model once it is in), looking from the
  // sun, which stands sunDistance off the centre
  const stage = { sunDistance: 150 } as Stage;
  function shadowSquare(r: number): void {
    stage.sunDistance = Math.max(150, 3 * r);
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 2 * stage.sunDistance });
    sun.shadow.camera.updateProjectionMatrix();
  }
  shadowSquare(site.shadowRadius !== null ? site.shadowRadius * site.unit : 45);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.target.position.copy(centre);
  scene.add(sun, sun.target);

  // the far ground: a plain disc beyond the model's own site, at the manifest's level (just under its grade)
  const farMat = new THREE.MeshStandardMaterial({ roughness: 1 });
  const far = new THREE.Mesh(new THREE.CircleGeometry(1500, 48).rotateX(-Math.PI / 2), farMat);
  if (site.ground.colour) farMat.color.set(site.ground.colour);
  else farMat.color.setRGB(...GRASS);
  far.position.set(centre.x, site.ground.z * site.unit, centre.z);
  farMat.depthWrite = false; // never covers the lot's own surfaces
  far.renderOrder = -1;
  far.receiveShadow = true;
  scene.add(far);

  function fitShadows(box: THREE.Box3): void {
    if (site.shadowRadius !== null || box.isEmpty()) return;
    const r = Math.max(
      ...[box.min.x, box.max.x].flatMap((x) =>
        [box.min.z, box.max.z].map((z) => Math.hypot(x - centre.x, z - centre.z)),
      ),
    );
    shadowSquare(r + 2);
  }

  return Object.assign(stage, { renderer, scene, camera, sky, hemi, lamp, sun, centre, fitShadows });
}
