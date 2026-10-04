import { describe, expect, it, vi } from 'vitest';
import { CORE_KEYS, createKeyRegistry, keyName } from '../../src/core/plugin/keys';
import { createStore } from '../../src/core/plugin/store';
import { reservedKeys } from '../../src/site';
import type { EntityState } from '../../src/core/plugin/types';

const ev = (
  code: string,
  mods: Partial<{ shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {},
) => ({ code, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods }) as KeyboardEvent;

describe('the key registry', () => {
  it('runs the binding for a key, with Shift and Alt told apart', () => {
    const r = createKeyRegistry();
    const p = vi.fn(),
      sp = vi.fn();
    r.add('pins', 'Pins', { code: 'KeyP', label: 'pins', run: p });
    r.add('pins', 'Pins', { code: 'KeyP', shift: true, label: 'through walls', run: sp });
    expect(r.handle(ev('KeyP'))).toBe(true);
    expect(r.handle(ev('KeyP', { shiftKey: true }))).toBe(true);
    expect(r.handle(ev('KeyP', { altKey: true }))).toBe(false);
    expect(p).toHaveBeenCalledOnce();
    expect(sp).toHaveBeenCalledOnce();
  });

  it('leaves Ctrl / Cmd combinations to the browser', () => {
    const r = createKeyRegistry();
    const f = vi.fn();
    r.add('core', 'Core', { code: 'KeyP', label: 'x', run: f });
    expect(r.handle(ev('KeyP', { ctrlKey: true }))).toBe(false);
    expect(r.handle(ev('KeyP', { metaKey: true }))).toBe(false);
  });

  it('reports a conflict and keeps the first binding', () => {
    const warn = vi.fn();
    const r = createKeyRegistry({ warn });
    const a = vi.fn(),
      b = vi.fn();
    r.add('pins', 'Pins', { code: 'KeyP', label: 'pins', run: a });
    r.add('other', 'Other', { code: 'KeyP', label: 'other', run: b });
    r.handle(ev('KeyP'));
    expect(a).toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/P \(other, other\) is already pins's/));
    expect(r.conflicts).toHaveLength(1);
  });

  it('help-only entries from a plugin never conflict and never run', () => {
    const r = createKeyRegistry({ warn: () => {} });
    r.add('docs', 'Docs', { code: 'KeyJ', label: 'listed' });
    const f = vi.fn();
    r.add('x', 'X', { code: 'KeyJ', label: 'j', run: f });
    expect(r.conflicts).toEqual([]);
    expect(r.list()).toHaveLength(2);
  });

  it('a key with no Shift binding of its own still works while Shift is held (running)', () => {
    const r = createKeyRegistry();
    const x = vi.fn(),
      p = vi.fn(),
      sp = vi.fn();
    r.add('core', 'Core', { code: 'KeyX', label: 'cutaway', run: x });
    r.add('pins', 'Pins', { code: 'KeyP', label: 'pins', run: p });
    r.add('pins', 'Pins', { code: 'KeyP', shift: true, label: 'through walls', run: sp });
    r.handle(ev('KeyX', { shiftKey: true }));
    r.handle(ev('KeyP', { shiftKey: true }));
    expect(x).toHaveBeenCalledOnce();
    expect(sp).toHaveBeenCalledOnce();
    expect(p).not.toHaveBeenCalled(); // its Shift variant wins
  });

  it("keeps the core's movement keys: a plugin can't bind them", () => {
    const warn = vi.fn();
    const r = createKeyRegistry({ warn });
    r.add('core', 'Core', { code: 'KeyW', label: 'move' });
    r.add('x', 'X', { code: 'KeyW', label: 'mine', run: () => {} });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/W \(mine, x\) is already core's/));
    expect(r.match(ev('KeyW'))).toBeNull();
  });

  it("every movement key, with and without Shift, is the core's: a plugin gets a conflict", async () => {
    const { MOVEMENT_KEYS } = await import('../../src/core/builtin');
    const warn = vi.fn();
    const r = createKeyRegistry({ warn });
    const jump = vi.fn();
    r.add('core', 'Core', { code: 'Space', label: 'jump', run: jump });
    for (const code of MOVEMENT_KEYS)
      for (const shift of [false, true])
        if (!(code === 'Space' && !shift)) r.add('core', 'Core', { code, shift, label: 'movement' });
    for (const code of MOVEMENT_KEYS)
      for (const shift of [false, true]) r.add('plugin', 'Plugin', { code, shift, label: 'mine', run: () => {} });
    expect(r.conflicts).toHaveLength(MOVEMENT_KEYS.length * 2);
    // and Space still jumps while Shift is held (a Shift-Space help entry doesn't hide the plain binding)
    r.handle(ev('Space', { shiftKey: true }));
    expect(jump).toHaveBeenCalledOnce();
  });

  it('hold to talk: run once per press however long the key repeats, release once when it goes up or the window blurs', () => {
    const r = createKeyRegistry();
    const run = vi.fn(),
      release = vi.fn();
    r.add('assistant', 'Assistant', { code: 'KeyJ', label: 'hold to talk', run, release });
    r.handle(ev('KeyJ'));
    for (let i = 0; i < 5; i++) r.handle({ ...ev('KeyJ'), repeat: true } as KeyboardEvent);
    expect(run).toHaveBeenCalledOnce();
    r.release(ev('KeyJ'));
    r.release(ev('KeyJ')); // a stray second keyup: nothing
    expect(release).toHaveBeenCalledOnce();
    r.handle(ev('KeyJ'));
    r.releaseAll();
    expect(run).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenLastCalledWith(null);
  });

  it('honours when()', () => {
    const r = createKeyRegistry();
    let ok = false;
    const f = vi.fn();
    r.add('core', 'Core', { code: 'Tab', label: 'mode', when: () => ok, run: f });
    expect(r.handle(ev('Tab'))).toBe(false);
    ok = true;
    expect(r.handle(ev('Tab'))).toBe(true);
  });

  it('dispose removes a binding', () => {
    const r = createKeyRegistry();
    const d = r.add('core', 'Core', { code: 'KeyG', label: 'ghost', run: () => {} });
    d.dispose();
    expect(r.match(ev('KeyG'))).toBeNull();
    expect(r.list()).toEqual([]);
  });

  it('warns when a built-in plugin uses a letter it does not declare (the site validator relies on the list)', () => {
    const warn = vi.fn();
    const r = createKeyRegistry({ declared: (o) => (o === 'pins' ? ['P'] : null), warn });
    r.add('pins', 'Pins', { code: 'KeyP', label: 'ok', run: () => {} });
    expect(warn).not.toHaveBeenCalled();
    r.add('pins', 'Pins', { code: 'KeyJ', label: 'undeclared', run: () => {} });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/pins uses J but doesn't declare it/));
  });

  it('names keys for help', () => {
    expect(keyName({ code: 'KeyP', shift: true })).toBe('Shift-P');
    expect(keyName({ code: 'Slash' })).toBe('/');
    expect(keyName({ code: 'Slash', shift: true })).toBe('?');
    expect(keyName({ code: 'Digit3' })).toBe('3');
    expect(keyName({ code: 'ArrowLeft', alt: true })).toBe('Alt-←');
  });
});

describe("a chip's keys", () => {
  it('work only while the chip shows: V does nothing while the faults chip is hidden (no connector)', async () => {
    const { toggleKeys } = await import('../../src/core/context');
    let live = false,
      on = false,
      all = false;
    const r = createKeyRegistry();
    for (const k of toggleKeys(
      {
        id: 'faults',
        label: 'Faults',
        key: { code: 'KeyV', label: 'faults' },
        when: () => live,
        get: () => on,
        set: (v) => (on = v),
        variants: [
          { label: 'all', key: { code: 'KeyV', shift: true, label: 'all' }, get: () => all, set: (v) => (all = v) },
        ],
      },
      { toggle: () => (on = !on), changed: () => {} },
    ))
      r.add('faults', 'Faults', k);
    expect(r.handle(ev('KeyV'))).toBe(false);
    expect(r.handle(ev('KeyV', { shiftKey: true }))).toBe(false);
    expect([on, all]).toEqual([false, false]);
    live = true;
    r.handle(ev('KeyV'));
    r.handle(ev('KeyV', { shiftKey: true }));
    expect([on, all]).toEqual([true, true]);
  });
});

describe('reserved keys for site layers', () => {
  it("are the core's plus those of the plugins the manifest enables (and the autoStart ones)", () => {
    const none = reservedKeys({});
    for (const k of CORE_KEYS) expect(none.has(k)).toBe(true);
    expect(none.has('L')).toBe(true); // wall plates start on any model that has them
    expect(none.has('P')).toBe(false);
    const all = reservedKeys({
      plugins: {
        pins: { registry: 'r.json' },
        faults: { devices: 'd.json' },
        lights: {},
        blueprints: { index: 'i.json' },
      },
    });
    for (const k of ['P', 'V', 'T', 'B', 'L']) expect(all.has(k)).toBe(true);
    expect(all.has('K')).toBe(false);
  });
});

const st = (entity_id: string, state: string, attributes = {}): EntityState => ({ entity_id, state, attributes });

describe('the entity store', () => {
  it('takes a connector’s entities, notifies only for real changes, and keeps identity', () => {
    const s = createStore();
    const h = s.addConnector({ id: 'ha', name: 'HA', call: async () => {} });
    const seen: string[][] = [];
    s.onChange((c) => seen.push(c.changed));
    const a = st('light.a', 'on'),
      b = st('light.b', 'off');
    h.replace({ 'light.a': a, 'light.b': b });
    h.replace({ 'light.a': a, 'light.b': b }); // nothing changed
    h.replace({ 'light.a': a, 'light.b': st('light.b', 'on') });
    expect(seen).toEqual([['light.a', 'light.b'], ['light.b']]);
    expect(s.get('light.a')).toBe(a);
    expect(s.sourceOf('light.b')).toBe('ha');
  });

  it('filters change listeners by entity', () => {
    const s = createStore();
    const h = s.addConnector({ id: 'ha', name: 'HA', call: async () => {} });
    const f = vi.fn();
    s.onChange(f, ['light.b']);
    h.update([st('light.a', 'on')]);
    expect(f).not.toHaveBeenCalled();
    h.update([st('light.b', 'on')]);
    expect(f).toHaveBeenCalledOnce();
  });

  it('removes entities a connector no longer reports, and drops all of them when it goes', () => {
    const s = createStore();
    const h = s.addConnector({ id: 'ha', name: 'HA', call: async () => {} });
    h.replace({ 'light.a': st('light.a', 'on'), 'light.b': st('light.b', 'on') });
    h.replace({ 'light.a': st('light.a', 'on') });
    expect(s.get('light.b')).toBeUndefined();
    h.dispose();
    expect(Object.keys(s.entities())).toEqual([]);
    expect(s.connectors()).toEqual([]);
  });

  it('routes call() to the connector that owns each entity, split across connectors', async () => {
    const s = createStore();
    const haCall = vi.fn(async () => {}),
      mqttCall = vi.fn(async () => {});
    s.addConnector({ id: 'ha', name: 'HA', call: haCall }).update([st('light.a', 'on'), st('light.b', 'on')]);
    s.addConnector({ id: 'mqtt', name: 'MQTT', call: mqttCall }).update([st('light.m', 'off')]);
    await s.call(['light.a', 'light.m', 'light.b'], 'turn_off');
    expect(haCall).toHaveBeenCalledWith(['light.a', 'light.b'], 'turn_off', undefined);
    expect(mqttCall).toHaveBeenCalledWith(['light.m'], 'turn_off', undefined);
  });

  it('refuses a call for an entity no connector has, and passes on a connector’s refusal', async () => {
    const s = createStore();
    s.addConnector({
      id: 'ha',
      name: 'HA',
      call: async () => {},
      refusal: (ids) => (ids.includes('switch.heater') ? 'not allowed' : null),
    }).update([st('light.a', 'on'), st('switch.heater', 'on')]);
    await expect(s.call('light.zzz', 'toggle')).rejects.toThrow(/no connector/);
    expect(s.refusal('switch.heater', 'toggle')).toBe('not allowed');
    expect(s.refusal('light.a', 'toggle')).toBeNull();
  });

  it('a second connector cannot take over another one’s entity', () => {
    const s = createStore();
    s.addConnector({ id: 'ha', name: 'HA', call: async () => {} }).update([st('light.a', 'on')]);
    s.addConnector({ id: 'evil', name: 'Evil', call: async () => {} }).update([st('light.a', 'off')]);
    expect(s.get('light.a')!.state).toBe('on');
    expect(s.sourceOf('light.a')).toBe('ha');
  });

  it('tracks connector status: live() and mock(), and simulate() reaches only mock connectors', () => {
    const s = createStore();
    const sim = vi.fn();
    const h = s.addConnector({ id: 'ha', name: 'HA', call: async () => {}, simulate: sim });
    expect(s.live()).toBe(false);
    s.simulate([st('x.y', '1')]);
    expect(sim).not.toHaveBeenCalled();
    h.status('mock');
    expect(s.live()).toBe(true);
    expect(s.mock()).toBe(true);
    s.simulate([st('x.y', '1')]);
    expect(sim).toHaveBeenCalledOnce();
    h.status('error', 'login expired');
    expect(s.connectors()[0]).toEqual({ id: 'ha', name: 'HA', status: 'error', detail: 'login expired' });
  });

  it('binds references to entities; a mock binding gives way to a real one that names an entity', async () => {
    const s = createStore();
    const mock = s.bind({ ref: 'fixture:den', entities: ['light.mock_den'], conf: 'mock' });
    expect(s.entitiesOf('fixture:den')).toEqual(['light.mock_den']);
    const empty = s.bind({ ref: 'fixture:den', entities: [], conf: 'high', src: 'none yet' });
    expect(s.entitiesOf('fixture:den')).toEqual(['light.mock_den']); // a map entry with no entity: the mock still stands in
    s.bind({ ref: 'fixture:den', entities: ['light.den'], conf: 'high' });
    expect(s.entitiesOf('fixture:den')).toEqual(['light.den']);
    expect(s.refsOf('light.den')).toEqual(['fixture:den']);
    const notified = vi.fn();
    s.onBindings(notified);
    mock.dispose();
    empty.dispose();
    await Promise.resolve();
    expect(notified).toHaveBeenCalledOnce(); // coalesced
    expect(s.refsOf('light.mock_den')).toEqual([]);
  });

  it('keeps a numeric history for sparklines', () => {
    const s = createStore();
    const h = s.addConnector({ id: 'ha', name: 'HA', call: async () => {} });
    h.update([{ entity_id: 'sensor.p', state: '100', attributes: {}, last_updated: '2026-10-03T10:00:00Z' }]);
    h.update([{ entity_id: 'sensor.p', state: '250', attributes: {}, last_updated: '2026-10-03T10:00:05Z' }]);
    h.update([{ entity_id: 'sensor.p', state: 'unavailable', attributes: {}, last_updated: '2026-10-03T10:00:09Z' }]);
    expect(s.recent('sensor.p').map((x) => x.v)).toEqual([100, 250, null]); // 'unavailable' is a gap, not a number
  });

  it('history() asks the owning connector, else filters what the page has seen', async () => {
    const s = createStore();
    const asked: unknown[] = [];
    const h = s.addConnector({
      id: 'ha',
      name: 'HA',
      call: async () => {},
      history: async (id, from, to) => (asked.push([id, from, to]), [{ t: from, state: '1.5', v: 1.5 }]),
    });
    h.update([{ entity_id: 'sensor.kwh', state: '3', attributes: {}, last_updated: '2026-10-03T10:00:00Z' }]);
    const t0 = Date.parse('2026-10-03T00:00:00Z'),
      t1 = Date.parse('2026-10-03T23:00:00Z');
    expect((await s.history('sensor.kwh', t0, t1)).map((p) => p.v)).toEqual([3]); // not live yet: what the page saw, filtered
    h.status('live');
    expect(await s.history('sensor.kwh', t0, t1)).toEqual([{ t: t0, state: '1.5', v: 1.5 }]);
    expect(asked).toEqual([['sensor.kwh', t0, t1]]);
  });

  it('scoped() collects registrations for a plugin’s disposal', () => {
    const s = createStore();
    const own: { dispose(): void }[] = [];
    const scoped = s.scoped('lights', (d) => own.push(d));
    scoped.bind({ ref: 'fixture:x', entities: ['light.x'] });
    expect(s.bindingsOf('fixture:x')[0].source).toBe('lights');
    for (const d of own) d.dispose();
    expect(s.bindingsOf('fixture:x')).toEqual([]);
  });
});
