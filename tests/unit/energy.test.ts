import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EntityState, HistoryPoint } from '../../src/plugin-api';
import { reservedKeys, validateManifest, type SiteManifest } from '../../src/site';
import { checkSite } from '../../src/site/check-site';
import { breakerText, checkEnergyMap, feedRef, feedTarget, type MeterSpec } from '../../src/plugins/energy/map';
import {
  buildTree,
  compute,
  consumers,
  countable,
  kwh,
  powerOf,
  share,
  top,
  totals,
  watts,
  where,
} from '../../src/plugins/energy/tree';
import { fmtKWh, fmtW, IDLE, legendSteps, loadColour, NO_DATA, pct, position } from '../../src/plugins/energy/scale';
import { downsample, integrate, midnight, sparkline, sumSeries } from '../../src/plugins/energy/history';
import { mockHistory, mockStates, mockWatts } from '../../src/plugins/energy/mock';

const DEMO = JSON.parse(readFileSync(new URL('../../examples/demo-site/energy.json', import.meta.url), 'utf8'));
const COTTAGE = (): SiteManifest =>
  JSON.parse(readFileSync(new URL('../fixtures/site/site.json', import.meta.url), 'utf8'));

/** a store getter from { entity: state } or { entity: [state, unit] } */
function store(states: Record<string, string | [string, string]>) {
  return (id: string): EntityState | undefined => {
    const s = states[id];
    if (s === undefined) return undefined;
    const [state, unit] = Array.isArray(s) ? s : [s, undefined];
    return { entity_id: id, state, attributes: unit ? { unit_of_measurement: unit } : {} };
  };
}
const run = (meters: MeterSpec[], states: Record<string, string | [string, string]>) => {
  const tree = buildTree({ meters });
  return { tree, rs: compute(tree, store(states)) };
};

// ------------------------------------------------------------------ tree.ts
describe('energy tree: a meter from its entities', () => {
  it("a leaf's power is its one entity", () => {
    const { rs } = run([{ id: 'a', power: 'sensor.a' }], { 'sensor.a': '120' });
    expect(rs.get('a')).toEqual({ w: 120, partial: false });
  });

  it('two legs are summed, kW converted', () => {
    const { rs } = run([{ id: 'r', power: ['sensor.l1', 'sensor.l2'] }], {
      'sensor.l1': ['1.5', 'kW'],
      'sensor.l2': ['500', 'W'],
    });
    expect(rs.get('r')!.w).toBe(2000);
  });

  it('energy reads Wh and kWh as kWh; a power reader refuses an energy unit and vice versa', () => {
    const e = (state: string, unit?: string): EntityState => ({
      entity_id: 'sensor.x',
      state,
      attributes: unit ? { unit_of_measurement: unit } : {},
    });
    expect(kwh(e('500', 'Wh'))).toBe(0.5);
    expect(kwh(e('3.2', 'kWh'))).toBe(3.2);
    expect(kwh(e('3.2'))).toBe(3.2);
    expect(watts(e('3.2', 'kWh'))).toBeNull();
    expect(kwh(e('100', 'W'))).toBeNull();
    expect(watts(e('unavailable', 'W'))).toBeNull();
    expect(watts(e('unknown', 'W'))).toBeNull();
    expect(watts(e('on'))).toBeNull();
    expect(watts(undefined)).toBeNull();
  });

  it('an unavailable leg makes the circuit unknown, not half', () => {
    const { rs } = run([{ id: 'r', power: ['sensor.l1', 'sensor.l2'] }], {
      'sensor.l1': '800',
      'sensor.l2': 'unavailable',
    });
    expect(rs.get('r')!.w).toBeNull();
    const missing = run([{ id: 'r', power: ['sensor.l1', 'sensor.l2'] }], { 'sensor.l1': '800' });
    expect(missing.rs.get('r')!.w).toBeNull();
  });
});

describe('energy tree: parents, children and Other', () => {
  const panel = (extra: Partial<MeterSpec> = {}): MeterSpec[] => [
    {
      id: 'p',
      power: 'sensor.p',
      children: [
        { id: 'a', power: 'sensor.a' },
        { id: 'b', power: 'sensor.b' },
      ],
      ...extra,
    },
  ];

  it('Other = parent − Σ children', () => {
    const { tree, rs } = run(panel(), { 'sensor.p': '1000', 'sensor.a': '300', 'sensor.b': '200' });
    expect(tree.byId['p'].other!.id).toBe('p.other');
    expect(tree.byId['p.other'].isOther).toBe(true);
    expect(rs.get('p.other')).toEqual({ w: 500, partial: false, reported: false });
  });

  it('Other is clamped at 0 when the children read more than the parent', () => {
    const { rs } = run(panel(), { 'sensor.p': '1000', 'sensor.a': '700', 'sensor.b': '400' });
    expect(rs.get('p.other')!.w).toBe(0);
  });

  it('Other is unknown when a child is', () => {
    const { rs } = run(panel(), { 'sensor.p': '1000', 'sensor.a': '700' });
    expect(rs.get('p.other')!.w).toBeNull();
    expect(rs.get('p')!.w).toBe(1000);
  });

  it('a reported remainder wins over the computed one; when it is unavailable, the computed one is used', () => {
    const m = panel({ remainder: 'sensor.bal' });
    const a = run(m, { 'sensor.p': '1000', 'sensor.a': '300', 'sensor.b': '200', 'sensor.bal': '123' });
    expect(a.rs.get('p.other')).toEqual({ w: 123, partial: false, reported: true });
    const b = run(m, { 'sensor.p': '1000', 'sensor.a': '300', 'sensor.b': '200', 'sensor.bal': 'unavailable' });
    expect(b.rs.get('p.other')).toEqual({ w: 500, partial: false, reported: false });
    expect(a.tree.entityIds).toContain('sensor.bal');
  });

  it('a parent without power is its children summed (no Other); partial when a child has no data', () => {
    const meters: MeterSpec[] = [
      {
        id: 'p',
        children: [
          { id: 'a', power: 'sensor.a' },
          { id: 'b', power: 'sensor.b' },
        ],
      },
    ];
    const full = run(meters, { 'sensor.a': '300', 'sensor.b': '200' });
    expect(full.rs.get('p')).toEqual({ w: 500, partial: false });
    expect(full.tree.byId['p'].other).toBeNull();
    expect(full.tree.byId['p.other']).toBeUndefined();
    const part = run(meters, { 'sensor.a': '300' });
    expect(part.rs.get('p')).toEqual({ w: 300, partial: true });
    const none = run(meters, {});
    expect(none.rs.get('p')).toEqual({ w: null, partial: true });
  });

  it('a partial child makes its derived parent partial', () => {
    const { rs } = run(
      [
        {
          id: 'top',
          children: [
            {
              id: 'mid',
              children: [
                { id: 'a', power: 'sensor.a' },
                { id: 'b', power: 'sensor.b' },
              ],
            },
          ],
        },
      ],
      { 'sensor.a': '10' },
    );
    expect(rs.get('top')).toEqual({ w: 10, partial: true });
  });

  it('a source or storage child under a load is not subtracted (nor summed)', () => {
    const kids: MeterSpec[] = [
      { id: 'a', power: 'sensor.a' },
      { id: 'pv', kind: 'source', power: 'sensor.pv' },
      { id: 'bat', kind: 'storage', power: 'sensor.bat' },
    ];
    const states = { 'sensor.p': '1000', 'sensor.a': '300', 'sensor.pv': '400', 'sensor.bat': '-250' };
    const withPower = run([{ id: 'p', power: 'sensor.p', children: kids }], states);
    expect(withPower.rs.get('p.other')!.w).toBe(700);
    const derived = run([{ id: 'p', children: kids }], states);
    expect(derived.rs.get('p')).toEqual({ w: 300, partial: false });
  });

  it('a child inherits its parent kind unless it says otherwise', () => {
    const { tree } = run([{ id: 'pv', kind: 'source', children: [{ id: 'string1', power: 'sensor.s1' }] }], {});
    expect(tree.byId['string1'].kind).toBe('source');
  });
});

describe('energy tree: totals, consumers, rooms', () => {
  // main (2000) → circuit A (800) → plug P (300); circuit B (500); a PV source and a battery as roots
  const meters: MeterSpec[] = [
    {
      id: 'main',
      label: 'Main',
      power: 'sensor.main',
      children: [
        {
          id: 'A',
          label: 'Circuit A',
          power: 'sensor.a',
          breaker: [17, 19],
          volts: 240,
          feeds: [{ room: 'kitchen' }],
          children: [
            { id: 'P', label: 'Plug', power: 'sensor.p', feeds: [{ room: 'kitchen' }, { node: 'Furn_desk' }] },
          ],
        },
        { id: 'B', label: 'Circuit B', power: 'sensor.b', panel: 'Panel B', breaker: 3, feeds: [{ room: 'hall' }] },
      ],
    },
    { id: 'pv', label: 'Solar', kind: 'source', power: 'sensor.pv' },
    { id: 'bat', label: 'Battery', kind: 'storage', power: 'sensor.bat' },
  ];
  const states = {
    'sensor.main': '2000',
    'sensor.a': '800',
    'sensor.p': '300',
    'sensor.b': '500',
    'sensor.pv': '3000',
    'sensor.bat': '-400',
  };

  it("the house's load is the load roots only; sources and storage apart", () => {
    const { tree, rs } = run(meters, states);
    const t = totals(tree, rs);
    expect(t.load).toBe(2000);
    expect(t.partial).toBe(false);
    expect(t.sources.map((s) => [s.meter.id, s.w])).toEqual([['pv', 3000]]);
    expect(t.storage.map((s) => [s.meter.id, s.w])).toEqual([['bat', -400]]);
  });

  it('totals are partial when a load root has no data', () => {
    const { tree, rs } = run([...meters, { id: 'garage', power: 'sensor.garage' }], states);
    const t = totals(tree, rs);
    expect(t.load).toBe(2000);
    expect(t.partial).toBe(true);
  });

  it('the consumers (leaves and Others) add up to the load exactly, nothing counted twice', () => {
    const { tree, rs } = run(meters, states);
    const cs = consumers(tree);
    expect(cs.map((m) => m.id).sort()).toEqual(['A.other', 'B', 'P', 'main.other']);
    const sum = cs.reduce((a, m) => a + rs.get(m.id)!.w!, 0);
    expect(sum).toBe(totals(tree, rs).load);
    // highest first; a tie (A's Other and B, 500 W each) goes by label ('Circuit B' < 'Other')
    expect(top(tree, rs).map((m) => m.id)).toEqual(['main.other', 'B', 'A.other', 'P']);
    expect(top(tree, rs, 2).map((m) => m.id)).toEqual(['main.other', 'B']);
  });

  it('top() puts no-data last', () => {
    const { tree, rs } = run(meters, { ...states, 'sensor.b': 'unavailable' });
    const ids = top(tree, rs).map((m) => m.id);
    // with B unknown, main's Other is too: both go last (by label)
    expect(rs.get('main.other')!.w).toBeNull();
    expect(ids).toEqual(['A.other', 'P', 'B', 'main.other']);
  });

  it('a room fed by a circuit and by the plug under it gets the circuit only', () => {
    const { tree, rs } = run(meters, states);
    const ms = tree.byRef.get('room:kitchen')!;
    expect(ms.map((m) => m.id)).toEqual(['A', 'P']);
    expect(countable(ms).map((m) => m.id)).toEqual(['A']);
    expect(powerOf(tree, rs, 'room:kitchen')).toBe(800);
    expect(powerOf(tree, rs, 'node:Furn_desk')).toBe(300);
    expect(powerOf(tree, rs, 'room:hall')).toBe(500);
    expect(powerOf(tree, rs, 'room:nowhere')).toBeNull();
  });

  it('share() of the parent', () => {
    const { tree, rs } = run(meters, states);
    expect(share(tree.byId['P'], rs)).toBeCloseTo(300 / 800);
    expect(share(tree.byId['A'], rs)).toBeCloseTo(0.4);
    expect(share(tree.byId['main'], rs)).toBeNull();
    const zero = run(meters, { ...states, 'sensor.a': '0' });
    expect(share(zero.tree.byId['P'], zero.rs)).toBeNull();
  });

  it('where(): panel, breaker, voltage; the parent stands in for a panel; Others are unmetered', () => {
    const { tree } = run(meters, states);
    expect(where(tree.byId['A'])).toBe('Main · breaker 17+19 · 240 V');
    expect(where(tree.byId['B'])).toBe('Panel B · breaker 3');
    expect(where(tree.byId['P'])).toBe('Circuit A');
    expect(where(tree.byId['main'])).toBe('');
    expect(where(tree.byId['A.other'])).toBe('unmetered on Circuit A');
  });
});

// ------------------------------------------------------------------ scale.ts
describe('energy scale', () => {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  it('no data, idle', () => {
    expect(loadColour(null)).toBe(NO_DATA);
    expect(loadColour(NaN)).toBe(NO_DATA);
    expect(loadColour(0)).toBe(IDLE);
    expect(loadColour(5)).toBe(IDLE);
    expect(loadColour(5.01)).not.toBe(IDLE);
  });

  it('warms monotonically on the log scale (green falls, blue never rises) and clamps above max', () => {
    let prev = rgb(loadColour(10));
    for (let w = 12; w <= 5000; w *= 1.2) {
      const c = rgb(loadColour(w));
      expect(c[1]).toBeLessThan(prev[1]);
      expect(c[2]).toBeLessThanOrEqual(prev[2]);
      prev = c;
    }
    expect(loadColour(5000)).toBe('#e8322a');
    expect(loadColour(1e6)).toBe('#e8322a');
    expect(loadColour(5.0000001)).toBe('#ffe7a3');
  });

  it('custom idle and max', () => {
    expect(loadColour(50, { idle: 100 })).toBe(IDLE);
    expect(loadColour(1000, { idle: 10, max: 1000 })).toBe('#e8322a');
    expect(position(1000, { idle: 10, max: 1000 })).toBe(1);
  });

  it('position() is logarithmic', () => {
    expect(position(null)).toBeNull();
    expect(position(3)).toBe(-1);
    expect(position(Math.sqrt(5 * 5000))).toBeCloseTo(0.5);
    expect(position(50, { idle: 10, max: 250 })).toBeCloseTo(0.5);
    expect(position(1e9)).toBe(1);
  });

  it('legend steps', () => {
    const s = legendSteps();
    expect(s.map((x) => x.label)).toEqual(['no data', 'idle ≤ 5 W', '10 W', '100 W', '1.0 kW', '≥ 5.0 kW']);
    expect(s[0].colour).toBe(NO_DATA);
    expect(s[1].colour).toBe(IDLE);
    expect(s.at(-1)!.colour).toBe('#e8322a');
    expect(legendSteps({ idle: 1, max: 100 })[1].label).toBe('idle ≤ 1 W');
  });

  it('formats', () => {
    expect(fmtW(840)).toBe('840 W');
    expect(fmtW(0)).toBe('0 W');
    expect(fmtW(1234)).toBe('1.2 kW');
    expect(fmtW(12345)).toBe('12 kW');
    expect(fmtW(-500)).toBe('-500 W');
    expect(fmtW(null)).toBe('—');
    expect(fmtW(undefined)).toBe('—');
    expect(fmtW(NaN)).toBe('—');
    expect(fmtKWh(3.421)).toBe('3.42 kWh');
    expect(fmtKWh(0.18)).toBe('0.18 kWh');
    expect(fmtKWh(12.34)).toBe('12.3 kWh');
    expect(fmtKWh(120.4)).toBe('120 kWh');
    expect(fmtKWh(null)).toBe('—');
    expect(pct(0.423)).toBe('42 %');
    expect(pct(1)).toBe('100 %');
    expect(pct(null)).toBe('—');
    expect(pct(undefined)).toBe('—');
  });
});

// ------------------------------------------------------------------ history.ts
describe('energy history', () => {
  const pts = (...xs: [number, number | null][]): HistoryPoint[] =>
    xs.map(([t, v]) => ({ t, v, state: v === null ? 'unavailable' : String(v) }));

  it('downsample: a step function holds until the next point', () => {
    expect(downsample(pts([0, 100], [50, 200]), 0, 100, 4)).toEqual([100, 100, 200, 200]);
  });

  it('downsample: time-weighted means inside a bucket', () => {
    expect(downsample(pts([0, 0], [10, 100]), 0, 40, 2)).toEqual([50, 100]);
  });

  it('downsample: a spike shorter than a bucket is averaged in', () => {
    expect(downsample(pts([0, 0], [5, 1000], [6, 0]), 0, 10, 1)).toEqual([100]);
  });

  it('downsample: nothing before the first point, gaps for null states, nothing after now', () => {
    expect(downsample(pts([50, 10]), 0, 100, 4)).toEqual([null, null, 10, 10]);
    expect(downsample(pts([0, 5], [25, null], [50, 7]), 0, 100, 4)).toEqual([5, null, 7, 7]);
    expect(downsample(pts([0, 5], [25, null], [50, 7]), 0, 100, 4, 60)).toEqual([5, null, 7, null]);
    expect(downsample(pts([-50, 3]), 0, 100, 2)).toEqual([3, 3]);
  });

  it('downsample: degenerate ranges', () => {
    expect(downsample(pts([0, 1]), 0, 100, 0)).toEqual([]);
    expect(downsample(pts([0, 1]), 100, 100, 3)).toEqual([null, null, null]);
    expect(downsample([], 0, 100, 2)).toEqual([null, null]);
  });

  it('sumSeries: a bucket missing in any series is null', () => {
    expect(
      sumSeries([
        [1, 2, null],
        [3, null, 4],
      ]),
    ).toEqual([4, null, null]);
    expect(sumSeries([[1, 2]])).toEqual([1, 2]);
    expect(sumSeries([])).toEqual([]);
  });

  it('sparkline: carries gaps, drops the trailing unknowns, [] when nothing is known', () => {
    expect(sparkline([null, 5, null, 7, null, null])).toEqual([5, 5, 5, 7]);
    expect(sparkline([1, 2, 3])).toEqual([1, 2, 3]);
    expect(sparkline([null, null])).toEqual([]);
    expect(sparkline([])).toEqual([]);
  });

  it('integrate: kWh of a step function, clipped to [from, to]', () => {
    const H = 3.6e6;
    expect(integrate(pts([0, 1000]), 0, 2 * H)).toBeCloseTo(2);
    expect(integrate(pts([0, 1000], [3 * H, 0]), H, 2 * H)).toBeCloseTo(1);
    expect(integrate(pts([H, 1000]), 0, 2 * H)).toBeCloseTo(1); // nothing before the first point
    expect(integrate(pts([0, 1000], [H, null], [1.5 * H, 2000]), 0, 2 * H)).toBeCloseTo(2);
    expect(integrate(pts([0, null]), 0, H)).toBeNull();
    expect(integrate([], 0, H)).toBeNull();
  });

  it('midnight', () => {
    const t = new Date(2026, 9, 3, 15, 30, 12).getTime();
    expect(midnight(t)).toBe(new Date(2026, 9, 3).getTime());
    expect(midnight(midnight(t))).toBe(midnight(t));
  });
});

// ------------------------------------------------------------------ map.ts
describe('energy map check', () => {
  const ok = (meters: unknown[], extra: Record<string, unknown> = {}) =>
    checkEnergyMap({ jarvis: 'jarvis-energy/1', meters, ...extra });

  it("the demo site's map passes", () => {
    const r = checkEnergyMap(DEMO);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('the format version', () => {
    const r = checkEnergyMap({ jarvis: 'jarvis-energy/2', meters: [{ id: 'a', power: 'sensor.a' }] });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([{ path: 'jarvis', message: 'must be "jarvis-energy/1", got "jarvis-energy/2"' }]);
    expect(checkEnergyMap({ meters: [] }).errors.map((e) => e.path)).toContain('jarvis');
  });

  it('duplicate ids, nested', () => {
    const r = ok([{ id: 'a', power: 'sensor.a', children: [{ id: 'a', power: 'sensor.b' }] }]);
    expect(r.errors).toEqual([{ path: 'meters[0].children[0].id', message: '"a" is already meters[0]' }]);
  });

  it('a feed names exactly one target', () => {
    const r = ok([{ id: 'a', power: 'sensor.a', feeds: [{ registry: 'x', plate: 'y' }, { conf: 'high' }] }]);
    expect(r.errors.map((e) => e.path)).toEqual(['meters[0].feeds[0]', 'meters[0].feeds[1]']);
    expect(r.errors[0].message).toBe('name exactly one of registry, plate, fixture, node, room');
  });

  it('legs match the power entities', () => {
    const r = ok([{ id: 'a', power: 'sensor.a', legs: ['L1', 'L2'] }]);
    expect(r.errors).toEqual([{ path: 'meters[0].legs', message: '2 labels for 1 power entity' }]);
    const r2 = ok([{ id: 'a', power: ['sensor.a', 'sensor.b', 'sensor.c'], legs: ['L1'] }]);
    expect(r2.errors[0].message).toBe('1 labels for 3 power entities');
  });

  it('a meter needs power or children', () => {
    const r = ok([{ id: 'a', label: 'A' }]);
    expect(r.errors).toEqual([
      { path: 'meters[0]', message: 'a meter needs a power entity or children (its power is their sum)' },
    ]);
  });

  it('unknown fields, with a hint', () => {
    const r = ok([{ id: 'a', power: 'sensor.a', Label: 'A' }]);
    expect(r.errors).toEqual([{ path: 'meters[0].Label', message: 'unknown field (did you mean "label"?)' }]);
    const r2 = ok([{ id: 'a', power: 'sensor.a' }], { colour: 'red' });
    expect(r2.errors[0].path).toBe('colour');
    expect(r2.errors[0].message).toMatch(/^unknown field \(expected one of: /);
  });

  it('entity ids', () => {
    const r = ok([{ id: 'a', power: 'Sensor.A' }]);
    expect(r.errors).toEqual([
      { path: 'meters[0].power', message: '"Sensor.A" doesn\'t match ^[a-z_]+\\.[A-Za-z0-9_]+$' },
    ]);
    const r2 = ok([{ id: 'a', power: ['sensor.a', 'nodot'] }]);
    expect(r2.errors.map((e) => e.path)).toEqual(['meters[0].power[1]']);
    const r3 = ok([{ id: 'a', power: [] }]);
    expect(r3.errors.map((e) => e.path)).toEqual(['meters[0].power']);
    const r4 = ok([{ id: 'a', power: 'sensor.a', remainder: 'bad id' }]);
    expect(r4.errors.map((e) => e.path)).toEqual(['meters[0].remainder']);
  });

  it('power as a number: the type-array message', () => {
    const r = ok([{ id: 'a', power: 5 }]);
    expect(r.errors).toEqual([{ path: 'meters[0].power', message: 'expected a string or an array, got a number' }]);
  });

  it('breaker: a number, a string or a list of them', () => {
    expect(ok([{ id: 'a', power: 'sensor.a', breaker: 12 }]).ok).toBe(true);
    expect(ok([{ id: 'a', power: 'sensor.a', breaker: '17+19' }]).ok).toBe(true);
    expect(ok([{ id: 'a', power: 'sensor.a', breaker: [17, '19'] }]).ok).toBe(true);
    expect(ok([{ id: 'a', power: 'sensor.a', breaker: true }]).errors[0].message).toBe(
      'expected a string or a whole number or an array, got a boolean',
    );
  });

  it('scale: idle below max', () => {
    const r = ok([{ id: 'a', power: 'sensor.a' }], { scale: { idle: 100, max: 50 } });
    expect(r.errors).toEqual([{ path: 'scale.idle', message: 'must be below scale.max' }]);
  });

  it('warnings: an entity used as power twice, a remainder without children, a source under a load', () => {
    const r = ok([
      { id: 'a', power: 'sensor.a', remainder: 'sensor.bal' },
      { id: 'b', power: 'sensor.a', children: [{ id: 'pv', kind: 'source', power: 'sensor.pv' }] },
    ]);
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      { path: 'meters[0].remainder', message: 'a remainder without children: there is no Other to show' },
      { path: 'meters[1].power', message: "sensor.a is also meters[0]'s: it is counted twice" },
      { path: 'meters[1].children[0].kind', message: 'a source under a load: it is not summed into the load' },
    ]);
  });

  it('feedTarget / feedRef / breakerText', () => {
    expect(feedTarget({ registry: 'elec.panel' })).toEqual({ kind: 'registry', id: 'elec.panel' });
    expect(feedTarget({ registry: 'a', room: 'b' })).toBeNull();
    expect(feedTarget({ conf: 'high' })).toBeNull();
    expect(feedRef({ registry: 'elec.panel', conf: 'high' })).toBe('pins:elec.panel');
    expect(feedRef({ plate: 'KIT-O-H' })).toBe('plates:KIT-O-H');
    expect(feedRef({ fixture: 'den.lamp' })).toBe('fixture:den.lamp');
    expect(feedRef({ node: 'Furn_fridge' })).toBe('node:Furn_fridge');
    expect(feedRef({ room: 'kitchen' })).toBe('room:kitchen');
    expect(feedRef({})).toBeNull();
    expect(breakerText(12)).toBe('12');
    expect(breakerText([17, 19])).toBe('17+19');
    expect(breakerText('17+19')).toBe('17+19');
    expect(breakerText(undefined)).toBeNull();
    expect(breakerText('')).toBeNull();
  });
});

// ------------------------------------------------------------------ mock.ts
describe('energy mock', () => {
  const tree = buildTree(DEMO);
  const T = new Date(2026, 9, 3, 18, 20).getTime();

  it('is deterministic for a tree, time and seed', () => {
    expect(mockStates(tree, T, 7)).toEqual(mockStates(buildTree(DEMO), T, 7));
    const a = mockStates(tree, T, 7, false).map((s) => s.state);
    const b = mockStates(tree, T, 8, false).map((s) => s.state);
    expect(a).not.toEqual(b);
  });

  it('states every power, remainder and energy entity the tree reads', () => {
    const ids = new Set(mockStates(tree, T).map((s) => s.entity_id));
    for (const e of tree.entityIds) expect(ids, e).toContain(e);
  });

  it("a parent's W is at least its children's sum", () => {
    for (const t of [T, T + 3600e3 * 7, T + 3600e3 * 13]) {
      const w = mockWatts(tree, t);
      for (const m of tree.all) {
        const kids = m.children.filter((c) => c.kind === m.kind);
        if (!kids.length) continue;
        const sum = kids.reduce((a, c) => a + w.get(c.id)!, 0);
        expect(w.get(m.id)!, m.id).toBeGreaterThanOrEqual(sum - 0.05 * kids.length);
      }
    }
  });

  it("the legs split sums back to the meter's W, and the reported remainder is the parent's Other", () => {
    const w = mockWatts(tree, T);
    const states = mockStates(tree, T, 7, false);
    const v = (id: string) => Number(states.find((s) => s.entity_id === id)!.state);
    for (const m of tree.all.filter((x) => x.power.length > 1)) {
      const sum = m.power.reduce((a, e) => a + v(e), 0);
      expect(sum, m.id).toBeCloseTo(w.get(m.id)!, 2);
    }
    expect(v('sensor.main_panel_balance_power')).toBeCloseTo(w.get('panel.main.other')!, 2);
    // and the tree reads them back as the mock meant them
    const rs = compute(tree, (id) => states.find((s) => s.entity_id === id));
    expect(rs.get('panel.main')!.w).toBeCloseTo(w.get('panel.main')!, 1);
    expect(rs.get('panel.main.other')!.reported).toBe(true);
  });

  it("today's energy is non-negative", () => {
    const states = mockStates(tree, T);
    const energy = states.filter((s) => s.attributes.device_class === 'energy');
    expect(energy.length).toBeGreaterThan(0);
    for (const s of energy) expect(Number(s.state), s.entity_id).toBeGreaterThanOrEqual(0);
  });

  it('mockHistory: a point every step from `from` to `to`', () => {
    const h = mockHistory(tree, 'sensor.fridge_power', T - 3600e3, T);
    expect(h).toHaveLength(13);
    expect(h[1].t - h[0].t).toBe(300e3);
    expect(h[0].t).toBe(T - 3600e3);
    expect(h.at(-1)!.t).toBe(T);
    for (const p of h) expect(p.v).toBeGreaterThanOrEqual(0);
    expect(h.at(-1)!.v).toBe(mockWatts(tree, T).get('circuit.fridge'));
    expect(mockHistory(tree, 'sensor.fridge_power', T - 3600e3, T, 7, 60e3)).toHaveLength(61);
    expect(mockHistory(tree, 'sensor.nothing', T - 3600e3, T)).toEqual([]);
    const bal = mockHistory(tree, 'sensor.main_panel_balance_power', T - 600e3, T);
    expect(bal.at(-1)!.v).toBe(mockWatts(tree, T).get('panel.main.other'));
  });
});

// ------------------------------------------------------------------ the site manifest
describe('the site manifest and plugins.energy', () => {
  const withEnergy = (energy: unknown, layerKey?: string): SiteManifest => {
    const m = COTTAGE();
    m.plugins = {
      ...m.plugins,
      'home-assistant': { url: 'https://ha.example.org' },
      energy,
    } as SiteManifest['plugins'];
    if (layerKey) m.layers![0].key = layerKey;
    return m;
  };

  it('accepts plugins.energy with a map, rejects one without', () => {
    const v = validateManifest(withEnergy({ map: 'energy.json' }));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    const bad = validateManifest(withEnergy({}));
    expect(bad.ok).toBe(false);
    expect(bad.errors).toEqual([{ path: 'plugins.energy.map', message: 'is required' }]);
  });

  it('J is reserved when energy is on, so a layer cannot take it', () => {
    expect(reservedKeys({ plugins: { energy: { map: 'e.json' } } }).has('J')).toBe(true);
    expect(reservedKeys({ plugins: {} }).has('J')).toBe(false);
    const v = validateManifest(withEnergy({ map: 'energy.json' }, 'J'));
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.path)).toEqual(['layers[0].key']);
    expect(v.errors[0].message).toMatch(/^J is one of the viewer's own keys/);
  });

  it('warns that energy without a connector shows nothing live', () => {
    const m = COTTAGE();
    m.plugins = { ...m.plugins, energy: { map: 'energy.json' } } as SiteManifest['plugins'];
    expect(validateManifest(m).warnings.map((w) => w.path)).toEqual(['plugins.energy']);
  });

  describe('checkSite', () => {
    // the energy check doesn't need the model: read just the manifest and the map (missing models are errors we filter)
    const files = (energy: unknown) => {
      const all: Record<string, string> = {
        'site.json': JSON.stringify(withEnergy({ map: 'energy.json' })),
        'plans/index.json': JSON.stringify({ sheets: [] }),
      };
      if (energy !== undefined) all['energy.json'] = typeof energy === 'string' ? energy : JSON.stringify(energy);
      return async (url: string) => {
        const k = url.replace('file:///site/', '');
        return all[k] != null ? new TextEncoder().encode(all[k]) : null;
      };
    };
    const energyLines = (xs: string[]) => xs.filter((l) => l.startsWith('energy map'));

    it('checks the energy map and counts its meters', async () => {
      const r = await checkSite('file:///site/site.json', files(DEMO));
      expect(energyLines(r.errors)).toEqual([]);
      expect(energyLines(r.notes)).toEqual(['energy map: 20 meters (1 low confidence)']);
    });

    it("reports the map's errors and warnings as energy map: …", async () => {
      const r = await checkSite(
        'file:///site/site.json',
        files({
          jarvis: 'jarvis-energy/1',
          meters: [{ id: 'a' }, { id: 'b', power: 'sensor.b', remainder: 'sensor.x' }],
        }),
      );
      expect(energyLines(r.errors)).toEqual([
        'energy map: meters[0]: a meter needs a power entity or children (its power is their sum)',
      ]);
      expect(energyLines(r.warnings)).toEqual([
        'energy map: meters[1].remainder: a remainder without children: there is no Other to show',
      ]);
      expect(r.ok).toBe(false);
    });

    it('a missing or broken map is an error', async () => {
      const missing = await checkSite('file:///site/site.json', files(undefined));
      expect(energyLines(missing.errors)).toEqual(['energy map: energy.json not found']);
      const broken = await checkSite('file:///site/site.json', files('{ nope'));
      expect(energyLines(broken.errors)).toHaveLength(1);
      expect(energyLines(broken.errors)[0]).toMatch(/^energy map: energy.json is not valid JSON/);
    });
  });
});
