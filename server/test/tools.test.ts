// The house tools over the real gate, the example policy and the mock Home Assistant, with a fake ToolEnv.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createGate, type Gate } from '../src/core/gate.ts';
import { createMockHa, type MockHa } from '../src/core/ha-mock.ts';
import { loadSite } from '../src/core/knowledge.ts';
import { EMPTY_POLICY, parsePolicy } from '../src/core/policy.ts';
import { createTools, ToolInputError, type ToolDeps } from '../src/core/tools.ts';
import type { PendingAction, ToolEnv, ToolSpec, TurnInfo } from '../src/core/types.ts';
import { EXAMPLE_POLICY } from './policy-fixture.ts';

const site = loadSite(resolve(import.meta.dirname, '../../examples/demo-site'));

interface Rig {
  ha: MockHa;
  gate: Gate;
  tools: Record<string, ToolSpec>;
  dataDir: string;
  /** what to do when a confirmation is parked */
  answer: { fn: (p: PendingAction, gate: Gate) => void };
}

function rig(opts: { ttlMs?: number; deps?: Partial<ToolDeps> } = {}): Rig {
  const ha = createMockHa();
  const answer: Rig['answer'] = { fn: () => {} };
  const gate: Gate = createGate({
    policy: parsePolicy(EXAMPLE_POLICY),
    backend: ha,
    ttlMs: opts.ttlMs,
    onPending: (p) => queueMicrotask(() => answer.fn(p, gate)),
    onResolved: () => {},
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-tools-'));
  const list = createTools({ gate, ha, site, dataDir, ...opts.deps });
  return { ha, gate, tools: Object.fromEntries(list.map((t) => [t.name, t])), dataDir, answer };
}

function env(turn: Partial<TurnInfo> = {}, viewReply = { ok: true } as { ok: boolean; detail?: string }) {
  const chips: { summary: string; status: string; subject?: string }[] = [];
  const views: { op: string; args: Record<string, unknown> }[] = [];
  const e: ToolEnv = {
    turn: { turnId: 't1', clientId: 'tab-1', user: 'tester', surface: 'screen', text: 'test', viewer: true, ...turn },
    async view(op, args) {
      views.push({ op, args });
      return viewReply;
    },
    activity: (summary, status, subject) => void chips.push({ summary, status, subject }),
  };
  return { e, chips, views };
}

const run = async (r: Rig, name: string, args: Record<string, unknown>, en = env()) => {
  const out = await r.tools[name].run(args, en.e);
  return typeof out === 'string' ? out : JSON.parse(JSON.stringify(out));
};

describe('tool specs', () => {
  it('have [a-z_]+ names, descriptions and no raw service-call tool', () => {
    const r = rig();
    const names = Object.keys(r.tools);
    for (const n of names) expect(n).toMatch(/^[a-z_]+$/);
    for (const t of Object.values(r.tools)) expect(t.description.length).toBeGreaterThan(20);
    expect(names.sort()).toEqual(
      [
        'ha_act',
        'ha_find',
        'ha_history',
        'ha_state',
        'ha_weather',
        'memory_forget',
        'memory_save',
        'memory_search',
        'registry_get',
        'site_rooms',
        'site_search',
        'view_fly',
        'view_highlight',
        'view_layer',
        'view_where',
      ].sort(),
    );
  });
});

describe('ha_find', () => {
  it('resolves words to entities with area, state, subject and policy tier', async () => {
    const r = rig();
    const out = await run(r, 'ha_find', { query: 'kitchen pendants' });
    const ids = out.matches.map((m: { entity_id: string }) => m.entity_id);
    expect(ids).toEqual(['light.kitchen_pendant_1', 'light.kitchen_pendant_2', 'light.kitchen_pendant_3']);
    expect(out.matches[0]).toMatchObject({
      name: 'Kitchen pendant 1',
      area: 'Kitchen',
      state: 'off',
      subject: 'fixture:kitchen.pendant.1',
      policy: { turn_on: 'allow', turn_off: 'allow' },
    });
  });

  it('finds the thermostat by a common word, and says it needs confirmation', async () => {
    const r = rig();
    const out = await run(r, 'ha_find', { query: 'thermostat', domain: 'climate' });
    expect(out.matches[0].entity_id).toBe('climate.hall_thermostat');
    expect(out.matches[0].policy.set_temperature).toMatch(/^confirm/);
    const lock = await run(r, 'ha_find', { query: 'front door lock' });
    expect(lock.matches[0].policy).toMatchObject({ unlock: expect.stringMatching(/^deny/) });
  });

  it('finds the weather entity for "weather" among many sensors named Weather station …', async () => {
    const r = rig();
    // the live house: weather.forecast_home ("Forecast Home") and a dozen weather-station sensors
    r.ha.entities.set('weather.forecast_home', {
      entity_id: 'weather.forecast_home',
      state: 'partlycloudy',
      attributes: { friendly_name: 'Forecast Home', temperature: 84 },
    });
    for (let i = 0; i < 12; i++)
      r.ha.entities.set(`sensor.weather_station_${i}`, {
        entity_id: `sensor.weather_station_${i}`,
        state: '1',
        attributes: { friendly_name: `Weather station reading ${i}` },
      });
    const out = await run(r, 'ha_find', { query: 'weather' });
    expect(out.matches[0].entity_id).toBe('weather.forecast_home');
    // and "kitchen lights" still ranks the kitchen's lights first
    const k = await run(r, 'ha_find', { query: 'kitchen lights' });
    expect(k.matches[0].entity_id).toMatch(/^light\.kitchen/);
    expect(k.matches.every((m: { entity_id: string }) => m.entity_id.startsWith('light.kitchen'))).toBe(true);
  });

  it('says when nothing matches, and checks its input', async () => {
    const r = rig();
    expect((await run(r, 'ha_find', { query: 'zebra' })).matches).toEqual([]);
    await expect(run(r, 'ha_find', {})).rejects.toBeInstanceOf(ToolInputError);
  });
});

describe('ha_state / ha_history', () => {
  it('returns states with the useful attributes only', async () => {
    const r = rig();
    const out = await run(r, 'ha_state', { entity_ids: ['climate.hall_thermostat', 'light.nope'] });
    expect(out[0]).toMatchObject({ entity_id: 'climate.hall_thermostat', state: 'heat', temperature: 70 });
    expect(out[0].min_temp).toBeUndefined();
    expect(out[1]).toEqual({ entity_id: 'light.nope', error: 'no such entity' });
    await expect(run(r, 'ha_state', { entity_ids: ['not an id'] })).rejects.toThrow(/not valid ids/);
    await expect(
      run(r, 'ha_state', { entity_ids: Array.from({ length: 21 }, (_, i) => `light.x${i}`) }),
    ).rejects.toThrow(/at most 20/);
  });

  it('summarises numbers and on/off history', async () => {
    const now = new Date('2026-07-01T12:00:00Z');
    const r = rig({ deps: { now: () => now } });
    const t = await run(r, 'ha_history', { entity_id: 'sensor.outdoor_temperature', hours: 24 });
    expect(t.points).toBe(25);
    expect(t.min.value).toBeLessThanOrEqual(t.mean);
    expect(t.max.value).toBeGreaterThanOrEqual(t.mean);
    const l = await run(r, 'ha_history', { entity_id: 'light.hall', hours: 1000 });
    expect(l.hours).toBe(168);
    expect(l.changes).toBeGreaterThan(0);
    expect(l.recent.length).toBeLessThanOrEqual(20);
  });
});

describe('ha_weather', () => {
  const FIELDS = [
    'datetime',
    'condition',
    'temperature',
    'templow',
    'precipitation_probability',
    'precipitation',
    'wind_speed',
  ];

  it('defaults to the weather entity and daily: the current conditions and 7 trimmed days, even with a deny-all policy', async () => {
    const r = rig();
    r.gate.setPolicy(EMPTY_POLICY);
    const en = env();
    const out = await run(r, 'ha_weather', {}, en);
    expect(out).toMatchObject({
      entity_id: 'weather.home',
      name: 'Home',
      condition: 'partlycloudy',
      temperature: 81,
      temperature_unit: '°F',
      humidity: 64,
      type: 'daily',
    });
    expect(out.forecast).toHaveLength(7);
    for (const f of out.forecast) for (const k of Object.keys(f)) expect(FIELDS).toContain(k);
    expect(out.forecast[0]).toHaveProperty('templow');
    expect(out.forecast[0]).not.toHaveProperty('wind_bearing');
    expect(en.chips).toEqual([
      { summary: 'Reading the forecast', status: 'running', subject: undefined },
      { summary: 'Reading the forecast', status: 'done', subject: undefined },
    ]);
    expect(r.ha.responds).toEqual([
      { domain: 'weather', service: 'get_forecasts', data: { entity_id: ['weather.home'], type: 'daily' } },
    ]);
    expect(r.ha.calls).toEqual([]);
  });

  it('hourly: 12 entries; a named entity', async () => {
    const r = rig();
    const out = await run(r, 'ha_weather', { entity_id: 'weather.home', type: 'hourly' });
    expect(out.type).toBe('hourly');
    expect(out.forecast).toHaveLength(12);
    expect(out.forecast[0]).not.toHaveProperty('templow');
    expect(r.ha.calls).toEqual([]);
  });

  it('no weather entity, an unknown one, bad input, HA failing', async () => {
    const r = rig();
    expect(await run(r, 'ha_weather', { entity_id: 'weather.nowhere' })).toEqual({
      error: 'no such entity: weather.nowhere',
    });
    await expect(run(r, 'ha_weather', { entity_id: 'light.hall' })).rejects.toThrow(ToolInputError);
    await expect(run(r, 'ha_weather', { type: 'twice_daily' })).rejects.toThrow(/daily or hourly/);
    r.ha.respond = async () => {
      throw new Error('weather service down');
    };
    expect(await run(r, 'ha_weather', {})).toBe('Home Assistant failed: weather service down');
    r.ha.entities.delete('weather.home');
    const en = env();
    expect(await run(r, 'ha_weather', {}, en)).toEqual({ error: 'Home Assistant has no weather entity' });
    expect(en.chips.at(-1)).toMatchObject({ status: 'error' });
    expect(r.ha.calls).toEqual([]);
  });

  it('ha_act cannot reach the forecast service', async () => {
    const r = rig();
    const out = await run(r, 'ha_act', {
      entity_ids: ['weather.home'],
      service: 'get_forecasts',
      data: { type: 'daily' },
    });
    expect(out).toMatch(/^refused: weather\.get_forecasts returns data and changes nothing: use the read tool/);
    expect(r.ha.responds).toEqual([]);
    expect(r.ha.calls).toEqual([]);
  });

  it('a gate refusal comes back as refused', async () => {
    const r = rig();
    r.gate.read = async () => ({ status: 'refused', reason: 'not today' });
    const en = env();
    expect(await run(r, 'ha_weather', {}, en)).toBe('refused: not today');
    expect(en.chips.at(-1)).toMatchObject({ summary: 'Forecast refused', status: 'refused' });
  });
});

describe('ha_act', () => {
  it('allow: done, the light is on, chips running → done', async () => {
    const r = rig();
    const en = env();
    const out = await run(r, 'ha_act', { entity_ids: ['light.kitchen_pendant_1'], service: 'turn_on' }, en);
    expect(out).toMatch(/^done: /);
    expect(r.ha.entities.get('light.kitchen_pendant_1')!.state).toBe('on');
    expect(en.chips.map((c) => c.status)).toEqual(['running', 'done']);
    expect(en.chips[0].subject).toBe('fixture:kitchen.pendant.1');
  });

  it('deny: refused with the reason, nothing called', async () => {
    const r = rig();
    const en = env();
    const out = await run(r, 'ha_act', { entity_ids: ['lock.front_door'], service: 'unlock' }, en);
    expect(out).toBe('refused: Unlocking is never done by the assistant');
    expect(r.ha.calls).toEqual([]);
    expect(en.chips.at(-1)!.status).toBe('refused');
  });

  it('confirm: approved → done; declined → the person declined', async () => {
    const r = rig();
    r.answer.fn = (p, g) => g.reply(p.id, p.clientId, true);
    const req = { entity_ids: ['climate.hall_thermostat'], service: 'set_temperature', data: { temperature: 72 } };
    expect(await run(r, 'ha_act', req)).toMatch(/^done: /);
    expect(r.ha.entities.get('climate.hall_thermostat')!.attributes.temperature).toBe(72);
    r.answer.fn = (p, g) => g.reply(p.id, p.clientId, false);
    expect(await run(r, 'ha_act', { ...req, data: { temperature: 65 } })).toMatch(/^the person declined/);
    expect(r.ha.entities.get('climate.hall_thermostat')!.attributes.temperature).toBe(72);
  });

  it('confirm: nobody answers → nobody confirmed within the TTL', async () => {
    const r = rig({ ttlMs: 20, deps: { confirmTtlMs: 30_000 } });
    const out = await run(r, 'ha_act', {
      entity_ids: ['climate.hall_thermostat'],
      service: 'set_temperature',
      data: { temperature: 72 },
    });
    expect(out).toMatch(/^nobody confirmed within 30 s/);
  });

  it('Home Assistant failing → Home Assistant failed', async () => {
    const r = rig();
    r.ha.callService = async () => {
      throw new Error('boom');
    };
    expect(await run(r, 'ha_act', { entity_ids: ['light.hall'], service: 'turn_on' })).toBe(
      'Home Assistant failed: boom',
    );
  });

  it('checks its input before the gate', async () => {
    const r = rig();
    await expect(run(r, 'ha_act', { entity_ids: [], service: 'turn_on' })).rejects.toThrow(/non-empty list/);
    await expect(run(r, 'ha_act', { entity_ids: ['light.hall'], service: 'light.turn_on' })).rejects.toThrow(/service/);
    await expect(run(r, 'ha_act', { entity_ids: ['light.hall'], service: 'turn_on', data: [1] })).rejects.toThrow(
      /data/,
    );
  });
});

describe('site tools', () => {
  it('site_search returns hits with subjects and room names', async () => {
    const out = await run(rig(), 'site_search', { query: 'water heater' });
    expect(out[0]).toMatchObject({ id: 'plumb.water-heater', subject: 'pins:plumb.water-heater', room: 'Kitchen' });
  });

  it('site_rooms lists the rooms with storeys and items', async () => {
    const out = await run(rig(), 'site_rooms', {});
    expect(out).toHaveLength(8);
    expect(out.find((r: { id: string }) => r.id === 'kitchen')).toMatchObject({
      storey: 'ground floor',
      subject: 'room:kitchen',
      fixtures: 3,
    });
  });

  it('registry_get by id or subject; a near miss suggests', async () => {
    const r = rig();
    expect(await run(r, 'registry_get', { id: 'pins:net.router' })).toMatchObject({
      name: 'Router',
      room: 'Study',
      subject: 'pins:net.router',
    });
    expect(await run(r, 'registry_get', { id: 'water-heater' })).toMatchObject({
      error: 'no registry item water-heater',
      did_you_mean: ['plumb.water-heater'],
    });
  });
});

describe('view tools', () => {
  it('forward to env.view and report the result', async () => {
    const r = rig();
    const en = env();
    expect(await run(r, 'view_fly', { subject: 'pins:plumb.water-heater' }, en)).toBe(
      'showing pins:plumb.water-heater',
    );
    expect(await run(r, 'view_highlight', { subjects: ['fixture:hall.pendant'] }, en)).toBe('highlighted 1');
    expect(await run(r, 'view_layer', { layer: 'furniture', on: false }, en)).toMatch(/^hiding furniture/);
    expect(en.views).toEqual([
      { op: 'fly', args: { subject: 'pins:plumb.water-heater' } },
      { op: 'highlight', args: { subjects: ['fixture:hall.pendant'], seconds: 6 } },
      { op: 'layer', args: { layer: 'furniture', on: false } },
    ]);
    const none = env({}, { ok: false, detail: 'no viewer attached' });
    expect(await run(r, 'view_fly', { subject: 'room:hall' }, none)).toBe('could not show it: no viewer attached');
    await expect(run(r, 'view_fly', { subject: 'water heater' }, en)).rejects.toThrow(/kind:id/);
  });

  it('view_where returns the turn view context', async () => {
    const out = await run(
      rig(),
      'view_where',
      {},
      env({ view: { room: 'kitchen', selected: 'pins:appliance.fridge' } }),
    );
    expect(out).toMatchObject({
      viewer: true,
      room: { id: 'kitchen', name: 'Kitchen', subject: 'room:kitchen' },
      selected: 'pins:appliance.fridge',
    });
  });
});

describe('memory', () => {
  let r: Rig;
  beforeEach(() => (r = rig()));

  it('saves, finds, lists, replaces and forgets notes under memory/house only', async () => {
    const dir = join(r.dataDir, 'memory', 'house');
    expect(await run(r, 'memory_save', { name: 'Lounge evening', text: 'Lounge lights at 40% in the evening' })).toBe(
      'saved lounge-evening',
    );
    expect(await run(r, 'memory_save', { name: 'big lamp', text: '"the big lamp" means light.floor_lamp' })).toBe(
      'saved big-lamp',
    );
    expect(await run(r, 'memory_save', { name: 'big lamp', text: '"the big lamp" is the floor lamp' })).toBe(
      'updated big-lamp',
    );
    expect(readdirSync(dir).sort()).toEqual(['MEMORY.md', 'big-lamp.md', 'lounge-evening.md']);
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf8')).toContain('[big-lamp](big-lamp.md)');
    expect(await run(r, 'memory_search', { query: 'lamp' })).toEqual([
      { name: 'big-lamp', text: '"the big lamp" is the floor lamp' },
    ]);
    expect(await run(r, 'memory_search', {})).toHaveLength(2);
    expect(await run(r, 'memory_forget', { name: 'big lamp' })).toBe('forgot big-lamp');
    expect(await run(r, 'memory_forget', { name: 'big lamp' })).toBe('there is no memory called big-lamp');
    expect(await run(r, 'memory_search', { query: 'lamp' })).toBe('nothing remembered about that');
  });

  it('sanitises names so nothing is written outside the folder', async () => {
    expect(await run(r, 'memory_save', { name: '../../etc/passwd', text: 'x' })).toBe('saved etc-passwd');
    expect(existsSync(join(r.dataDir, 'memory', 'house', 'etc-passwd.md'))).toBe(true);
    expect(readdirSync(r.dataDir)).toEqual(['memory']);
    await expect(run(r, 'memory_save', { name: '../..', text: 'x' })).rejects.toThrow(/letters or digits/);
    await expect(run(r, 'memory_save', { name: 'MEMORY', text: 'x' })).rejects.toThrow(/reserved/);
    await expect(run(r, 'memory_save', { name: 'big', text: 'x'.repeat(5000) })).rejects.toThrow(/at most 4000/);
  });
});
