// Types shared by the core and the plugins.
import type { Object3D, Vector3 } from 'three';
import type { Mode } from './plugin/types';
export type { Mode, PickResult } from './plugin/types';

/** the viewer's toggles */
export interface ViewState {
  mode: Mode;
  cutaway: boolean;
  upperHidden: boolean;
  ghost: boolean;
  running: boolean;
  /** layer id -> hidden (the site's layers, the door layer included) */
  hidden: Record<string, boolean>;
}

export interface Player {
  /** the body's sizes (m): eye heights, radius, step */
  body: { eyeHeight: number; crouchEyeHeight: number; radius: number; maxStep: number };
  /** feet position, three.js metres */
  pos: Vector3;
  vy: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
  /** smoothed eye height, world Y */
  eyeY: number;
  floor: null;
  /** current eye height above the feet (eased between standing and crouched) */
  eye: number;
  crouched: boolean;
}

export type Keys = Record<string, boolean>;

/** top-level nodes sorted by what hides them: one list per site layer (roof, ceiling, door and the site's own), and
 * `upper` (the upper storeys, for U) */
export type Groups = Record<string, Object3D[]> & { upper: Object3D[] };

/** fixture id -> its node */
export type Fixtures = Record<string, Object3D>;

/** fly the camera to look at `target` (world), standing off towards `centre` (or away from the building if null) */
export type FlyFn = (target: Vector3, centre?: Vector3 | null) => void;

/** can the camera see world point p? (a ray against the collider) */
export type SeenFn = (p: Vector3) => boolean;

/** a merged node's part (a parts file): [name, bbox (min xyz, max xyz; three.js m), materials, extras] */
export type PartEntry = [string, [number, number, number, number, number, number], string[], Record<string, unknown>];
export type PartsIndex = Record<string, PartEntry[]>;
