// The load tint's colour scale and the plugin's number formats, pure (unit-tested). Loads span four orders of
// magnitude (a 3 W phone charger, a 4 kW dryer), so the scale is logarithmic: grey for no data, blue at or below idle,
// then pale amber → amber → orange → red from just above idle to `max` and beyond.

export interface ScaleOpts {
  /** W at or below which it's idle (default 5) */
  idle?: number;
  /** W that gets the full red (default 5000) */
  max?: number;
}

export const NO_DATA = '#7a8494';
export const IDLE = '#4f86c6';
/** t (0-1 on the log scale) -> colour; the first stop is just above idle */
const STOPS: [number, string][] = [
  [0, '#ffe7a3'],
  [0.4, '#ffc23d'],
  [0.7, '#ff7f2a'],
  [1, '#e8322a'],
];

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0');

/** where W sits on the scale: null (no data), -1 (idle), else 0-1 */
export function position(w: number | null, o: ScaleOpts = {}): number | null {
  const idle = o.idle ?? 5,
    max = o.max ?? 5000;
  if (w === null || !Number.isFinite(w)) return null;
  if (w <= idle) return -1;
  return Math.min(1, Math.log(w / idle) / Math.log(max / idle));
}

/** '#rrggbb' for a load in W */
export function loadColour(w: number | null, o: ScaleOpts = {}): string {
  let t = position(w, o);
  if (t === null) return NO_DATA;
  if (t < 0) return IDLE;
  t = Math.round(t * 48) / 48; // 49 colours: the scene keeps one material per colour
  let i = 1;
  while (i < STOPS.length - 1 && t > STOPS[i][0]) i++;
  const [t0, c0] = STOPS[i - 1],
    [t1, c1] = STOPS[i];
  const k = (t - t0) / (t1 - t0);
  const a = rgb(c0),
    b = rgb(c1);
  return `#${a.map((x, j) => hex2(x + (b[j] - x) * k)).join('')}`;
}

/** the legend's steps: no data, idle, then four loads spread over the log scale */
export function legendSteps(o: ScaleOpts = {}): { label: string; colour: string }[] {
  const idle = o.idle ?? 5,
    max = o.max ?? 5000;
  const at = (t: number) => idle * (max / idle) ** t;
  return [
    { label: 'no data', colour: NO_DATA },
    { label: `idle ≤ ${fmtW(idle)}`, colour: IDLE },
    ...[0.15, 0.45, 0.75, 1].map((t) => ({
      label: `${t === 1 ? '≥ ' : ''}${fmtW(nice(at(t)))}`,
      colour: loadColour(nice(at(t)), o),
    })),
  ];
}

/** 1, 2 or 5 × a power of ten, the nearest */
export function nice(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/** '840 W', '1.2 kW', '12 kW', '—' */
export function fmtW(w: number | null | undefined): string {
  if (w === null || w === undefined || !Number.isFinite(w)) return '—';
  const a = Math.abs(w);
  if (a < 1000) return `${Math.round(w).toLocaleString('en-US')} W`;
  return `${(w / 1000).toFixed(a < 10000 ? 1 : 0)} kW`;
}

/** '3.42 kWh', '0.18 kWh', '120 kWh' */
export function fmtKWh(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return `${v.toFixed(a < 10 ? 2 : a < 100 ? 1 : 0)} kWh`;
}

/** '42 %' */
export const pct = (v: number | null | undefined): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.round(v * 100)} %`;
