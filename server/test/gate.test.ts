// The gate: the only caller of callService. Every tier against the mock HA, confirmations (TTL, replay, other
// clients, cancel, spoken yes/no), re-evaluation on approval, max_minutes timers, and model self-approval attempts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGate } from '../src/core/gate.ts';
import type { AuditRecord, GateOptions } from '../src/core/gate.ts';
import { EMPTY_POLICY, parsePolicy } from '../src/core/policy.ts';
import { createMockHa, mockEntityIds, MOCK_EXTRA_IDS } from '../src/core/ha-mock.ts';
import type { ActContext, ActOutcome, PendingAction } from '../src/core/types.ts';
import { EXAMPLE_POLICY } from './policy-fixture.ts';

const screen: ActContext = { surface: 'screen', clientId: 'tab-1', utterance: 'do the thing' };
const speaker: ActContext = { surface: 'speaker', clientId: 'kitchen-sat' };
const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(policy: unknown = EXAMPLE_POLICY, more: Partial<GateOptions> = {}) {
  const ha = createMockHa();
  const pendings: PendingAction[] = [];
  const resolved: [string, string, string?][] = [];
  const audits: AuditRecord[] = [];
  const gate = createGate({
    policy: parsePolicy(policy),
    backend: ha,
    onPending: (p) => pendings.push(p),
    onResolved: (id, o, d) => resolved.push([id, o, d]),
    audit: (r) => audits.push(r),
    ...more,
  });
  return { ha, gate, pendings, resolved, audits };
}

/** start an act that should park; returns its promise and the pending action */
async function parked(g: ReturnType<typeof setup>, req: Parameters<typeof g.gate.act>[0], ctx = screen) {
  let outcome: ActOutcome | undefined;
  const p = g.gate.act(req, ctx).then((o) => (outcome = o));
  await flush();
  expect(outcome).toBeUndefined();
  const pending = g.pendings[g.pendings.length - 1];
  expect(pending).toBeDefined();
  return { p, pending, outcome: () => outcome };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('tiers', () => {
  it('allow: exactly one HA call with the right data', async () => {
    const g = setup();
    const o = await g.gate.act(
      {
        entity_ids: ['light.kitchen_pendant_1', 'light.kitchen_pendant_2'],
        service: 'turn_on',
        data: { brightness_pct: 50 },
      },
      screen,
    );
    expect(o).toEqual({
      status: 'done',
      summary: 'Turn on Kitchen pendant 1 and Kitchen pendant 2 with 50 (brightness_pct)',
    });
    expect(g.ha.calls).toEqual([
      {
        domain: 'light',
        service: 'turn_on',
        data: { entity_id: ['light.kitchen_pendant_1', 'light.kitchen_pendant_2'], brightness_pct: 50 },
      },
    ]);
    expect(g.ha.entities.get('light.kitchen_pendant_1')!.state).toBe('on');
    expect(g.pendings).toEqual([]);
    expect(g.audits).toHaveLength(1);
    expect(g.audits[0]).toMatchObject({
      clientId: 'tab-1',
      surface: 'screen',
      utterance: 'do the thing',
      tier: 'allow',
      outcome: 'done',
    });
  });

  it('allow across two domains: one call per domain', async () => {
    const g = setup();
    await g.gate.act({ entity_ids: ['light.hall', 'switch.bathroom_vanity'], service: 'turn_on' }, screen);
    expect(g.ha.calls.map((c) => `${c.domain}.${c.service}:${c.data.entity_id}`)).toEqual([
      'light.turn_on:light.hall',
      'switch.turn_on:switch.bathroom_vanity',
    ]);
  });

  it('deny never calls HA', async () => {
    const g = setup();
    const o = await g.gate.act({ entity_ids: ['lock.front_door'], service: 'unlock' }, screen);
    expect(o).toEqual({ status: 'refused', reason: 'Unlocking is never done by the assistant' });
    expect(g.ha.calls).toEqual([]);
    expect(g.ha.entities.get('lock.front_door')!.state).toBe('locked');
    expect(g.audits[0]).toMatchObject({ tier: 'deny', outcome: 'refused' });
  });

  it('the empty policy refuses everything', async () => {
    const g = setup();
    g.gate.setPolicy(EMPTY_POLICY);
    for (const id of mockEntityIds()) {
      const o = await g.gate.act({ entity_ids: [id], service: 'turn_on' }, screen);
      expect(o.status).toBe('refused');
    }
    expect(g.ha.calls).toEqual([]);
  });

  it('a mixed call with one denied entity does nothing at all', async () => {
    const g = setup();
    const o = await g.gate.act({ entity_ids: ['light.hall', 'switch.network_rack'], service: 'turn_off' }, screen);
    expect(o.status).toBe('refused');
    expect(g.ha.calls).toEqual([]);
  });

  it('a bad request or context is refused before HA is asked anything', async () => {
    const g = setup();
    const states = vi.spyOn(g.ha, 'states');
    expect(
      (
        await g.gate.act(
          { entity_ids: ['light.hall'], service: 'turn_on', data: { entity_id: 'lock.front_door' } },
          screen,
        )
      ).status,
    ).toBe('refused');
    expect(
      (await g.gate.act({ entity_ids: ['light.hall'], service: 'turn_on' }, { surface: 'screen', clientId: '' }))
        .status,
    ).toBe('refused');
    expect(
      (
        await g.gate.act(
          { entity_ids: ['light.hall'], service: 'turn_on' },
          { surface: 'panel' as 'screen', clientId: 'x' },
        )
      ).status,
    ).toBe('refused');
    expect(states).not.toHaveBeenCalled();
    expect(g.ha.calls).toEqual([]);
  });

  it('HA failing: failed, and nothing claims success', async () => {
    const g = setup();
    vi.spyOn(g.ha, 'callService').mockRejectedValueOnce(new Error('boom'));
    const o = await g.gate.act({ entity_ids: ['light.hall'], service: 'turn_on' }, screen);
    expect(o).toEqual({ status: 'failed', summary: 'Turn on Hall light', error: 'boom' });
    expect(g.audits[0]).toMatchObject({ outcome: 'failed', reason: 'boom' });
  });

  it('states unreadable: refused', async () => {
    const g = setup();
    vi.spyOn(g.ha, 'states').mockRejectedValueOnce(new Error('offline'));
    const o = await g.gate.act({ entity_ids: ['light.hall'], service: 'turn_on' }, screen);
    expect(o).toEqual({ status: 'refused', reason: "couldn't read Home Assistant states: offline" });
  });

  it('evaluate is a dry run', async () => {
    const g = setup();
    expect(await g.gate.evaluate({ entity_ids: ['lock.front_door'], service: 'lock' }, screen)).toEqual({
      tier: 'confirm',
      reason: 'lock.front_door lock needs confirmation (rules[6])',
      summary: 'Lock Front door lock',
    });
    expect(await g.gate.evaluate({ entity_ids: ['light.hall'], service: 'turn_on' }, screen)).toMatchObject({
      tier: 'allow',
    });
    expect(await g.gate.evaluate({ entity_ids: ['lock.front_door'], service: 'unlock' }, screen)).toMatchObject({
      tier: 'deny',
    });
    expect(g.ha.calls).toEqual([]);
    expect(g.pendings).toEqual([]);
    expect(g.audits).toEqual([]);
  });
});

describe('confirm', () => {
  it('parks, shows a plain summary, and calls HA only once approved', async () => {
    const g = setup();
    const req = { entity_ids: ['climate.hall_thermostat'], service: 'set_temperature', data: { temperature: 72 } };
    const { p, pending } = await parked(g, req);
    expect(pending).toMatchObject({
      clientId: 'tab-1',
      surface: 'screen',
      summary: 'Set Hall thermostat to 72 (temperature)',
      detail: 'climate.set_temperature on climate.hall_thermostat {"temperature":72}',
      risk: 'normal',
      expiresAt: Date.now() + 30_000,
    });
    expect(g.gate.pending('tab-1')).toEqual([pending]);
    expect(g.ha.calls).toEqual([]);
    expect(g.gate.reply(pending.id, 'tab-1', true)).toEqual({ ok: true });
    expect(await p).toEqual({ status: 'done', summary: 'Set Hall thermostat to 72 (temperature)' });
    expect(g.ha.calls).toHaveLength(1);
    expect(g.ha.entities.get('climate.hall_thermostat')!.attributes.temperature).toBe(72);
    expect(g.resolved).toEqual([[pending.id, 'approved', undefined]]);
    expect(g.gate.pending()).toEqual([]);
    expect(g.audits.map((a) => a.outcome)).toEqual(['pending', 'done']);
    expect(g.audits.every((a) => a.pendingId === pending.id)).toBe(true);
  });

  it('risk high comes through to the pending action', async () => {
    const g = setup();
    const { pending } = await parked(g, { entity_ids: ['cover.garage_door'], service: 'close_cover' });
    expect(pending.risk).toBe('high');
  });

  it('expires at 30 s: outcome expired, no call; a reply afterwards is rejected', async () => {
    const g = setup();
    const { p, pending, outcome } = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ status: 'expired', summary: 'Lock Front door lock' });
    expect(g.resolved).toEqual([[pending.id, 'expired', 'nobody answered']]);
    expect(g.gate.reply(pending.id, 'tab-1', true)).toEqual({ ok: false, reason: 'already expired' });
    await flush();
    expect(g.ha.calls).toEqual([]);
    expect(g.audits.map((a) => a.outcome)).toEqual(['pending', 'expired']);
  });

  it('a custom TTL and injected clock/timers', async () => {
    const timers: (() => void)[] = [];
    const g = setup(EXAMPLE_POLICY, {
      ttlMs: 5_000,
      now: () => 1_000,
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => {},
    });
    const { p, pending } = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' });
    expect(pending.expiresAt).toBe(6_000);
    timers[0]();
    expect((await p).status).toBe('expired');
  });

  it('replay: a second approve on the same id is rejected and makes no second call', async () => {
    const g = setup();
    const { p, pending } = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' });
    expect(g.gate.reply(pending.id, 'tab-1', true).ok).toBe(true);
    expect(g.gate.reply(pending.id, 'tab-1', true)).toEqual({ ok: false, reason: 'already answered' });
    await p;
    expect(g.gate.reply(pending.id, 'tab-1', true).ok).toBe(false);
    await flush();
    expect(g.ha.calls).toHaveLength(1);
  });

  it('a reply from another client is rejected, and the right client can still answer', async () => {
    const g = setup();
    const { p, pending } = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' });
    expect(g.gate.reply(pending.id, 'tab-2', true)).toEqual({ ok: false, reason: 'not your pending action' });
    await flush();
    expect(g.ha.calls).toEqual([]);
    expect(g.gate.reply(pending.id, 'tab-1', true).ok).toBe(true);
    expect((await p).status).toBe('done');
  });

  it('an unknown id is rejected', () => {
    const g = setup();
    expect(g.gate.reply('00000000-0000-0000-0000-000000000000', 'tab-1', true)).toEqual({
      ok: false,
      reason: 'no such pending action',
    });
  });

  it('deny: the person said no', async () => {
    const g = setup();
    const { p, pending } = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' });
    expect(g.gate.reply(pending.id, 'tab-1', false)).toEqual({ ok: true });
    expect(await p).toEqual({ status: 'denied', summary: 'Lock Front door lock' });
    expect(g.resolved).toEqual([[pending.id, 'denied', 'the person said no']]);
    expect(g.ha.calls).toEqual([]);
    expect(g.gate.reply(pending.id, 'tab-1', true).ok).toBe(false);
  });

  it('only a literal true approves', async () => {
    const g = setup();
    const { p, pending } = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' });
    g.gate.reply(pending.id, 'tab-1', 'yes' as unknown as boolean);
    expect((await p).status).toBe('denied');
  });

  it('cancel(clientId) on interrupt denies that client’s actions only; cancel() denies all', async () => {
    const g = setup();
    const a = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' });
    const b = await parked(
      g,
      { entity_ids: ['script.goodnight'], service: 'turn_on' },
      { surface: 'screen', clientId: 'tab-2' },
    );
    g.gate.cancel('tab-1');
    expect(await a.p).toEqual({ status: 'denied', summary: 'Lock Front door lock' });
    expect(g.resolved).toEqual([[a.pending.id, 'denied', 'cancelled']]);
    expect(g.gate.pending().map((x) => x.id)).toEqual([b.pending.id]);
    g.gate.cancel();
    expect((await b.p).status).toBe('denied');
    expect(g.gate.pending()).toEqual([]);
    expect(g.ha.calls).toEqual([]);
  });

  it('re-evaluates at approval: a policy changed to deny refuses', async () => {
    const g = setup();
    const { p, pending } = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' });
    g.gate.setPolicy(
      parsePolicy({ version: 1, rules: [{ deny: { domain: 'lock' }, reason: 'locks are off limits now' }] }),
    );
    expect(g.gate.reply(pending.id, 'tab-1', true).ok).toBe(true);
    expect(await p).toEqual({ status: 'refused', reason: 'no longer allowed: locks are off limits now' });
    expect(g.resolved).toEqual([[pending.id, 'failed', 'no longer allowed: locks are off limits now']]);
    expect(g.ha.calls).toEqual([]);
  });

  it('re-evaluates at approval against fresh states (a device class that changed)', async () => {
    const g = setup();
    const { p, pending } = await parked(g, { entity_ids: ['cover.garage_door'], service: 'close_cover' });
    const cur = g.ha.entities.get('cover.garage_door')!;
    g.ha.entities.set('cover.garage_door', { ...cur, attributes: { ...cur.attributes, device_class: 'gate' } });
    g.gate.reply(pending.id, 'tab-1', true);
    expect((await p).status).toBe('refused');
    expect(g.ha.calls).toEqual([]);
  });

  it('approved but HA fails: failed', async () => {
    const g = setup();
    const { p, pending } = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' });
    vi.spyOn(g.ha, 'callService').mockRejectedValueOnce(new Error('jammed'));
    g.gate.reply(pending.id, 'tab-1', true);
    expect(await p).toEqual({ status: 'failed', summary: 'Lock Front door lock', error: 'jammed' });
    expect(g.resolved).toEqual([[pending.id, 'failed', 'jammed']]);
  });

  it('what is approved is what was shown, even if the caller mutates its request object', async () => {
    const g = setup();
    const req = { entity_ids: ['climate.hall_thermostat'], service: 'set_temperature', data: { temperature: 72 } };
    const { p, pending } = await parked(g, req);
    req.data.temperature = 84;
    req.entity_ids.push('lock.front_door');
    g.gate.reply(pending.id, 'tab-1', true);
    await p;
    expect(g.ha.calls).toEqual([
      {
        domain: 'climate',
        service: 'set_temperature',
        data: { entity_id: ['climate.hall_thermostat'], temperature: 72 },
      },
    ]);
  });

  it('bulk: more than 8 lights asks first', async () => {
    const g = setup();
    const lights = mockEntityIds()
      .filter((e) => e.startsWith('light.'))
      .slice(0, 9);
    const { p, pending } = await parked(g, { entity_ids: lights, service: 'turn_on' });
    expect(pending.summary).toMatch(/^Turn on /);
    expect(g.ha.calls).toEqual([]);
    g.gate.reply(pending.id, 'tab-1', true);
    expect((await p).status).toBe('done');
    expect(g.ha.calls).toHaveLength(1);
  });
});

describe('the model cannot approve', () => {
  it('data like { confirmed: true } is refused', async () => {
    const g = setup();
    for (const data of [{ confirmed: true }, { approve: true }, { confirm_id: 'x' }, { pending_id: 'x' }]) {
      const o = await g.gate.act({ entity_ids: ['lock.front_door'], service: 'lock', data }, screen);
      expect(o.status).toBe('refused');
    }
    expect(g.pendings).toEqual([]);
    expect(g.ha.calls).toEqual([]);
  });

  it('a repeated act parks a second action; it does not approve the first', async () => {
    const g = setup();
    const req = { entity_ids: ['lock.front_door'], service: 'lock' };
    const a = await parked(g, req);
    const b = await parked(g, req);
    expect(a.pending.id).not.toBe(b.pending.id);
    expect(g.gate.pending('tab-1')).toHaveLength(2);
    expect(g.ha.calls).toEqual([]);
    g.gate.cancel();
    await Promise.all([a.p, b.p]);
  });

  it('spoken: an exact yes approves the single pending action', async () => {
    const g = setup();
    const { p } = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' }, speaker);
    expect(g.gate.spoken('kitchen-sat', 'Yes.')).toBe(true);
    expect((await p).status).toBe('done');
    expect(g.ha.calls).toHaveLength(1);
  });

  it('spoken: no denies', async () => {
    const g = setup();
    const { p } = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' }, speaker);
    expect(g.gate.spoken('kitchen-sat', 'cancel')).toBe(true);
    expect((await p).status).toBe('denied');
  });

  it('spoken: "yes, and also unlock the door" is not a yes (it stays pending)', async () => {
    const g = setup();
    const { p } = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' }, speaker);
    expect(g.gate.spoken('kitchen-sat', 'yes, and also unlock the door')).toBe(false);
    expect(g.gate.spoken('kitchen-sat', 'yes but turn the lights on')).toBe(false);
    expect(g.gate.pending('kitchen-sat')).toHaveLength(1);
    expect(g.ha.calls).toEqual([]);
    g.gate.cancel();
    await p;
  });

  it('spoken: with two pending for the client it does not guess', async () => {
    const g = setup();
    const a = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' }, speaker);
    const b = await parked(g, { entity_ids: ['script.goodnight'], service: 'turn_on' }, speaker);
    expect(g.gate.spoken('kitchen-sat', 'yes')).toBe(false);
    expect(g.gate.spoken('kitchen-sat', 'no')).toBe(false);
    expect(g.gate.pending('kitchen-sat')).toHaveLength(2);
    g.gate.cancel();
    await Promise.all([a.p, b.p]);
    expect(g.ha.calls).toEqual([]);
  });

  it('spoken: a yes from another client does not approve', async () => {
    const g = setup();
    const { p } = await parked(g, { entity_ids: ['lock.front_door'], service: 'lock' }, speaker);
    expect(g.gate.spoken('tab-1', 'yes')).toBe(false);
    expect(g.gate.spoken('bedroom-sat', 'yes')).toBe(false);
    expect(g.gate.pending('kitchen-sat')).toHaveLength(1);
    g.gate.cancel();
    await p;
    expect(g.ha.calls).toEqual([]);
  });

  it('spoken with nothing pending is not consumed', () => {
    const g = setup();
    expect(g.gate.spoken('tab-1', 'yes')).toBe(false);
  });

  // routing only the person's words to spoken() (never the assistant's own text) is the hub's job
});

describe('max_minutes', () => {
  it('defaults to the max, strips minutes, and turns off when the time is up', async () => {
    const g = setup();
    const o = await g.gate.act({ entity_ids: ['switch.pond_pump'], service: 'turn_on' }, screen);
    expect(o).toEqual({ status: 'done', summary: 'Turn on Pond pump for 60 minutes' });
    expect(g.ha.calls).toEqual([{ domain: 'switch', service: 'turn_on', data: { entity_id: ['switch.pond_pump'] } }]);
    expect(g.ha.entities.get('switch.pond_pump')!.state).toBe('on');
    expect(g.ha.entities.get('sensor.pond_pump_power')!.state).toBe('42');
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(g.ha.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(g.ha.calls[1]).toEqual({ domain: 'switch', service: 'turn_off', data: { entity_id: ['switch.pond_pump'] } });
    expect(g.ha.entities.get('switch.pond_pump')!.state).toBe('off');
    expect(g.audits[1]).toMatchObject({ outcome: 'done', timer: true, request: { service: 'turn_off' } });
  });

  it('minutes shortens the run and is never sent to HA', async () => {
    const g = setup();
    await g.gate.act({ entity_ids: ['switch.pond_pump'], service: 'turn_on', data: { minutes: 5 } }, screen);
    expect(g.ha.calls[0].data).toEqual({ entity_id: ['switch.pond_pump'] });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(g.ha.calls.map((c) => c.service)).toEqual(['turn_on', 'turn_off']);
  });

  it('over the max is refused', async () => {
    const g = setup();
    const o = await g.gate.act({ entity_ids: ['switch.pond_pump'], service: 'turn_on', data: { minutes: 90 } }, screen);
    expect(o).toEqual({ status: 'refused', reason: 'minutes 90 is outside 0–60 for switch.pond_pump' });
    expect(g.ha.calls).toEqual([]);
  });

  it('turning it off meanwhile cancels the timer; turning it on again restarts it', async () => {
    const g = setup();
    await g.gate.act({ entity_ids: ['switch.pond_pump'], service: 'turn_on', data: { minutes: 10 } }, screen);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await g.gate.act({ entity_ids: ['switch.pond_pump'], service: 'turn_off' }, screen);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(g.ha.calls.map((c) => c.service)).toEqual(['turn_on', 'turn_off']);

    await g.gate.act({ entity_ids: ['switch.pond_pump'], service: 'turn_on', data: { minutes: 10 } }, screen);
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    await g.gate.act({ entity_ids: ['switch.pond_pump'], service: 'turn_on', data: { minutes: 10 } }, screen);
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    expect(g.ha.calls.map((c) => c.service)).toEqual(['turn_on', 'turn_off', 'turn_on', 'turn_on']);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(g.ha.calls.map((c) => c.service)).toEqual(['turn_on', 'turn_off', 'turn_on', 'turn_on', 'turn_off']);
  });

  it('a confirmed valve run closes again after its minutes', async () => {
    const g = setup();
    const { p, pending } = await parked(g, {
      entity_ids: ['valve.garden_zone_1'],
      service: 'open_valve',
      data: { minutes: 15 },
    });
    expect(pending.summary).toBe('Open Garden zone 1 for 15 minutes');
    expect(pending.detail).toBe(
      'valve.open_valve on valve.garden_zone_1; then valve.close_valve on valve.garden_zone_1 after 15 min',
    );
    g.gate.reply(pending.id, 'tab-1', true);
    await p;
    expect(g.ha.entities.get('valve.garden_zone_1')!.state).toBe('open');
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(g.ha.entities.get('valve.garden_zone_1')!.state).toBe('closed');
    expect(g.ha.calls.map((c) => c.service)).toEqual(['open_valve', 'close_valve']);
  });

  it('a call that fails still gets its off call: two domains, the second throws', async () => {
    const g = setup({
      version: 1,
      rules: [{ allow: { domain: ['light', 'switch'], service: ['turn_on', 'turn_off'] }, max_minutes: 10 }],
    });
    const real = g.ha.callService.bind(g.ha);
    vi.spyOn(g.ha, 'callService').mockImplementation((domain, service, data) =>
      domain === 'switch' && service === 'turn_on'
        ? Promise.reject(new Error('timed out'))
        : real(domain, service, data),
    );
    const o = await g.gate.act({ entity_ids: ['light.hall', 'switch.pond_pump'], service: 'turn_on' }, screen);
    expect(o).toMatchObject({ status: 'failed', error: 'timed out' });
    expect(g.ha.entities.get('light.hall')!.state).toBe('on');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(g.ha.calls.map((c) => `${c.domain}.${c.service}:${c.data.entity_id}`)).toEqual([
      'light.turn_on:light.hall',
      'light.turn_off:light.hall',
      'switch.turn_off:switch.pond_pump',
    ]);
    expect(g.ha.entities.get('light.hall')!.state).toBe('off');
  });

  it('a single timed call that throws (a timeout: it may have happened) still schedules the off call', async () => {
    const g = setup();
    vi.spyOn(g.ha, 'callService').mockRejectedValueOnce(new Error('timed out'));
    const o = await g.gate.act({ entity_ids: ['switch.pond_pump'], service: 'turn_on', data: { minutes: 5 } }, screen);
    expect(o).toMatchObject({ status: 'failed' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(g.ha.calls).toEqual([{ domain: 'switch', service: 'turn_off', data: { entity_id: ['switch.pond_pump'] } }]);
    expect(g.audits.at(-1)).toMatchObject({ outcome: 'done', timer: true });
  });

  it('a failing turn_off keeps the running timer', async () => {
    const g = setup();
    await g.gate.act({ entity_ids: ['switch.pond_pump'], service: 'turn_on', data: { minutes: 5 } }, screen);
    vi.spyOn(g.ha, 'callService').mockRejectedValueOnce(new Error('unreachable'));
    expect(await g.gate.act({ entity_ids: ['switch.pond_pump'], service: 'turn_off' }, screen)).toMatchObject({
      status: 'failed',
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(g.ha.calls.map((c) => c.service)).toEqual(['turn_on', 'turn_off']);
  });

  it('a failing off call is audited', async () => {
    const g = setup();
    await g.gate.act({ entity_ids: ['switch.pond_pump'], service: 'turn_on', data: { minutes: 1 } }, screen);
    vi.spyOn(g.ha, 'callService').mockRejectedValueOnce(new Error('unreachable'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(g.audits[1]).toMatchObject({ outcome: 'failed', timer: true });
    expect(g.audits[1].reason).toMatch(/unreachable/);
  });
});

describe('mock HA', () => {
  it('has the demo lights, the controls, and the made-up entities', () => {
    const ids = mockEntityIds();
    for (const id of [
      'light.kitchen_pendant_1',
      'light.living_room_cans',
      'switch.bathroom_vanity',
      'script.goodnight',
      'script.film_night',
    ])
      expect(ids).toContain(id);
    for (const id of MOCK_EXTRA_IDS) expect(ids).toContain(id);
    expect(ids).not.toContain(null);
  });

  it('friendly names and areas', async () => {
    const ha = createMockHa();
    const [p1, hall, cans, garage] = await ha.states([
      'light.kitchen_pendant_1',
      'light.hall',
      'light.living_room_cans',
      'cover.garage_door',
    ]);
    expect(p1.attributes).toMatchObject({ friendly_name: 'Kitchen pendant 1', area: 'Kitchen' });
    expect(hall.attributes).toMatchObject({ friendly_name: 'Hall light', area: 'Hall' });
    expect(cans.attributes.area).toBe('Living room');
    expect(garage.attributes.device_class).toBe('garage');
    expect((await ha.states(['weather.home']))[0].attributes.forecast).toHaveLength(3);
  });

  it('state changes after calls', async () => {
    const ha = createMockHa();
    const st = (id: string) => ha.entities.get(id)!;
    await ha.callService('light', 'turn_on', { entity_id: ['light.hall'], brightness_pct: 50 });
    expect(st('light.hall')).toMatchObject({ state: 'on', attributes: { brightness: 128 } });
    await ha.callService('light', 'toggle', { entity_id: ['light.hall'] });
    expect(st('light.hall').state).toBe('off');
    await ha.callService('climate', 'set_temperature', { entity_id: ['climate.hall_thermostat'], temperature: 74 });
    expect(st('climate.hall_thermostat').attributes.temperature).toBe(74);
    await ha.callService('climate', 'set_hvac_mode', { entity_id: ['climate.hall_thermostat'], hvac_mode: 'cool' });
    expect(st('climate.hall_thermostat').state).toBe('cool');
    await ha.callService('cover', 'open_cover', { entity_id: ['cover.garage_door'] });
    expect(st('cover.garage_door').state).toBe('open');
    await ha.callService('lock', 'unlock', { entity_id: ['lock.front_door'] });
    expect(st('lock.front_door').state).toBe('unlocked');
    await ha.callService('valve', 'open_valve', { entity_id: ['valve.garden_zone_1'] });
    expect(st('valve.garden_zone_1').state).toBe('open');
    await ha.callService('fan', 'set_percentage', { entity_id: ['fan.bedroom_fan'], percentage: 30 });
    expect(st('fan.bedroom_fan')).toMatchObject({ state: 'on', attributes: { percentage: 30 } });
    await ha.callService('light', 'turn_on', { entity_id: ['light.living_room_cans', 'light.kitchen_pendant_1'] });
    await ha.callService('script', 'turn_on', { entity_id: ['script.film_night'] });
    expect(st('light.living_room_cans').state).toBe('off');
    expect(st('light.kitchen_pendant_1').state).toBe('off');
    expect(ha.calls).toHaveLength(10);
  });

  it('unknown services, entities and wrong domains throw', async () => {
    const ha = createMockHa();
    await expect(ha.callService('light', 'explode', { entity_id: ['light.hall'] })).rejects.toThrow(/unknown service/);
    await expect(ha.callService('light', 'turn_on', { entity_id: ['light.nope'] })).rejects.toThrow(/unknown entity/);
    await expect(ha.callService('light', 'turn_on', { entity_id: ['switch.pond_pump'] })).rejects.toThrow(
      /not in light/,
    );
    expect(ha.calls).toEqual([]);
  });

  it('states are copies (a caller can’t change the mock by mutating them)', async () => {
    const ha = createMockHa();
    const [s] = await ha.states(['light.hall']);
    s.state = 'on';
    expect(ha.entities.get('light.hall')!.state).toBe('off');
  });

  it('history is deterministic and seeded', async () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-02T00:00:00Z');
    const a = await createMockHa(7).history('sensor.outdoor_temperature', from, to);
    const b = await createMockHa({ seed: 7 }).history('sensor.outdoor_temperature', from, to);
    const c = await createMockHa(8).history('sensor.outdoor_temperature', from, to);
    expect(a).toHaveLength(25);
    expect(a[0].at).toBe('2026-10-01T00:00:00.000Z');
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(await createMockHa().history('light.nope', from, to)).toEqual([]);
    const lights = await createMockHa().history('light.hall', from, to);
    expect(new Set(lights.map((p) => p.state))).toEqual(new Set(['on', 'off']));
  });
});
