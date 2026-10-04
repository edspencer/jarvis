// The policy: strict parsing, default deny, first match, strictest tier, bounds, data keys, max_minutes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_POLICY,
  OFF_SERVICE,
  describeCalls,
  describeRequest,
  evaluatePolicy,
  globMatch,
  parsePolicy,
  requestProblem,
} from '../src/core/policy.ts';
import type { Policy } from '../src/core/policy.ts';
import { createMockHa } from '../src/core/ha-mock.ts';
import type { ActRequest, HaState } from '../src/core/types.ts';
import type { Surface } from '../src/core/protocol.ts';
import { EXAMPLE_POLICY } from './policy-fixture.ts';

const states = createMockHa().entities;
const policy = parsePolicy(EXAMPLE_POLICY, 'example');
const ev = (req: ActRequest, surface: Surface = 'screen', p: Policy = policy, st = states) =>
  evaluatePolicy(p, req, { surface, states: st });
const bad = (obj: unknown) => {
  try {
    parsePolicy(obj, 'test');
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('parsed');
};
const rules = (...r: unknown[]) => ({ version: 1, rules: r });

describe('parsePolicy', () => {
  it('parses the example', () => {
    expect(policy.default).toBe('deny');
    expect(policy.bulk).toEqual({ confirm_over: 8 });
    expect(policy.rules).toHaveLength(EXAMPLE_POLICY.rules.length);
    expect(policy.rules[0]).toMatchObject({
      tier: 'deny',
      match: { domain: ['lock'], service: ['unlock'] },
      reason: 'Unlocking is never done by the assistant',
      at: 'rules[0]',
    });
    expect(policy.rules[4].risk).toBe('high');
    expect(policy.rules[7].bounds).toEqual({ temperature: [60, 85] });
    expect(policy.rules[7].data).toEqual(['hvac_mode']);
    expect(policy.rules[15].max_minutes).toBe(60);
  });

  it('server/policy.example.yaml is the same policy (when the server has its yaml package)', async (ctx) => {
    let YAML: { parse(s: string): unknown } | undefined;
    try {
      const name = 'yaml';
      YAML = (await import(/* @vite-ignore */ name)).default;
    } catch {
      ctx.skip();
    }
    const text = readFileSync(new URL('../policy.example.yaml', import.meta.url), 'utf8');
    expect(parsePolicy(YAML!.parse(text))).toEqual(parsePolicy(EXAMPLE_POLICY));
  });

  it('absent default means deny; an empty file is the empty policy', () => {
    expect(parsePolicy({ version: 1 }).rules).toEqual([]);
    expect(parsePolicy(null).rules).toEqual([]);
    expect(parsePolicy(undefined).default).toBe('deny');
  });

  it('rejects default: allow (deny is the only accepted default)', () => {
    expect(bad({ version: 1, default: 'allow' })).toMatch(/default: must be deny/);
    expect(bad({ version: 1, default: 'confirm' })).toMatch(/default: must be deny/);
  });

  it('rejects unknown keys at every level, with their paths, all at once', () => {
    const msg = bad({
      version: 1,
      defualt: 'deny',
      bulk: { confirm_over: 3, max: 1 },
      rules: [
        { allow: { domain: 'light' } },
        { allow: { domain: 'light' }, limits: { max_minutes: 5 } },
        { allow: { domain: 'light' } },
        { confirm: { domain: 'climate', servce: 'set_temperature' } },
      ],
    });
    expect(msg).toContain('defualt: unknown key');
    expect(msg).toContain('bulk.max: unknown key');
    expect(msg).toContain('rules[1].limits: unknown key');
    expect(msg).toContain('rules[3].confirm.servce: unknown key');
    expect(msg).toContain('invalid policy test');
  });

  it('rejects a bad version, a non-list rules, a non-mapping policy', () => {
    expect(bad({ version: 2 })).toMatch(/version: must be 1/);
    expect(bad({})).toMatch(/version: must be 1/);
    expect(bad({ version: 1, rules: {} })).toMatch(/rules: must be a list/);
    expect(bad([1])).toMatch(/must be a mapping/);
    expect(bad('allow everything')).toMatch(/must be a mapping/);
  });

  it('rejects bad tiers and more than one tier in a rule', () => {
    expect(bad(rules({ permit: { domain: 'light' } }))).toMatch(/rules\[0\]\.permit: unknown key/);
    expect(bad(rules({ permit: { domain: 'light' } }))).toMatch(/rules\[0\]: needs one of allow/);
    expect(bad(rules({ reason: 'x' }))).toMatch(/needs one of allow \/ confirm \/ deny/);
    expect(bad(rules({ allow: { domain: 'lock' }, deny: { domain: 'lock' } }))).toMatch(
      /rules\[0\]: has allow and deny: exactly one tier/,
    );
    expect(bad(rules('allow light'))).toMatch(/rules\[0\]: must be a mapping/);
  });

  it('rejects bad matchers', () => {
    expect(bad(rules({ allow: 'light' }))).toMatch(/rules\[0\]\.allow: must be a mapping/);
    expect(bad(rules({ allow: { service: 'turn_on' } }))).toMatch(/an allow rule needs a domain or an entity/);
    expect(bad(rules({ confirm: { surface: 'screen' } }))).toMatch(/a confirm rule needs a domain or an entity/);
    expect(bad(rules({ deny: {} }))).toMatch(/empty matcher/);
    expect(bad(rules({ allow: { domain: 'Light' } }))).toMatch(/"Light" is not a domain/);
    expect(bad(rules({ allow: { domain: [] } }))).toMatch(/domain: empty list/);
    expect(bad(rules({ allow: { domain: '*' } }))).toMatch(/is not a domain/);
    expect(bad(rules({ allow: { entity: 'light' } }))).toMatch(/not an entity id or glob/);
    expect(bad(rules({ allow: { domain: 'light', service: 'turn-on' } }))).toMatch(/not a service name/);
    expect(bad(rules({ allow: { domain: 'light', surface: 'panel' } }))).toMatch(/not screen or speaker/);
    expect(bad(rules({ allow: { domain: 'light', service: [1] } }))).toMatch(/service\[0\]: 1 is not/);
  });

  it('rejects bad bounds', () => {
    const b = (bounds: unknown) => bad(rules({ allow: { domain: 'light' }, bounds }));
    expect(b({ brightness_pct: [100, 1] })).toMatch(/bounds\.brightness_pct: must be \[min, max\]/);
    expect(b({ brightness_pct: [1] })).toMatch(/must be \[min, max\]/);
    expect(b({ brightness_pct: ['1', 100] })).toMatch(/must be \[min, max\]/);
    expect(b({ brightness_pct: [1, Infinity] })).toMatch(/must be \[min, max\]/);
    expect(b({ brightness_pct: 50 })).toMatch(/must be \[min, max\]/);
    expect(b([1, 2])).toMatch(/bounds: must be a mapping/);
    expect(b({ entity_id: [1, 2] })).toMatch(/entity_id can't be service data/);
    expect(b({ minutes: [1, 2] })).toMatch(/minutes can't be service data/);
    expect(
      parsePolicy(rules({ allow: { domain: 'light', service: 'turn_on' }, bounds: { b: [5, 5] } })).rules[0].bounds,
    ).toEqual({
      b: [5, 5],
    });
  });

  it('rejects bad data, risk, reason, max_minutes and bulk', () => {
    expect(bad(rules({ allow: { domain: 'light' }, data: 'effect' }))).toMatch(/data: must be a list/);
    expect(bad(rules({ allow: { domain: 'light' }, data: ['entity_id'] }))).toMatch(/entity_id can't be/);
    expect(bad(rules({ allow: { domain: 'light' }, data: ['Effect'] }))).toMatch(/data\[0\]: not a data key/);
    expect(bad(rules({ allow: { domain: 'light' }, bounds: { x: [1, 2] }, data: ['x'] }))).toMatch(/already in bounds/);
    expect(bad(rules({ deny: { domain: 'lock' }, data: ['code'] }))).toMatch(/mean nothing on a deny rule/);
    expect(bad(rules({ allow: { domain: 'light' }, risk: 'extreme' }))).toMatch(/risk: must be high or normal/);
    expect(bad(rules({ allow: { domain: 'light' }, reason: '' }))).toMatch(/reason: must be a non-empty string/);
    expect(bad(rules({ allow: { domain: 'switch' }, max_minutes: 0 }))).toMatch(/max_minutes: must be a number > 0/);
    expect(bad(rules({ allow: { domain: 'switch' }, max_minutes: '60' }))).toMatch(/max_minutes: must be a number/);
    expect(bad(rules({ deny: { domain: 'switch' }, max_minutes: 5 }))).toMatch(/max_minutes: means nothing/);
    expect(bad(rules({ allow: { domain: 'switch', service: 'toggle' }, max_minutes: 5 }))).toMatch(
      /toggle can't be timed/,
    );
    expect(bad({ version: 1, bulk: { confirm_over: 0 } })).toMatch(/bulk\.confirm_over: must be an integer/);
    expect(bad({ version: 1, bulk: 8 })).toMatch(/bulk: must be a mapping/);
  });
});

describe('default deny', () => {
  it('the empty policy refuses everything', () => {
    const r = ev({ entity_ids: ['light.hall'], service: 'turn_on' }, 'screen', EMPTY_POLICY);
    expect(r.tier).toBe('deny');
    expect(r.reason).toBe('no rule allows light.hall turn_on');
    expect(r.calls).toEqual([]);
  });

  it('an entity no rule matches is refused', () => {
    expect(ev({ entity_ids: ['sensor.outdoor_temperature'], service: 'turn_on' }).reason).toBe(
      'no rule allows sensor.outdoor_temperature turn_on',
    );
    expect(ev({ entity_ids: ['switch.pond_pump'], service: 'toggle' }).tier).toBe('deny');
  });

  it('an unmatched service on a matched domain is refused', () => {
    const r = ev({ entity_ids: ['light.hall'], service: 'set_brightness' });
    expect(r).toMatchObject({ tier: 'deny', reason: 'no rule allows light.hall set_brightness' });
  });

  it('an entity HA does not know is refused, even in an allowed domain', () => {
    expect(ev({ entity_ids: ['light.does_not_exist'], service: 'turn_on' }).reason).toBe(
      'light.does_not_exist is not a known entity',
    );
    expect(ev({ entity_ids: ['alarm_control_panel.home'], service: 'alarm_disarm' }).tier).toBe('deny');
  });

  it('the policy is the only thing that widens: an allow on one domain says nothing about another', () => {
    const p = parsePolicy(rules({ allow: { domain: 'light', service: 'turn_on' } }));
    expect(ev({ entity_ids: ['light.hall'], service: 'turn_on' }, 'screen', p).tier).toBe('allow');
    expect(ev({ entity_ids: ['switch.pond_pump'], service: 'turn_on' }, 'screen', p).tier).toBe('deny');
    expect(ev({ entity_ids: ['lock.front_door'], service: 'unlock' }, 'screen', p).tier).toBe('deny');
  });
});

describe('the request itself', () => {
  it.each([
    [{ entity_ids: [], service: 'turn_on' }, /no entity_ids/],
    [{ entity_ids: 'light.hall', service: 'turn_on' }, /no entity_ids/],
    [{ entity_ids: ['Light.Hall'], service: 'turn_on' }, /is not an entity id/],
    [{ entity_ids: ['light.hall; rm'], service: 'turn_on' }, /is not an entity id/],
    [{ entity_ids: ['light'], service: 'turn_on' }, /is not an entity id/],
    [{ entity_ids: [7], service: 'turn_on' }, /is not an entity id/],
    [{ entity_ids: ['light.hall', 'light.hall'], service: 'turn_on' }, /light\.hall is named twice/],
    [{ entity_ids: ['light.hall'], service: 'light.turn_on' }, /not a service name/],
    [{ entity_ids: ['light.hall'], service: 'Turn_On' }, /not a service name/],
    [{ entity_ids: ['light.hall'], service: 'turn_on', data: [1] }, /data must be an object/],
    [{ entity_ids: ['light.hall'], service: 'turn_on', data: { entity_id: 'lock.front_door' } }, /entity_id in data/],
    [{ entity_ids: ['light.hall'], service: 'turn_on', data: { area_id: 'kitchen' } }, /area_id in data/],
    [{ entity_ids: ['light.hall'], service: 'turn_on', domain: 'lock' }, /unknown field domain/],
  ])('%j is refused', (req, re) => {
    const r = ev(req as ActRequest);
    expect(r.tier).toBe('deny');
    expect(r.reason).toMatch(re);
    expect(r.calls).toEqual([]);
  });

  it('caps the number of entities', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `light.l${i}`);
    expect(requestProblem({ entity_ids: ids, service: 'turn_on' })).toMatch(/too many entities/);
    expect(requestProblem({ entity_ids: ids.slice(0, 50), service: 'turn_on' })).toBeNull();
  });
});

describe('tiers', () => {
  it('allow: one call per domain, with the data', () => {
    const r = ev({ entity_ids: ['light.kitchen_pendant_1'], service: 'turn_on', data: { brightness_pct: 40 } });
    expect(r.tier).toBe('allow');
    expect(r.calls).toEqual([
      { domain: 'light', service: 'turn_on', data: { entity_id: ['light.kitchen_pendant_1'], brightness_pct: 40 } },
    ]);
    expect(r.timers).toEqual([]);
  });

  it('confirm', () => {
    const r = ev({ entity_ids: ['lock.front_door'], service: 'lock' });
    expect(r).toMatchObject({ tier: 'confirm', reason: 'lock.front_door lock needs confirmation (rules[6])' });
    expect(r.calls).toHaveLength(1);
  });

  it('deny, with the rule reason', () => {
    expect(ev({ entity_ids: ['lock.front_door'], service: 'unlock' })).toMatchObject({
      tier: 'deny',
      reason: 'Unlocking is never done by the assistant',
      calls: [],
    });
    expect(ev({ entity_ids: ['update.kitchen_pendant_1_firmware'], service: 'install' }).tier).toBe('deny');
  });

  it('a deny rule without a reason names the rule', () => {
    const p = parsePolicy(rules({ deny: { domain: 'fan' } }));
    expect(ev({ entity_ids: ['fan.bedroom_fan'], service: 'turn_on' }, 'screen', p).reason).toBe(
      'fan.bedroom_fan turn_on is refused (rules[0])',
    );
  });

  it('the first matching rule wins (in both directions)', () => {
    const allowFirst = parsePolicy(
      rules({ allow: { domain: 'fan', service: 'turn_on' } }, { deny: { domain: 'fan' } }),
    );
    const denyFirst = parsePolicy(rules({ deny: { domain: 'fan' } }, { allow: { domain: 'fan', service: 'turn_on' } }));
    const req = { entity_ids: ['fan.bedroom_fan'], service: 'turn_on' };
    expect(ev(req, 'screen', allowFirst).tier).toBe('allow');
    expect(ev(req, 'screen', denyFirst).tier).toBe('deny');
    // in the example, switch.network_rack is caught by the glob deny before anything else
    expect(ev({ entity_ids: ['switch.network_rack'], service: 'turn_off' }).reason).toBe(
      'That switch powers the network or a camera',
    );
  });

  it('the strictest entity decides; any deny refuses the whole call (nothing half done)', () => {
    const mixed = ev({ entity_ids: ['light.hall', 'lock.front_door'], service: 'lock' });
    expect(mixed.tier).toBe('deny'); // no rule allows light.hall lock
    const confirmAndAllow = ev({ entity_ids: ['light.hall', 'script.goodnight'], service: 'turn_on' });
    expect(confirmAndAllow.tier).toBe('confirm');
    expect(confirmAndAllow.reason).toBe('Good night turns off every light in the house');
    expect(confirmAndAllow.calls.map((c) => c.domain)).toEqual(['light', 'script']);
    const withDeny = ev({ entity_ids: ['light.hall', 'switch.network_rack', 'script.goodnight'], service: 'turn_off' });
    expect(withDeny.tier).toBe('deny');
    expect(withDeny.calls).toEqual([]);
    expect(withDeny.reason).toContain('That switch powers the network or a camera');
  });

  it('bulk: more than confirm_over entities upgrades allow to confirm', () => {
    const lights = [...states.keys()].filter((k) => k.startsWith('light.'));
    expect(lights.length).toBeGreaterThan(8);
    expect(ev({ entity_ids: lights.slice(0, 8), service: 'turn_off' }).tier).toBe('allow');
    const r = ev({ entity_ids: lights.slice(0, 9), service: 'turn_off' });
    expect(r.tier).toBe('confirm');
    expect(r.reason).toBe('more than 8 entities in one call');
    // bulk never downgrades a deny
    expect(ev({ entity_ids: [...lights.slice(0, 9), 'lock.front_door'], service: 'turn_off' }).tier).toBe('deny');
  });

  it('risk comes from the rule', () => {
    expect(ev({ entity_ids: ['cover.garage_door'], service: 'close_cover' }).risk).toBe('high');
    expect(ev({ entity_ids: ['lock.front_door'], service: 'lock' }).risk).toBe('normal');
  });
});

describe('matchers', () => {
  it('device_class comes from the entity state', () => {
    expect(ev({ entity_ids: ['cover.garage_door'], service: 'open_cover' }).reason).toBe(
      "The assistant doesn't open the garage door",
    );
    // the same cover without a device class is not a garage door: no rule allows it
    const st = new Map(states);
    st.set('cover.garage_door', { ...states.get('cover.garage_door')!, attributes: { friendly_name: 'Door' } });
    expect(ev({ entity_ids: ['cover.garage_door'], service: 'open_cover' }, 'screen', policy, st).reason).toBe(
      'no rule allows cover.garage_door open_cover',
    );
  });

  it('surface: closing the garage asks on a screen and is refused from a speaker', () => {
    expect(ev({ entity_ids: ['cover.garage_door'], service: 'close_cover' }, 'screen').tier).toBe('confirm');
    expect(ev({ entity_ids: ['cover.garage_door'], service: 'close_cover' }, 'speaker')).toMatchObject({
      tier: 'deny',
      reason: 'The garage door can only be closed from a screen',
    });
  });

  it('entity globs', () => {
    expect(globMatch('switch.*network*', 'switch.network_rack')).toBe(true);
    expect(globMatch('switch.*network*', 'switch.home_network')).toBe(true);
    expect(globMatch('switch.*network*', 'light.network')).toBe(false);
    expect(globMatch('switch.*', 'switch.x')).toBe(true);
    expect(globMatch('switch.pond_pump', 'switch.pond_pump_2')).toBe(false);
    // `.` is literal, not "any character"
    expect(globMatch('switch.a', 'switchxa')).toBe(false);
    const p = parsePolicy(rules({ allow: { entity: 'light.kitchen_*', service: 'turn_on' } }));
    expect(ev({ entity_ids: ['light.kitchen_pendant_2'], service: 'turn_on' }, 'screen', p).tier).toBe('allow');
    expect(ev({ entity_ids: ['light.hall'], service: 'turn_on' }, 'screen', p).tier).toBe('deny');
  });

  it("service '*' (deny only) and lists", () => {
    const p = parsePolicy(
      rules({ deny: { domain: 'fan', service: '*' } }, { allow: { domain: ['fan', 'light'], service: ['turn_on'] } }),
    );
    expect(ev({ entity_ids: ['fan.bedroom_fan'], service: 'turn_on' }, 'screen', p).tier).toBe('deny');
    expect(ev({ entity_ids: ['light.hall'], service: 'turn_on' }, 'screen', p).tier).toBe('allow');
    expect(ev({ entity_ids: ['light.hall'], service: 'toggle' }, 'screen', p).tier).toBe('deny');
  });

  it('allow and confirm rules must name their services, and never with *', () => {
    expect(bad(rules({ allow: { domain: 'light' } }))).toMatch(/rules\[0\]\.allow: an allow rule needs a service/);
    expect(bad(rules({ confirm: { entity: 'script.goodnight' } }))).toMatch(/a confirm rule needs a service/);
    expect(bad(rules({ allow: { domain: 'script', service: '*' } }))).toMatch(
      /rules\[0\]\.allow\.service: '\*' is only allowed on a deny rule/,
    );
    expect(bad(rules({ confirm: { domain: 'light', service: ['turn_on', '*'] } }))).toMatch(/only allowed on a deny/);
    // a rule without a service would have let the model run any script with any service
    expect(bad(rules({ allow: { domain: 'script' } }))).toMatch(/needs a service/);
    expect(parsePolicy(rules({ deny: { domain: 'script', service: '*' } })).rules).toHaveLength(1);
    expect(parsePolicy(rules({ deny: { domain: 'script' } })).rules).toHaveLength(1);
  });

  it('the example asks before any script but the named harmless one', () => {
    expect(ev({ entity_ids: ['script.film_night'], service: 'turn_on' }).tier).toBe('allow');
    expect(ev({ entity_ids: ['script.goodnight'], service: 'turn_on' })).toMatchObject({
      tier: 'confirm',
      reason: 'Good night turns off every light in the house',
    });
    expect(ev({ entity_ids: ['script.film_night'], service: 'turn_off' }).tier).toBe('deny');
    expect(ev({ entity_ids: ['script.film_night'], service: 'toggle' }).tier).toBe('deny');
  });

  it('the service always runs in the entity’s own domain: generic homeassistant.* calls cannot be made', () => {
    // even an allow on everything in a domain only ever yields <entity's domain>.<service>
    const p = parsePolicy(rules({ allow: { domain: 'light', service: ['turn_on', 'turn_off'] } }));
    const r = ev({ entity_ids: ['light.hall'], service: 'turn_off' }, 'screen', p);
    expect(r.calls[0].domain).toBe('light');
    // and "homeassistant.turn_off" isn't a service name at all
    expect(ev({ entity_ids: ['lock.front_door'], service: 'homeassistant.turn_off' }, 'screen', p).reason).toMatch(
      /not a service name/,
    );
  });
});

describe('data: bounds and named keys', () => {
  const light = (data: Record<string, unknown>) => ev({ entity_ids: ['light.hall'], service: 'turn_on', data });
  it('edges are inside', () => {
    expect(light({ brightness_pct: 1 }).tier).toBe('allow');
    expect(light({ brightness_pct: 100 }).tier).toBe('allow');
    expect(light({ color_temp_kelvin: 2000, brightness_pct: 55.5 }).tier).toBe('allow');
  });
  it('below and above are refused, never clamped', () => {
    expect(light({ brightness_pct: 0 }).reason).toBe('brightness_pct 0 is outside 1–100 for light.hall');
    expect(light({ brightness_pct: 101 }).reason).toBe('brightness_pct 101 is outside 1–100 for light.hall');
    expect(light({ color_temp_kelvin: 9000 }).tier).toBe('deny');
    const t = ev({ entity_ids: ['climate.hall_thermostat'], service: 'set_temperature', data: { temperature: 50 } });
    expect(t).toMatchObject({ tier: 'deny', reason: 'temperature 50 is outside 60–85 for climate.hall_thermostat' });
  });
  it('non-numeric values are refused', () => {
    for (const v of ['50', null, true, [50], { v: 50 }, NaN, Infinity])
      expect(light({ brightness_pct: v }).reason).toMatch(/brightness_pct must be a number/);
  });
  it('keys not named by the rule are refused', () => {
    expect(light({ brightness: 255 }).reason).toBe('brightness is not allowed in the data for light.hall turn_on');
    expect(light({ flash: 'long' }).tier).toBe('deny');
    expect(ev({ entity_ids: ['scene.evening'], service: 'turn_on', data: { transition: 2 } }).tier).toBe('deny');
  });
  it('data keys take strings and booleans only', () => {
    const t = (hvac_mode: unknown) =>
      ev({ entity_ids: ['climate.hall_thermostat'], service: 'set_hvac_mode', data: { hvac_mode } });
    expect(t('cool').tier).toBe('confirm');
    expect(t(3).reason).toMatch(/hvac_mode must be a string or true\/false/);
    expect(t({ mode: 'cool' }).tier).toBe('deny');
  });
  it('a self-approval attempt in data is just an unknown key', () => {
    for (const k of ['confirmed', 'approve', 'approved', 'confirm_id', 'pending_id'])
      expect(ev({ entity_ids: ['lock.front_door'], service: 'lock', data: { [k]: true } }).tier).toBe('deny');
  });
});

describe('max_minutes', () => {
  const pump = (data?: Record<string, unknown>, service = 'turn_on') =>
    ev({ entity_ids: ['switch.pond_pump'], service, data });
  it('defaults to max_minutes and strips minutes from the call', () => {
    const r = pump();
    expect(r.tier).toBe('allow');
    expect(r.timers).toEqual([
      { minutes: 60, domain: 'switch', service: 'turn_off', entity_ids: ['switch.pond_pump'] },
    ]);
    const s = pump({ minutes: 15 });
    expect(s.calls[0].data).toEqual({ entity_id: ['switch.pond_pump'] });
    expect(s.timers[0].minutes).toBe(15);
    expect(pump({ minutes: 60 }).timers[0].minutes).toBe(60);
  });
  it('over the max, zero, negative or not a number is refused', () => {
    expect(pump({ minutes: 61 }).reason).toBe('minutes 61 is outside 0–60 for switch.pond_pump');
    expect(pump({ minutes: 0 }).tier).toBe('deny');
    expect(pump({ minutes: -5 }).tier).toBe('deny');
    expect(pump({ minutes: '10' }).reason).toMatch(/minutes must be a number/);
  });
  it('the off service gets no timer and takes no minutes', () => {
    expect(pump(undefined, 'turn_off')).toMatchObject({ tier: 'allow', timers: [] });
    expect(pump({ minutes: 5 }, 'turn_off').tier).toBe('deny');
  });
  it('minutes on an entity without max_minutes is refused', () => {
    expect(ev({ entity_ids: ['light.hall'], service: 'turn_on', data: { minutes: 5 } }).reason).toBe(
      'minutes is not allowed in the data for light.hall turn_on',
    );
  });
  it('a service that cannot be timed is refused on a timed rule (when the policy is read)', () => {
    expect(bad(rules({ allow: { domain: 'fan', service: ['turn_on', 'set_percentage'] }, max_minutes: 10 }))).toMatch(
      /set_percentage can't be timed/,
    );
  });
  it('the off services table', () => {
    expect(OFF_SERVICE.turn_on).toBe('turn_off');
    expect(OFF_SERVICE.open_valve).toBe('close_valve');
    const v = ev({ entity_ids: ['valve.garden_zone_1'], service: 'open_valve', data: { minutes: 10 } });
    expect(v.tier).toBe('confirm');
    expect(v.timers).toEqual([
      { minutes: 10, domain: 'valve', service: 'close_valve', entity_ids: ['valve.garden_zone_1'] },
    ]);
  });
});

describe('words', () => {
  const st = states as ReadonlyMap<string, HaState>;
  it('summaries use friendly names', () => {
    expect(
      describeRequest({ entity_ids: ['light.kitchen_pendant_1', 'light.kitchen_pendant_2'], service: 'turn_off' }, st),
    ).toBe('Turn off Kitchen pendant 1 and Kitchen pendant 2');
    expect(
      describeRequest(
        { entity_ids: ['climate.hall_thermostat'], service: 'set_temperature', data: { temperature: 72 } },
        st,
      ),
    ).toBe('Set Hall thermostat to 72 (temperature)');
    expect(describeRequest({ entity_ids: ['switch.pond_pump'], service: 'turn_on' }, st, 30)).toBe(
      'Turn on Pond pump for 30 minutes',
    );
    expect(describeRequest({ entity_ids: ['light.a', 'light.b', 'light.c'], service: 'toggle' }, st)).toBe(
      'Toggle light.a, light.b and light.c',
    );
    expect(describeRequest({ entity_ids: ['fan.bedroom_fan'], service: 'oscillate' }, st)).toBe(
      'Oscillate Bedroom fan',
    );
  });
  it('detail is the exact call', () => {
    const r = ev({ entity_ids: ['valve.garden_zone_1'], service: 'open_valve', data: { minutes: 10 } });
    expect(describeCalls(r.calls, r.timers)).toBe(
      'valve.open_valve on valve.garden_zone_1; then valve.close_valve on valve.garden_zone_1 after 10 min',
    );
    const t = ev({ entity_ids: ['climate.hall_thermostat'], service: 'set_temperature', data: { temperature: 72 } });
    expect(describeCalls(t.calls)).toBe('climate.set_temperature on climate.hall_thermostat {"temperature":72}');
  });
});
