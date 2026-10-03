// Types shared by the core and the plugins.
import type { Intersection, Object3D, Vector3 } from 'three';
import type { HA } from '../plugins/home-assistant/ha';
import type { Faults } from '../plugins/faults/faults';
import type { Pins } from '../plugins/pins/pins';
import type { Plate, Switches } from '../plugins/switches/switches';

export type Mode = 'walk' | 'orbit';

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

/** document.getElementById, typed loosely: every id the code asks for is in index.html */
export type DomLookup = <T extends HTMLElement = HTMLElement>(id: string) => T;
export type Escape = (s: unknown) => string;

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

export interface PickResult {
  node: Object3D;
  hit: Intersection;
  part: { name: string; props: Record<string, unknown> } | null;
  plate?: Plate;
}

/** the optional layers, loaded on demand; null until (or unless) they load */
export interface PluginSlots {
  ha: HA | null;
  faults: Faults | null;
  pins: Pins | null;
  switches: Switches | null;
}
