// An area: one part of the demo house (a room or a few) and everything in it, so each can be worked on in its own file
// (tools/demo-site/areas/<area>.ts). The aggregators in areas/index.ts collect them, in the order of its AREAS list,
// into the main model, the furniture model and the data files. The building's structure (rooms, walls, openings, the
// stair, floors, ceilings and roofs) is shared: layout.ts and main-model.ts.
//
// Breakers are written as the panel schedule writes them (panel.ts): "7", "1+3". Every one is checked against the
// schedule (circuitOn), so the energy map can find everything on a circuit (areas/index.ts: onCircuit).
import type { Shape, V3 } from './geometry.ts';
import type { MaterialDef, Model } from './model.ts';
import { ROOMS, eye, pos } from './layout.ts';

/** a light fixture: one `Fixture_<id>` node (docs/model-format.md §5); ids `<room>.<kind>[.<n>]` */
export interface Fixture {
  id: string;
  /** a built-in shape (fixtures.ts) or one an area registers in its fixtureShapes */
  kind: string;
  /** the switched group (`fixture.<…>`): fixtures on one switch */
  group: string;
  /** a room id, or 'exterior' */
  room: string;
  /** the mounting point (plan metres) */
  at: V3;
  /** the direction a wall fixture faces (yaw, radians, about plan Z; its shape faces -Y before the yaw) */
  yaw?: number;
  /** the breaker it is on, as the panel schedule writes it ("7") */
  breaker: string;
  /** the model it goes in: the main model (default) or the furniture model (a lamp) */
  model?: 'main' | 'furniture';
}

/** one switch or receptacle position on a wall plate (docs/model-format.md §8) */
export interface PlatePosition {
  pos: number;
  role: string;
  /** as the panel schedule writes it ("5", "14+16") */
  breaker: string;
  fixture_ids?: string[];
  ha_entity?: string;
  link?: { box: string; pos: number; dir: 'with' | 'to' | 'from' };
}
/** a wall plate: `Switch_<id>` under the Switches group; ids `<ROOM>-<S|O>-<letter>` (docs/demo-house.md) */
export interface PlateSpec {
  id: string;
  room: string;
  kind: 'switch' | 'outlet';
  /** the plate's centre on the wall face, and the face's outward normal (plan) */
  at: V3;
  normal: [number, number];
  positions: PlatePosition[];
  notes?: string;
}

/** a registry pin (registry_pins.json): equipment, ids `<category>.<name>` */
export interface Pin {
  id: string;
  name: string;
  category: string;
  /** a room id, or 'exterior' */
  room: string;
  at: V3;
  make?: string;
  model?: string;
  approx?: 'room-centroid' | 'z-guess' | null;
  fixtures?: string[];
  ha?: string[];
  specs?: [string, string][];
  note?: string;
  /** the breaker it is on, if it has one of its own */
  breaker?: string;
  /** links to other pins ('monitored by', 'fed from'…); the registry's referenced_by is built from these */
  connections?: { key: string; text: string; refs: string[] }[];
  /** documents (default: the model's manual, if it has a model) */
  documents?: { text: string; url: string | null }[];
  open_questions?: string[];
}

/** a device of the faults plugin's map (ha_devices.json; docs/plugins/faults.md) */
export type Device = Record<string, unknown>;

export interface Area {
  id: string;
  /** extra materials (merged into MATERIALS; a name already defined, here or by another area, is an error) */
  materials?: Record<string, MaterialDef>;
  /** extra fixture shapes by kind, about the mounting point (merged with fixtures.ts's built-in kinds; a clash is an
   * error). Fixtures of one kind share one mesh per model. */
  fixtureShapes?: Record<string, () => Shape>;
  fixtures?: Fixture[];
  plates?: PlateSpec[];
  pins?: Pin[];
  devices?: Device[];
  /** ha_map.json entries, by fixture id (every fixture must have one) */
  haMap?: Record<string, Record<string, unknown>>;
  /** model nodes (built-ins, appliances, furniture) a circuit feeds: [node name, breaker] */
  nodeFeeds?: [string, string][];
  /** built-ins and appliances into the main model (demo.glb) */
  buildMain?(m: Model): void;
  /** furniture into the furniture model (furniture.glb) */
  buildFurniture?(m: Model): void;
}

/** where a device of ha_devices.json is: by a fixture, a wall plate, a registry pin or an area (a room) */
export function place(src: string, ref: string | string[] | undefined, roomId: string, at: V3, approx = false) {
  const r = ROOMS.find((x) => x.id === roomId);
  return {
    src,
    ref,
    plan: at.map((v) => +v.toFixed(3)),
    room: r?.name || roomId,
    approx,
    conf: approx ? 'low' : 'high',
    pos: pos(at),
    centre: r ? eye(r) : null,
  };
}
