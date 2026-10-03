// A device's health from Home Assistant entity states: the rules (pure; the data tool that writes the device map
// applies the same rules to a snapshot).
//   red    every main entity unavailable / unknown; a dead Z-Wave node; a device not seen for stale_h hours
//   amber  battery <= battery_pct % (or a low-battery sensor on); weak signal (lqi / rssi / Wi-Fi)
//   blue   a firmware update available
//   ok     nothing to report
// "Unavailable" is not a fault for a smart bulb behind an ordinary wall switch (unavailable_means): the switch is just
// off, unless a bulb on the same switch answers (unless_on), which proves the switch is on and this bulb has really
// dropped out. powered_by (a smart plug / dimmer feeding it) works the same way: off there = off here.
import type { Entities } from '../home-assistant/types';

export type Severity = 'ok' | 'blue' | 'amber' | 'red';
export const SEV: Record<Severity, number> = { ok: 0, blue: 1, amber: 2, red: 3 };

export interface Thresholds {
  battery_pct: number;
  lqi_weak: number;
  rssi_weak_dbm: number;
  wifi_weak_pct: number;
  /** integration -> hours of silence before a device counts as stale */
  stale_h: Record<string, number>;
}

export interface DeviceHealthEntities {
  avail: string[];
  node_status?: string[];
  /** timestamp sensors: their state is the last-seen time */
  last_seen?: string[];
  /** sensors whose last_updated stands in for last seen */
  seen?: string[];
  battery?: string[];
  battery_low?: string[];
  signal?: { entity: string; kind: 'lqi' | 'rssi' | 'wifi' | string }[];
  update?: string[];
}

export interface DevicePlace {
  src: 'registry' | 'plate' | 'fixture' | 'area' | string;
  /** a registry id, a plate id, or fixture ids */
  ref?: string | string[];
  room?: string;
  /** three.js metres */
  pos?: [number, number, number];
  centre?: [number, number, number] | null;
  plan?: number[];
  approx?: boolean;
  conf?: string;
  why?: string;
}

export interface Reason {
  sev: Severity;
  text: string;
  entities: string[];
  since: number | null;
}

/** a device as the device map describes it */
export interface DeviceSpec {
  id: string;
  name: string;
  make?: string | null;
  model?: string | null;
  integration?: string;
  area?: string | null;
  place?: DevicePlace | null;
  fixtures?: string[];
  groups?: string[];
  unavailable_means?: { off: string; unless_on?: string[] } | null;
  powered_by?: string | null;
  health: DeviceHealthEntities;
}

export interface HealthResult {
  sev: Severity;
  why: Reason[];
  /** why an unavailable device counts as off (no fault), or null */
  off: string | null;
  /** any of its entities has a state */
  known: boolean;
}

const BAD = new Set(['unavailable', 'unknown']);
const iso = (s: string | undefined | null): number | null => {
  const t = Date.parse(s as string);
  return Number.isFinite(t) ? t : null;
};

export const hours = (ms: number): string =>
  ms < 7200e3
    ? `${Math.round(ms / 60e3)} min`
    : ms < 172800e3
      ? `${Math.round(ms / 3600e3)} h`
      : `${Math.round(ms / 86400e3)} d`;

/** every entity a device's health reads */
export const healthEntities = (d: DeviceSpec): string[] => {
  const h = d.health;
  return [
    ...h.avail,
    ...(h.node_status || []),
    ...(h.last_seen || []),
    ...(h.seen || []),
    ...(h.battery || []),
    ...(h.battery_low || []),
    ...(h.signal || []).map((s) => s.entity),
    ...(h.update || []),
    ...(d.unavailable_means?.unless_on || []),
    ...(d.powered_by ? [d.powered_by] : []),
  ];
};

export function health(d: DeviceSpec, ents: Entities, now: number, th: Thresholds): HealthResult {
  const st = (e: string) => ents[e];
  const h = d.health,
    out: Reason[] = [];
  let off: string | null = null;
  const av = h.avail.filter((e) => st(e));
  if (av.length && av.every((e) => BAD.has(st(e).state))) {
    const um = d.unavailable_means;
    const mate = (um?.unless_on || []).find((e) => st(e) && !BAD.has(st(e).state));
    const pw = d.powered_by ? st(d.powered_by)?.state : null;
    const since = Math.min(...av.map((e) => iso(st(e).last_changed) ?? now));
    if (um && !mate && pw !== 'on')
      off = pw === 'off' ? `off: ${d.powered_by} is off` : 'off at its wall switch (no bulb on that switch answers)';
    else {
      out.push({
        sev: 'red',
        text: mate
          ? `unavailable, while ${mate} on the same switch answers`
          : pw === 'on'
            ? `unavailable, though ${d.powered_by} is on`
            : `${st(av[0]).state}`,
        entities: av,
        since,
      });
    }
  }
  for (const e of h.node_status || [])
    if (st(e)?.state === 'dead')
      out.push({ sev: 'red', text: 'Z-Wave node dead', entities: [e], since: iso(st(e).last_changed) });
  const lim = d.integration ? th.stale_h?.[d.integration] : undefined;
  if (lim) {
    const seen = [
      ...(h.last_seen || []).map((e) => iso(st(e)?.state)),
      ...(h.seen || []).map((e) => iso(st(e)?.last_updated)),
    ].filter((t): t is number => t != null);
    if (seen.length) {
      const last = Math.max(...seen);
      if (now - last > lim * 3600e3)
        out.push({
          sev: 'red',
          text: `not seen for ${hours(now - last)} (stale over ${lim} h)`,
          entities: [...(h.last_seen || []), ...(h.seen || [])],
          since: last,
        });
    }
  }
  for (const e of h.battery || []) {
    const v = parseFloat(st(e)?.state);
    if (Number.isFinite(v) && v <= th.battery_pct)
      out.push({ sev: 'amber', text: `battery ${Math.round(v)} %`, entities: [e], since: iso(st(e).last_changed) });
  }
  for (const e of h.battery_low || [])
    if (st(e)?.state === 'on')
      out.push({ sev: 'amber', text: 'battery low', entities: [e], since: iso(st(e).last_changed) });
  for (const s of h.signal || []) {
    const v = parseFloat(st(s.entity)?.state);
    if (!Number.isFinite(v)) continue;
    const weak =
      s.kind === 'lqi' ? v < th.lqi_weak : s.kind === 'wifi' ? v >= 0 && v < th.wifi_weak_pct : v < th.rssi_weak_dbm;
    if (weak)
      out.push({
        sev: 'amber',
        text: `weak signal (${s.kind} ${Math.round(v)})`,
        entities: [s.entity],
        since: iso(st(s.entity).last_changed),
      });
  }
  for (const e of h.update || []) {
    const s = st(e);
    if (s?.state === 'on')
      out.push({
        sev: 'blue',
        text: `update ${s.attributes?.installed_version || ''} → ${s.attributes?.latest_version || 'newer'}`.replace(
          '  ',
          ' ',
        ),
        entities: [e],
        since: iso(s.last_changed),
      });
  }
  const sev = out.reduce<Severity>((m, r) => (SEV[r.sev] > SEV[m] ? r.sev : m), 'ok');
  return { sev, why: out, off, known: av.length > 0 || out.length > 0 };
}
