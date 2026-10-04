// The energy plugin's history loader (past.ts): how many history requests a sparkline or the Today view costs, at
// most `concurrency` at once, children cached as a parent's series is built, results kept for the ttl; and the check
// for an Other far below zero (tree.ts overshoot).
import { describe, expect, it } from 'vitest';
import type { EntityState, HistoryPoint } from '../../src/plugin-api';
import type { MeterSpec } from '../../src/plugins/energy/map';
import { createPast } from '../../src/plugins/energy/past';
import { buildTree, compute, overshoot } from '../../src/plugins/energy/tree';

const T = Date.UTC(2026, 9, 3, 18); // 18:00 UTC
const leaf = (id: string, legs = 1): MeterSpec => ({
  id,
  power: legs === 1 ? `sensor.${id}` : Array.from({ length: legs }, (_, i) => `sensor.${id}_l${i + 1}`),
});

/** a fake history: a flat 100 W over the day, counting calls and the most at once */
function fakeHistory(delay = 5) {
  const calls: string[] = [];
  let active = 0,
    max = 0;
  const history = async (e: string, from: number, to: number): Promise<HistoryPoint[]> => {
    calls.push(e);
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, delay));
    active--;
    return [
      { t: from, state: '100', v: 100 },
      { t: to - 1, state: '100', v: 100 },
    ];
  };
  return { history, calls, max: () => max };
}

describe('energy history loader', () => {
  it('fetches each power entity once, legs included', async () => {
    const tree = buildTree({ meters: [leaf('a'), leaf('dryer', 2)] });
    const h = fakeHistory();
    const past = createPast({ history: h.history, now: () => T });
    await past.load(tree.byId.a);
    await past.load(tree.byId.dryer);
    expect(h.calls).toEqual(['sensor.a', 'sensor.dryer_l1', 'sensor.dryer_l2']);
    expect(past.get(tree.byId.dryer)!.series.every((v) => v === 200)).toBe(true);
  });

  it("a derived parent's series caches its children: opening a child afterwards costs nothing", async () => {
    const tree = buildTree({
      meters: [{ id: 'p', children: [leaf('a'), leaf('b'), { id: 'sub', children: [leaf('c'), leaf('d')] }] }],
    });
    const h = fakeHistory();
    const past = createPast({ history: h.history, now: () => T });
    const p = await past.load(tree.byId.p);
    expect(h.calls.sort()).toEqual(['sensor.a', 'sensor.b', 'sensor.c', 'sensor.d']);
    expect(p.series[10]).toBe(400);
    for (const id of ['a', 'b', 'sub', 'c', 'd']) {
      expect(past.settled(tree.byId[id])).toBe(true);
      await past.load(tree.byId[id]);
    }
    expect(h.calls).toHaveLength(4); // no refetch
    expect(past.get(tree.byId.sub)!.series[10]).toBe(200);
  });

  it('never runs more than `concurrency` requests at once (a house of 35 circuits)', async () => {
    const tree = buildTree({ meters: [{ id: 'p', children: Array.from({ length: 35 }, (_, i) => leaf(`c${i}`)) }] });
    const h = fakeHistory(2);
    const past = createPast({ history: h.history, now: () => T, concurrency: 4 });
    await past.load(tree.byId.p);
    expect(h.calls).toHaveLength(35);
    expect(h.max()).toBeLessThanOrEqual(4);
    expect(past.stats.maxActive).toBeLessThanOrEqual(4);
  });

  it('shares a request in flight, and keeps the result for the ttl', async () => {
    const tree = buildTree({ meters: [leaf('a')] });
    const h = fakeHistory();
    let now = T;
    const past = createPast({ history: h.history, now: () => now, ttl: 60e3 });
    await Promise.all([past.load(tree.byId.a), past.load(tree.byId.a), past.load(tree.byId.a)]);
    expect(h.calls).toHaveLength(1);
    now += 30e3;
    await past.load(tree.byId.a);
    expect(h.calls).toHaveLength(1);
    now += 60e3;
    expect(past.settled(tree.byId.a)).toBe(false);
    await past.load(tree.byId.a);
    expect(h.calls).toHaveLength(2);
  });

  it("an Other costs nothing; a failed request gives an empty past and doesn't blank its siblings", async () => {
    const tree = buildTree({ meters: [{ id: 'p', children: [leaf('a'), leaf('bad')] }] });
    const errors: string[] = [];
    const past = createPast({
      now: () => T,
      history: async (e, from, to) => {
        if (e === 'sensor.bad') throw new Error('nope');
        return [
          { t: from, state: '50', v: 50 },
          { t: to, state: '50', v: 50 },
        ];
      },
      onError: (m) => errors.push(m.id),
    });
    const p = await past.load(tree.byId.p);
    expect(errors).toEqual(['bad']);
    expect(p.series[0]).toBe(50);
    expect(
      (await past.load(buildTree({ meters: [{ id: 'x', power: 'sensor.x', children: [leaf('y')] }] }).byId['x.other']))
        .series,
    ).toEqual([]);
  });

  it("today's kWh from a history back to midnight; none from a shorter one", async () => {
    const tree = buildTree({ meters: [leaf('a'), leaf('short')] });
    const past = createPast({
      now: () => T,
      history: async (e, from, to) =>
        e === 'sensor.short' ? [{ t: to - 3600e3, state: '1000', v: 1000 }] : [{ t: from, state: '1000', v: 1000 }],
    });
    const a = await past.load(tree.byId.a);
    const midnight = new Date(T);
    midnight.setHours(0, 0, 0, 0);
    expect(a.today).toBeCloseTo((T - midnight.getTime()) / 3.6e6, 3); // 1 kW since local midnight
    expect((await past.load(tree.byId.short)).today).toBeNull();
  });
});

describe('energy: an Other far below zero', () => {
  const get =
    (states: Record<string, string>) =>
    (id: string): EntityState | undefined =>
      states[id] === undefined
        ? undefined
        : { entity_id: id, state: states[id], attributes: { unit_of_measurement: 'W' } };
  const meters: MeterSpec[] = [{ id: 'p', power: 'sensor.p', children: [leaf('a'), leaf('b')] }];
  const check = (states: Record<string, string>) => {
    const tree = buildTree({ meters });
    const rs = compute(tree, get(states));
    return { other: rs.get('p.other')!, over: overshoot(rs.get('p.other'), rs.get('p')!.w) };
  };
  it('clamps to 0 but keeps the raw remainder', () => {
    const { other } = check({ 'sensor.p': '1000', 'sensor.a': '900', 'sensor.b': '300' });
    expect(other.w).toBe(0);
    expect(other.raw).toBe(-200);
  });
  it('a little below zero is the meters disagreeing: no warning (under max(50 W, 5 %))', () => {
    expect(check({ 'sensor.p': '1000', 'sensor.a': '1000', 'sensor.b': '40' }).over).toBeNull();
    expect(check({ 'sensor.p': '4000', 'sensor.a': '4000', 'sensor.b': '190' }).over).toBeNull();
  });
  it('well below zero is a mapping error: the shortfall', () => {
    expect(check({ 'sensor.p': '1000', 'sensor.a': '900', 'sensor.b': '300' }).over).toBe(200);
    // a kW sensor without a unit read as W: 1.2 "W" of mains under 900 W of circuits
    expect(check({ 'sensor.p': '1.2', 'sensor.a': '600', 'sensor.b': '300' }).over).toBeCloseTo(898.8);
  });
  it('none for a positive remainder or no data', () => {
    expect(check({ 'sensor.p': '1000', 'sensor.a': '100', 'sensor.b': '100' }).over).toBeNull();
    expect(check({ 'sensor.a': '100' }).over).toBeNull();
  });
});
