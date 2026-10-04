// History → sparkline, pure (unit-tested). A sensor's history is a step function: each state holds until the next
// one. downsample() turns it into a fixed number of buckets, each the time-weighted mean of what held during it (a
// spike shorter than a bucket still shows, scaled by how long it lasted), so a day of 1-minute readings becomes 96
// points. Buckets with nothing known are null; sumSeries() adds the legs of a circuit; integrate() gives kWh.
import type { HistoryPoint } from '../../plugin-api';

/** a point's value in W (or whatever unit the caller scales to); null = no data */
export type Series = (number | null)[];

/**
 * Time-weighted means of a step function over `n` equal buckets between `from` and `to` (ms). `points` are oldest
 * first; the value before the first point is unknown, and the last one holds until `to` (or `now`, if earlier: the
 * future is unknown). A point with v = null ('unavailable') is a gap.
 */
export function downsample(points: HistoryPoint[], from: number, to: number, n: number, now = to): Series {
  const out: Series = new Array(n).fill(null);
  if (n <= 0 || to <= from) return out;
  const span = (to - from) / n;
  const sum = new Array<number>(n).fill(0),
    dur = new Array<number>(n).fill(0);
  const end = Math.min(to, now);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.v === null) continue;
    const a = Math.max(from, p.t),
      b = Math.min(end, i + 1 < points.length ? points[i + 1].t : end);
    if (b <= a) continue;
    // spread [a, b) over the buckets it covers
    let k = Math.floor((a - from) / span);
    let t = a;
    while (t < b && k < n) {
      const edge = Math.min(b, from + (k + 1) * span);
      sum[k] += p.v * (edge - t);
      dur[k] += edge - t;
      t = edge;
      k++;
    }
  }
  for (let k = 0; k < n; k++) if (dur[k] > 0) out[k] = sum[k] / dur[k];
  return out;
}

/** add series bucket by bucket (a circuit's legs); a bucket missing in any is null */
export function sumSeries(list: Series[]): Series {
  if (!list.length) return [];
  return list[0].map((_, k) => {
    let s = 0;
    for (const l of list) {
      const v = l[k];
      if (v === null || v === undefined) return null;
      s += v;
    }
    return s;
  });
}

/** a sparkline's numbers: leading and inner gaps carried from the last known value (the first known one at the start);
 * [] if nothing is known */
export function sparkline(s: Series): number[] {
  const first = s.find((v) => v !== null);
  if (first === undefined || first === null) return [];
  let last = first;
  const out: number[] = [];
  for (const v of s) out.push((last = v ?? last));
  // trailing unknown buckets (the future): drop them rather than draw a flat line
  let end = s.length;
  while (end > 0 && s[end - 1] === null) end--;
  return out.slice(0, end);
}

/** kWh of a power history (W) between two times: the step function's integral; null if nothing is known */
export function integrate(points: HistoryPoint[], from: number, to: number): number | null {
  let wh = 0,
    known = false;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.v === null) continue;
    const a = Math.max(from, p.t),
      b = Math.min(to, i + 1 < points.length ? points[i + 1].t : to);
    if (b <= a) continue;
    wh += (p.v * (b - a)) / 3.6e6;
    known = true;
  }
  return known ? wh / 1000 : null;
}

/** local midnight before `t` */
export function midnight(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
