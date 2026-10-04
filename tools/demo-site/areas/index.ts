// The areas of the demo house, in order (the order of their nodes in the models and of their entries in the data
// files), and everything collected from them. Checked here, once: unique ids, known rooms, fixture kinds and
// materials, and every breaker named against the panel schedule.
import type { Shape } from '../geometry.ts';
import { addMaterials } from '../model.ts';
import { ROOMS } from '../layout.ts';
import { FIXTURE_SHAPES } from '../fixtures.ts';
import { circuitOn } from '../panel.ts';
import type { Area, Device, Fixture, Pin, PlateSpec } from '../area.ts';
import { living } from './living.ts';
import { kitchen } from './kitchen.ts';
import { hall } from './hall.ts';
import { upstairs } from './upstairs.ts';
import { garage } from './garage.ts';
import { outside } from './outside.ts';

export const AREAS: Area[] = [living, kitchen, hall, upstairs, garage, outside];

export const FIXTURES: Fixture[] = AREAS.flatMap((a) => a.fixtures ?? []);
export const PLATES: PlateSpec[] = AREAS.flatMap((a) => a.plates ?? []);
export const PINS: Pin[] = AREAS.flatMap((a) => a.pins ?? []);
export const DEVICES: Device[] = AREAS.flatMap((a) => a.devices ?? []);
export const HA_MAP: Record<string, Record<string, unknown>> = Object.assign({}, ...AREAS.map((a) => a.haMap ?? {}));
export const NODE_FEEDS: [string, string][] = AREAS.flatMap((a) => a.nodeFeeds ?? []);

const SHAPES: Record<string, () => Shape> = { ...FIXTURE_SHAPES };

/** a fixture kind's shape (built-in or an area's) */
export function fixtureShape(kind: string): Shape {
  const f = SHAPES[kind];
  if (!f) throw new Error(`no fixture shape ${kind}`);
  return f();
}

export const fixtureById = (id: string): Fixture => {
  const f = FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`no fixture ${id}`);
  return f;
};
export const plateById = (id: string): PlateSpec => {
  const p = PLATES.find((x) => x.id === id);
  if (!p) throw new Error(`no wall plate ${id}`);
  return p;
};
export const pinById = (id: string): Pin => {
  const p = PINS.find((x) => x.id === id);
  if (!p) throw new Error(`no registry pin ${id}`);
  return p;
};

/** everything on a circuit (by its energy-map id, panel.ts): the wall plates with a position on it, and the
 * fixtures, registry pins and model nodes that name its breaker */
export function onCircuit(id: string) {
  const on = (breaker: string | undefined) => breaker !== undefined && circuitOn(breaker).id === id;
  return {
    plates: PLATES.filter((p) => p.positions.some((q) => on(q.breaker))),
    fixtures: FIXTURES.filter((f) => on(f.breaker)),
    pins: PINS.filter((p) => on(p.breaker)),
    nodes: [...new Set(NODE_FEEDS.filter(([, b]) => on(b)).map(([n]) => n))],
  };
}

// ------------------------------------------------------------------ checks
function check(): void {
  const unique = (what: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`${what} ${id} is defined twice`);
      seen.add(id);
    }
  };
  unique(
    'area',
    AREAS.map((a) => a.id),
  );
  unique(
    'fixture',
    FIXTURES.map((f) => f.id),
  );
  unique(
    'wall plate',
    PLATES.map((p) => p.id),
  );
  unique(
    'registry pin',
    PINS.map((p) => p.id),
  );
  unique(
    'device',
    DEVICES.map((d) => String(d.id)),
  );
  unique(
    'ha_map entry',
    AREAS.flatMap((a) => Object.keys(a.haMap ?? {})),
  );

  for (const a of AREAS) {
    if (a.materials) addMaterials(a.materials, a.id);
    for (const [kind, f] of Object.entries(a.fixtureShapes ?? {})) {
      if (SHAPES[kind]) throw new Error(`area ${a.id}: fixture shape ${kind} is already defined`);
      SHAPES[kind] = f;
    }
  }
  const rooms = new Set([...ROOMS.map((r) => r.id), 'exterior']);
  const room = (what: string, r: string) => {
    if (!rooms.has(r)) throw new Error(`${what}: no room ${r}`);
  };
  const fixtureIds = new Set(FIXTURES.map((f) => f.id));
  for (const f of FIXTURES) {
    room(`fixture ${f.id}`, f.room);
    if (!SHAPES[f.kind]) throw new Error(`fixture ${f.id}: no fixture shape ${f.kind}`);
    circuitOn(f.breaker);
    if (!HA_MAP[f.id]) throw new Error(`fixture ${f.id} is not in ha_map.json (map it, or map it to null)`);
  }
  for (const id of Object.keys(HA_MAP)) if (!fixtureIds.has(id)) throw new Error(`ha_map.json: no fixture ${id}`);
  for (const p of PLATES) {
    room(`wall plate ${p.id}`, p.room);
    for (const q of p.positions) {
      circuitOn(q.breaker);
      for (const id of q.fixture_ids ?? [])
        if (!fixtureIds.has(id)) throw new Error(`wall plate ${p.id}: no fixture ${id}`);
    }
  }
  for (const p of PINS) {
    room(`registry pin ${p.id}`, p.room);
    if (p.breaker !== undefined) circuitOn(p.breaker);
    for (const id of p.fixtures ?? [])
      if (!fixtureIds.has(id)) throw new Error(`registry pin ${p.id}: no fixture ${id}`);
  }
  for (const [, b] of NODE_FEEDS) circuitOn(b);
}
check();
