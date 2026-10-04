// A meter's past: its 24-hour series (W, BUCKETS buckets) for the sparkline, and today's kWh worked out from its power
// history when it has no energy entity. Pure apart from the `history` it is given (the store's, or the mock's), so the
// number of requests is unit-tested. A meter with power entities fetches each of them once (at most `concurrency`
// requests run at a time, the rest wait their turn); a meter without power sums its children's series, and each child's
// result is kept as the recursion goes, so opening the child afterwards costs nothing. Results are kept for `ttl`; a
// meter asked for again while its request runs shares it.
import type { HistoryPoint } from '../../plugin-api';
import { downsample, integrate, midnight, sumSeries, type Series } from './history';
import { sumAll, type Meter } from './tree';

export interface Past {
  /** when it was fetched (ms) */
  at: number;
  series: Series;
  /** kWh since midnight from the power history; null if the history doesn't reach back to midnight */
  today: number | null;
}

export interface PastDeps {
  /** an entity's history in W (scaled by the caller), oldest first */
  history(entityId: string, from: number, to: number): Promise<HistoryPoint[]>;
  now?: () => number;
  /** requests at once (default 4) */
  concurrency?: number;
  /** keep a result this long (ms, default 5 minutes) */
  ttl?: number;
  /** span (ms, default a day) and buckets (default 96) */
  span?: number;
  buckets?: number;
  /** a request failed (logged by the caller); the meter gets an empty past */
  onError?(m: Meter, e: Error): void;
}

export function createPast(deps: PastDeps) {
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.ttl ?? 5 * 60e3;
  const span = deps.span ?? 24 * 3600e3;
  const buckets = deps.buckets ?? 96;
  const limit = Math.max(1, deps.concurrency ?? 4);
  const done = new Map<string, Past>();
  const running = new Map<string, Promise<Past>>();
  let active = 0;
  const waiting: (() => void)[] = [];
  const stats = { requests: 0, maxActive: 0 };

  /** one history request, in turn */
  async function fetchOne(e: string, from: number, to: number): Promise<HistoryPoint[]> {
    if (active >= limit) await new Promise<void>((r) => waiting.push(r));
    active++;
    stats.requests++;
    stats.maxActive = Math.max(stats.maxActive, active);
    try {
      return await deps.history(e, from, to);
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  async function compute(m: Meter): Promise<Past> {
    const to = now(),
      from = to - span;
    if (m.power.length) {
      const pts = await Promise.all(m.power.map((e) => fetchOne(e, from, to)));
      const t0 = Math.max(from, midnight(to));
      // today only from a history that reaches back to midnight (not just what this page has seen)
      const covers = pts.every((p) => p.length > 0 && p[0].t <= t0 + 15 * 60e3);
      return {
        at: now(),
        series: sumSeries(pts.map((p) => downsample(p, from, to, buckets))),
        today: covers ? sumAll(pts.map((p) => integrate(p, t0, to))) : null,
      };
    }
    const kids = m.children.filter((c) => c.kind === m.kind);
    const all = await Promise.all(kids.map((c) => load(c)));
    // a child with no history at all is left out rather than blanking the whole day
    const known = all.map((a) => a.series).filter((x) => x.some((v) => v !== null));
    return {
      at: now(),
      series: known.length ? sumSeries(known) : [],
      today: all.length && all.every((a) => a.today !== null) ? all.reduce((s, a) => s + a.today!, 0) : null,
    };
  }

  /** a meter's past, fetched if it isn't fresh (an Other has none: it is empty) */
  function load(m: Meter): Promise<Past> {
    const p = done.get(m.id);
    if (p && now() - p.at <= ttl) return Promise.resolve(p);
    if (m.isOther) return Promise.resolve({ at: now(), series: [], today: null });
    const r = running.get(m.id);
    if (r) return r;
    const job = compute(m)
      .catch((e: Error) => {
        deps.onError?.(m, e);
        return { at: now(), series: [], today: null } as Past;
      })
      .then((x) => (done.set(m.id, x), x))
      .finally(() => running.delete(m.id));
    running.set(m.id, job);
    return job;
  }

  return {
    load,
    /** what is known now (stale or not), or null */
    get: (m: Meter): Past | null => done.get(m.id) ?? null,
    /** is it fresh or on its way? */
    settled: (m: Meter) => running.has(m.id) || (done.has(m.id) && now() - done.get(m.id)!.at <= ttl),
    stats,
  };
}

export type PastLoader = ReturnType<typeof createPast>;
