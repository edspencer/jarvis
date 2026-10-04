// Mock energy data for ?ha=mock: made-up but plausible loads for every meter in the map, varying over the day and
// cycling as fridges and heat pumps do, deterministic for a given meter id, seed and time (so a test can expect
// them, and the history this makes up for the sparklines matches the live values). Pure: the plugin hands the states
// to the store's mock connector. A leaf's profile comes from words in its label (fridge, dryer, AC…); a parent is
// its children's sum plus a little unmetered load (so Other shows); legs split a circuit's load; a reported remainder
// sensor reports the parent's Other; today's energy integrates the same curve from midnight.
import type { EntityState, HistoryPoint } from '../../plugin-api';
import { midnight } from './history';
import type { Meter, Tree } from './tree';

interface Profile {
  /** always-on W */
  base: number;
  /** W while running */
  run: number;
  /** fraction of the time it runs, at the busiest time of day */
  duty: number;
  /** cycle length, minutes */
  period: number;
  /** busiest hour of the day */
  peak: number;
  /** the hours it can run at all, [from, to) (wrapping past midnight when from > to); outside them only the base */
  hours?: [number, number];
  /** a second load that comes on now and then while it runs (an air handler's heat strips): its own cycle */
  extra?: { run: number; duty: number; period: number };
}

/** a heat pump's or an AC's compressor */
const COMPRESSOR: Profile = { base: 8, run: 3200, duty: 0.45, period: 25, peak: 16 };

// First match wins, so the more specific words come first (a "Dishwasher" is not a washer, a pond pump is not a pool
// pump). A label naming a compressor (heat pump, condenser, AC) gets the compressor even if it names an air handler
// too ("Heat pump and air handler"); one naming only an air handler gets its fan and heat strips ("HVAC air handler").
const PROFILES: [RegExp, Profile][] = [
  [/fridge|refrig|freezer/i, { base: 4, run: 140, duty: 0.4, period: 50, peak: 18 }],
  [/\b(a\/?c|heat ?pump|condens|mini.?split)/i, COMPRESSOR],
  [
    /air ?handler|\bahu\b|furnace|fan ?coil/i,
    { base: 6, run: 520, duty: 0.5, period: 25, peak: 16, extra: { run: 4800, duty: 0.12, period: 90 } },
  ],
  [/\bhvac/i, COMPRESSOR],
  [/dryer/i, { base: 1, run: 4800, duty: 0.3, period: 70, peak: 19, hours: [17, 23] }],
  [/dish/i, { base: 2, run: 1200, duty: 0.07, period: 90, peak: 21 }],
  [/washer|washing/i, { base: 2, run: 450, duty: 0.08, period: 50, peak: 18 }],
  [/oven|range|cooktop|stove/i, { base: 3, run: 3000, duty: 0.06, period: 40, peak: 18 }],
  [/micro/i, { base: 3, run: 1100, duty: 0.03, period: 6, peak: 12 }],
  [/water ?heater|hpwh|geyser|boiler/i, { base: 5, run: 4500, duty: 0.15, period: 45, peak: 7 }],
  [/\bev\b|charger|car/i, { base: 2, run: 7200, duty: 0.8, period: 120, peak: 1, hours: [23, 3] }],
  [/pond|fountain/i, { base: 0, run: 85, duty: 0.97, period: 120, peak: 13 }],
  [/pool|pump/i, { base: 0, run: 1100, duty: 0.35, period: 240, peak: 13 }],
  [/light|lamp/i, { base: 6, run: 160, duty: 0.9, period: 120, peak: 21, hours: [16, 24] }],
  [/office|desk|computer|tv|media|network|rack/i, { base: 60, run: 180, duty: 0.5, period: 60, peak: 14 }],
];
const DEFAULT: Profile = { base: 15, run: 120, duty: 0.3, period: 45, peak: 19 };

/** a stable 0-1 number for a string */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

export function profileOf(label: string): Profile {
  return PROFILES.find(([re]) => re.test(label))?.[1] ?? DEFAULT;
}

/** is the hour (0-24) in [from, to), wrapping past midnight */
const within = (hour: number, [from, to]: [number, number]) =>
  from <= to ? hour >= from && hour < to : hour >= from || hour < to;

/** a leaf's made-up W at time t (ms) */
export function leafWatts(m: Pick<Meter, 'id' | 'label'>, t: number, seed = 7): number {
  const p = profileOf(m.label);
  const h = hash01(`${m.id}:${seed}`);
  const hour = (((t / 3.6e6 + new Date(t).getTimezoneOffset() / -60) % 24) + 24) % 24;
  // busier near the peak hour (0.25 - 1), and not at all outside its hours
  const d = Math.min(Math.abs(hour - p.peak), 24 - Math.abs(hour - p.peak));
  const busy = p.hours && !within(hour, p.hours) ? 0 : 0.25 + 0.75 * Math.exp(-(d * d) / 18);
  const cycle = (minutes: number, salt: number) => {
    const period = minutes * 60e3 * (0.8 + 0.4 * h);
    return (((t / period + h + salt) % 1) + 1) % 1;
  };
  const running = cycle(p.period, 0) < p.duty * busy;
  const extra = running && p.extra && cycle(p.extra.period, 0.37) < p.extra.duty ? p.extra.run : 0;
  const wobble = 1 + 0.06 * Math.sin(t / 37e3 + h * 50);
  return Math.round((p.base * (0.8 + 0.4 * h) + (running ? p.run * (0.85 + 0.3 * h) + extra : 0)) * wobble * 10) / 10;
}

/** every meter's made-up W at time t (parents: their children's sum plus a little unmetered load) */
export function mockWatts(tree: Tree, t: number, seed = 7): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (m: Meter): number => {
    const kids = m.children.map(visit);
    let w: number;
    if (m.kind === 'source') {
      // daylight: a sine from 7 to 19
      const hour = (((t / 3.6e6 + new Date(t).getTimezoneOffset() / -60) % 24) + 24) % 24;
      w = Math.max(0, Math.sin(((hour - 7) / 12) * Math.PI)) * 5200 * (0.9 + 0.1 * Math.sin(t / 91e3));
    } else if (m.kind === 'storage')
      w = 800 * Math.sin(t / 3.6e6 / 3); // charging (+) and discharging (-)
    else if (!m.children.length) w = leafWatts(m, t, seed);
    else {
      const unmetered = m.other ? leafWatts({ id: `${m.id}.other`, label: 'other' }, t, seed) : 0;
      w = m.children.reduce((a, c, i) => a + (c.kind === m.kind ? kids[i] : 0), 0) + unmetered;
      if (m.other) out.set(m.other.id, unmetered);
    }
    out.set(m.id, Math.round(w * 10) / 10);
    return w;
  };
  for (const r of tree.roots) visit(r);
  return out;
}

const state = (
  entity_id: string,
  v: number,
  unit: string,
  device_class: string,
  name: string,
  iso: string,
): EntityState => ({
  entity_id,
  state: String(Math.round(v * 1000) / 1000),
  attributes: { unit_of_measurement: unit, device_class, friendly_name: name, state_class: 'measurement' },
  last_changed: iso,
  last_updated: iso,
});

/** the W a power entity of a meter shows (legs split the meter's load: 52 / 48) */
function entityWatts(m: Meter, e: string, w: number): number {
  const i = m.power.indexOf(e),
    n = m.power.length;
  if (n <= 1) return w;
  const share = n === 2 ? (i === 0 ? 0.52 : 0.48) : 1 / n;
  return w * share;
}

/** every meter's kWh since midnight, from the same curve (5-minute steps) */
function today(tree: Tree, t: number, seed: number): Map<string, number> {
  const acc = new Map<string, number>();
  for (let s = midnight(t); s < t; s += 300e3) {
    const dt = Math.min(300e3, t - s);
    for (const [id, w] of mockWatts(tree, s, seed)) acc.set(id, (acc.get(id) ?? 0) + (w * dt) / 3.6e9);
  }
  return acc;
}

/** The states of every entity the tree names, at time t: power, remainders, today's (and the month's) energy. */
export function mockStates(tree: Tree, t: number, seed = 7, withEnergy = true): EntityState[] {
  const w = mockWatts(tree, t, seed);
  const iso = new Date(t).toISOString();
  const out: EntityState[] = [];
  const kwh = withEnergy && tree.all.some((m) => m.today.length || m.month.length) ? today(tree, t, seed) : null;
  for (const m of tree.all) {
    if (m.isOther) continue;
    const mw = w.get(m.id) ?? 0;
    for (const e of m.power) out.push(state(e, entityWatts(m, e, mw), 'W', 'power', `${m.label} power`, iso));
    if (m.spec.remainder && m.other)
      out.push(state(m.spec.remainder, w.get(m.other.id) ?? 0, 'W', 'power', `${m.label} balance`, iso));
    if (kwh) {
      const day = kwh.get(m.id) ?? 0;
      for (const e of m.today) out.push(state(e, day / m.today.length, 'kWh', 'energy', `${m.label} today`, iso));
      // the month so far: today's plus the days before at a similar rate
      const dom = new Date(t).getDate();
      for (const e of m.month)
        out.push(
          state(
            e,
            (day + (dom - 1) * Math.max(day, 1) * 1.1) / m.month.length,
            'kWh',
            'energy',
            `${m.label} this month`,
            iso,
          ),
        );
    }
  }
  return out;
}

/** a made-up history for one entity the tree names (power or remainder), every `step` ms from `from` to `to` */
export function mockHistory(
  tree: Tree,
  entity: string,
  from: number,
  to: number,
  seed = 7,
  step = 300e3,
): HistoryPoint[] {
  const m = tree.all.find((x) => !x.isOther && (x.power.includes(entity) || x.spec.remainder === entity));
  if (!m) return [];
  const out: HistoryPoint[] = [];
  for (let t = from; t <= to; t += step) {
    const w = mockWatts(tree, t, seed);
    const v = m.spec.remainder === entity ? (w.get(m.other!.id) ?? 0) : entityWatts(m, entity, w.get(m.id) ?? 0);
    out.push({ t, state: String(v), v });
  }
  return out;
}
