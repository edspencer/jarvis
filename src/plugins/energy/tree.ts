// The meter hierarchy and its maths, pure (unit-tested): the energy map's meters as a tree, each meter's power from
// its entities (several summed: the legs of a 240 V circuit) or, without any, from its children; every parent's
// unmetered remainder as an "Other" leaf (a reported remainder sensor wins over the computed one); the house's load;
// the consumers (the leaves and the Others, which add up to the load without counting anything twice); and the
// power of a model object or room that several meters feed (a meter whose ancestor feeds it too isn't added again).
import type { EntityState } from '../../plugin-api';
import { asList, breakerText, feedRef, type EnergyMap, type MeterKind, type MeterSpec } from './map';

export interface Meter {
  id: string;
  label: string;
  kind: MeterKind;
  spec: MeterSpec;
  parent: Meter | null;
  children: Meter[];
  /** the parent's unmetered remainder (an "Other" leaf); only on a meter with children and its own power */
  other: Meter | null;
  /** this is someone's Other */
  isOther: boolean;
  depth: number;
  power: string[];
  today: string[];
  month: string[];
  /** the store references it is bound to ('pins:elec.panel.a', 'room:kitchen', 'node:Furn_fridge') */
  refs: string[];
  /** '17+19' */
  breaker: string | null;
  panel: string | null;
}

export interface Tree {
  roots: Meter[];
  /** every meter, the Others included, parents before children */
  all: Meter[];
  byId: Record<string, Meter>;
  /** ref -> the meters bound to it */
  byRef: Map<string, Meter[]>;
  /** every entity the tree reads */
  entityIds: string[];
}

export function buildTree(map: Pick<EnergyMap, 'meters'>): Tree {
  const all: Meter[] = [];
  const byId: Record<string, Meter> = {};
  const byRef = new Map<string, Meter[]>();
  const ents = new Set<string>();
  const make = (s: MeterSpec, parent: Meter | null, depth: number): Meter => {
    const m: Meter = {
      id: s.id,
      label: s.label || s.id,
      kind: s.kind || parent?.kind || 'load',
      spec: s,
      parent,
      children: [],
      other: null,
      isOther: false,
      depth,
      power: asList(s.power),
      today: asList(s.energy?.today),
      month: asList(s.energy?.month),
      refs: [],
      breaker: breakerText(s.breaker),
      panel: s.panel || null,
    };
    for (const f of s.feeds || []) {
      const r = feedRef(f);
      if (r && !m.refs.includes(r)) m.refs.push(r);
    }
    for (const r of m.refs) byRef.set(r, [...(byRef.get(r) || []), m]);
    for (const e of [...m.power, ...m.today, ...m.month, ...(s.remainder ? [s.remainder] : [])]) ents.add(e);
    all.push(m);
    byId[m.id] = m;
    m.children = (s.children || []).map((c) => make(c, m, depth + 1));
    if (m.children.length && m.power.length) {
      const o: Meter = {
        ...m,
        id: `${m.id}.other`,
        label: 'Other',
        spec: { id: `${m.id}.other` },
        parent: m,
        children: [],
        other: null,
        isOther: true,
        depth: depth + 1,
        power: s.remainder ? [s.remainder] : [],
        today: [],
        month: [],
        refs: [],
        breaker: null,
      };
      m.other = o;
      all.push(o);
      byId[o.id] = o;
    }
    return m;
  };
  const roots = map.meters.map((s) => make(s, null, 0));
  return { roots, all, byId, byRef, entityIds: [...ents] };
}

// ------------------------------------------------------------------ reading the store

const POWER: Record<string, number> = { W: 1, kW: 1000, MW: 1e6, mW: 0.001 };
const ENERGY: Record<string, number> = { kWh: 1, Wh: 0.001, MWh: 1000 };

/** an entity's power in W, or null (missing, unavailable, not a number, an energy unit) */
export function watts(e: EntityState | undefined): number | null {
  return scaled(e, POWER, 'W');
}
/** an entity's energy in kWh, or null */
export function kwh(e: EntityState | undefined): number | null {
  return scaled(e, ENERGY, 'kWh');
}
function scaled(e: EntityState | undefined, table: Record<string, number>, dflt: string): number | null {
  if (!e || e.state === '' || e.state === 'unavailable' || e.state === 'unknown') return null;
  const v = Number(e.state);
  if (!Number.isFinite(v)) return null;
  const f = table[e.attributes?.unit_of_measurement || dflt];
  return f === undefined ? null : v * f;
}

/** a sum of readings: null if any is missing (an unavailable leg makes the circuit unknown, not half its load) */
export function sumAll(vs: (number | null)[]): number | null {
  if (!vs.length || vs.some((v) => v === null)) return null;
  return (vs as number[]).reduce((a, b) => a + b, 0);
}

export interface Reading {
  /** W; null = no data */
  w: number | null;
  /** a derived sum that is missing some children */
  partial: boolean;
  /** the reported remainder sensor gave it (an Other) */
  reported?: boolean;
}

/** Every meter's power for one moment: `get` reads the store. */
export function compute(tree: Tree, get: (id: string) => EntityState | undefined): Map<string, Reading> {
  const out = new Map<string, Reading>();
  const visit = (m: Meter): Reading => {
    const kids = m.children.map(visit);
    const loads = m.children.map((c, i) => (c.kind === m.kind ? kids[i] : null)).filter((r): r is Reading => !!r);
    let r: Reading;
    if (m.power.length) r = { w: sumAll(m.power.map((e) => watts(get(e)))), partial: false };
    else {
      const known = loads.filter((k) => k.w !== null);
      r = {
        w: known.length ? known.reduce((a, k) => a + k.w!, 0) : null,
        partial: known.length < loads.length || loads.some((k) => k.partial),
      };
    }
    out.set(m.id, r);
    if (m.other) {
      const rep = m.spec.remainder ? watts(get(m.spec.remainder)) : null;
      let w: number | null = rep;
      if (w === null && m.power.length) {
        const sum = sumAll(loads.map((k) => (k.partial ? null : k.w)));
        w = r.w === null || sum === null ? null : r.w - sum;
      }
      // a remainder a little below zero is the meters' disagreement, not a negative load
      out.set(m.other.id, { w: w === null ? null : Math.max(0, w), partial: false, reported: rep !== null });
    }
    return r;
  };
  for (const root of tree.roots) visit(root);
  return out;
}

// ------------------------------------------------------------------ what the panel shows

export interface Totals {
  /** the house's load: the load roots summed (null: none has data) */
  load: number | null;
  /** some load root has no data */
  partial: boolean;
  sources: { meter: Meter; w: number | null }[];
  storage: { meter: Meter; w: number | null }[];
}

export function totals(tree: Tree, rs: Map<string, Reading>): Totals {
  const loads = tree.roots.filter((m) => m.kind === 'load').map((m) => rs.get(m.id)!);
  const known = loads.filter((r) => r.w !== null);
  const pick = (k: MeterKind) =>
    tree.all
      .filter((m) => m.kind === k && (!m.parent || m.parent.kind !== k) && !m.isOther)
      .map((meter) => ({
        meter,
        w: rs.get(meter.id)?.w ?? null,
      }));
  return {
    load: known.length ? known.reduce((a, r) => a + r.w!, 0) : null,
    partial: known.length < loads.length || loads.some((r) => r.partial),
    sources: pick('source'),
    storage: pick('storage'),
  };
}

/** the loads that add up to the house's: every leaf and every Other (a parent is never listed with its children) */
export function consumers(tree: Tree): Meter[] {
  return tree.all.filter((m) => m.kind === 'load' && !m.children.length);
}

/** the feeds and panels: meters with children that aren't a circuit (no breaker), in tree order */
export function parents(tree: Tree): Meter[] {
  return tree.all.filter((m) => m.kind === 'load' && m.children.length > 0 && !m.breaker);
}

/** consumers by power, highest first; no-data last */
export function top(tree: Tree, rs: Map<string, Reading>, n = Infinity): Meter[] {
  return consumers(tree)
    .map((m) => [m, rs.get(m.id)?.w ?? null] as const)
    .sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1) || a[0].label.localeCompare(b[0].label))
    .slice(0, n)
    .map(([m]) => m);
}

/** is `a` an ancestor of `m`? */
export function isAncestor(a: Meter, m: Meter): boolean {
  for (let p = m.parent; p; p = p.parent) if (p === a) return true;
  return false;
}

/** The meters that count for something several of them feed: those with no ancestor among them (a circuit and the plug
 * on it both feed the kitchen: the kitchen gets the circuit's power, not both). */
export function countable(ms: Meter[], rs?: Map<string, Reading>): Meter[] {
  // with readings: an ancestor with no data doesn't hide a descendant that has some
  const has = (m: Meter) => !rs || (rs.get(m.id)?.w ?? null) !== null;
  return ms.filter((m) => !ms.some((a) => a !== m && has(a) && isAncestor(a, m)));
}

/** the power of several meters feeding one thing, without double counting; partial when one of them has no data
 * (null: none has data) */
export function sumOf(ms: Meter[], rs: Map<string, Reading>): Reading {
  const counted = countable(ms, rs);
  const rds = counted.map((m) => rs.get(m.id) ?? { w: null, partial: false });
  const known = rds.filter((r) => r.w !== null);
  return {
    w: known.length ? known.reduce((a, r) => a + r.w!, 0) : null,
    partial: known.length < rds.length || known.some((r) => r.partial),
  };
}

/** the power of everything bound to a reference, without double counting (null: no meter, or none has data) */
export function powerOf(tree: Tree, rs: Map<string, Reading>, ref: string): number | null {
  return sumOf(tree.byRef.get(ref) || [], rs).w;
}

/** a meter's share of its parent's power (0-1), or null */
export function share(m: Meter, rs: Map<string, Reading>): number | null {
  const w = rs.get(m.id)?.w,
    pw = m.parent && rs.get(m.parent.id)?.w;
  return w == null || !pw ? null : Math.min(1, w / pw);
}

/** "Panel A · 17+19 · 240 V" */
export function where(m: Meter): string {
  const parts: string[] = [];
  const panel = (m.panel !== m.label && m.panel) || (m.parent ? m.parent.label : null);
  if (m.isOther) return `unmetered on ${m.parent!.label}`;
  if (panel) parts.push(panel);
  if (m.breaker) parts.push(`breaker ${m.breaker}`);
  if (m.spec.volts) parts.push(`${m.spec.volts} V`);
  return parts.join(' · ');
}
