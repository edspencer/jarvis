import { describe, expect, it, vi } from 'vitest';
import {
  controlCall,
  createSender,
  entitiesOf,
  SEND_OK,
  sendRefusal,
  toggleBlocker,
} from '../../src/plugins/home-assistant/policy';
import type { Control, Entities, Status } from '../../src/plugins/home-assistant/types';

const st = (entity_id: string, state: string, attributes = {}) => ({ entity_id, state, attributes });

describe('sendRefusal: the domain / service allowlist', () => {
  it.each([
    ['light', 'toggle', 'light.cove'],
    ['light', 'turn_on', 'light.cove'],
    ['light', 'turn_off', 'light.cove'],
    ['switch', 'toggle', 'switch.pump'],
    ['switch', 'turn_on', 'switch.pump'],
    ['switch', 'turn_off', 'switch.pump'],
    ['script', 'turn_on', 'script.bedtime'],
    ['scene', 'turn_on', 'scene.evening'],
  ])('allows %s.%s on %s', (domain, service, entity) => {
    expect(sendRefusal(domain, service, { entity_id: entity })).toBeNull();
  });

  it('allows several entities of the same domain', () => {
    expect(sendRefusal('light', 'turn_off', { entity_id: ['light.a', 'light.b'], brightness: 10 })).toBeNull();
  });

  it.each([
    ['lock', 'unlock', 'lock.front_door'],
    ['lock', 'lock', 'lock.front_door'],
    ['cover', 'open_cover', 'cover.gate'],
    ['cover', 'close_cover', 'cover.gate'],
    ['alarm_control_panel', 'alarm_disarm', 'alarm_control_panel.home'],
    ['climate', 'set_temperature', 'climate.zone_2'],
    ['climate', 'turn_off', 'climate.zone_2'],
    ['fan', 'turn_on', 'fan.hall'],
    ['media_player', 'media_play', 'media_player.tv'],
    ['media_player', 'turn_on', 'media_player.tv'],
    ['homeassistant', 'restart', 'homeassistant.x'],
    ['script', 'turn_off', 'script.bedtime'],
    ['script', 'toggle', 'script.bedtime'],
    ['scene', 'apply', 'scene.evening'],
    ['light', 'set_level', 'light.cove'],
    ['__proto__', 'turn_on', '__proto__.x'],
    ['constructor', 'turn_on', 'constructor.x'],
  ])('refuses %s.%s', (domain, service, entity) => {
    expect(sendRefusal(domain, service, { entity_id: entity })).toMatch(/^refused: /);
  });

  it('refuses cross-domain calls: light.turn_on aimed at a switch, or at a lock', () => {
    expect(sendRefusal('light', 'turn_on', { entity_id: 'switch.pump' })).toBe('refused: light.turn_on on switch.pump');
    expect(sendRefusal('light', 'turn_on', { entity_id: 'lock.front_door' })).not.toBeNull();
    expect(sendRefusal('switch', 'toggle', { entity_id: ['switch.a', 'lock.front_door'] })).not.toBeNull();
    expect(sendRefusal('script', 'turn_on', { entity_id: 'light.cove' })).not.toBeNull();
  });

  it('refuses a call with no entity', () => {
    expect(sendRefusal('light', 'toggle', { entity_id: [] })).not.toBeNull();
  });

  it('the allowlist is exactly lights, switches, scripts and scenes', () => {
    expect(Object.keys(SEND_OK).sort()).toEqual(['light', 'scene', 'script', 'switch']);
  });
});

describe('createSender: send(), the only call to Home Assistant', () => {
  const make = (over: { status?: Status; connected?: boolean; mock?: boolean } = {}) => {
    const call = vi.fn(async () => 'called');
    const mockService = vi.fn(async () => 'mocked');
    const send = createSender({
      mock: () => (over.mock ? mockService : null),
      status: () => over.status ?? 'live',
      connected: () => over.connected ?? true,
      call,
    });
    return { send, call, mockService };
  };

  it('passes an allowed call to the live connection', async () => {
    const { send, call } = make();
    await expect(send('light', 'toggle', { entity_id: 'light.cove' })).resolves.toBe('called');
    expect(call).toHaveBeenCalledWith('light', 'toggle', { entity_id: 'light.cove' });
  });

  it.each([
    ['lock', 'unlock', 'lock.front_door'],
    ['cover', 'open_cover', 'cover.gate'],
    ['alarm_control_panel', 'alarm_disarm', 'alarm_control_panel.home'],
    ['climate', 'set_temperature', 'climate.zone_2'],
    ['fan', 'turn_on', 'fan.hall'],
    ['media_player', 'media_play', 'media_player.tv'],
    ['light', 'turn_on', 'switch.pump'],
  ])('refuses %s.%s on %s without calling anything, live or mock', async (domain, service, entity) => {
    for (const mock of [false, true]) {
      const { send, call, mockService } = make({ mock });
      await expect(send(domain, service, { entity_id: entity })).rejects.toThrow(/^refused: /);
      expect(call).not.toHaveBeenCalled();
      expect(mockService).not.toHaveBeenCalled();
    }
  });

  it('refuses when not connected, or connected but not live', async () => {
    for (const o of [{ connected: false }, { status: 'connecting' as Status }, { status: 'error' as Status }]) {
      const { send, call } = make(o);
      await expect(send('light', 'toggle', { entity_id: 'light.cove' })).rejects.toThrow(
        'not connected to Home Assistant',
      );
      expect(call).not.toHaveBeenCalled();
    }
  });

  it('in mock mode goes to the simulator, never to HA', async () => {
    const { send, call, mockService } = make({ mock: true, connected: false });
    await expect(send('switch', 'turn_off', { entity_id: 'switch.pump' })).resolves.toBe('mocked');
    expect(mockService).toHaveBeenCalledOnce();
    expect(call).not.toHaveBeenCalled();
  });
});

describe('controlCall: what act() may call for a HUD control', () => {
  const controls: Control[] = [
    { id: 'bed', label: 'Bedtime', entity_id: 'script.bedtime', action: 'run' },
    { id: 'eve', label: 'Evening', entity_id: 'scene.evening', action: 'run' },
    { id: 'pump', label: 'Pump', entity_id: 'switch.pump', action: 'toggle' },
    { id: 'lamp', label: 'Lamp', entity_id: 'light.lamp', action: 'toggle' },
    // listed by mistake: still refused, because their actions don't allow these domains
    { id: 'door', label: 'Door', entity_id: 'lock.front_door', action: 'toggle' },
    { id: 'gate', label: 'Gate', entity_id: 'cover.gate', action: 'run' },
    { id: 'heat', label: 'Heat', entity_id: 'climate.zone_1', action: 'toggle' },
  ];
  const ents: Entities = { 'switch.pump': st('switch.pump', 'on'), 'light.lamp': st('light.lamp', 'off') };

  it('runs scripts and scenes with turn_on', () => {
    expect(controlCall(controls, controls[0], ents)).toEqual({ domain: 'script', service: 'turn_on' });
    expect(controlCall(controls, controls[1], ents)).toEqual({ domain: 'scene', service: 'turn_on' });
  });

  it('toggles a switch or a light to the opposite of its state', () => {
    expect(controlCall(controls, controls[2], ents)).toEqual({ domain: 'switch', service: 'turn_off' });
    expect(controlCall(controls, controls[3], ents)).toEqual({ domain: 'light', service: 'turn_on' });
    expect(controlCall(controls, controls[2], {})).toEqual({ domain: 'switch', service: 'turn_on' });
  });

  it('refuses a lock, a cover or a climate entity even when listed', () => {
    for (const c of controls.slice(4)) expect(controlCall(controls, c, ents)).toHaveProperty('refused');
  });

  it('refuses anything not in the list (an unlisted entity, or a listed id aimed elsewhere)', () => {
    const stray: Control = { id: 'x', label: 'X', entity_id: 'switch.other', action: 'toggle' };
    expect(controlCall(controls, stray, ents)).toHaveProperty('refused');
    const hijack: Control = { ...controls[2], entity_id: 'switch.gate_opener' };
    expect(controlCall(controls, hijack, ents)).toHaveProperty('refused');
    const lock: Control = { id: 'pump', label: 'Pump', entity_id: 'lock.front_door', action: 'toggle' };
    expect(controlCall(controls, lock, ents)).toHaveProperty('refused');
  });

  it('refuses an unknown action', () => {
    const odd = { ...controls[0], action: 'open' } as unknown as Control;
    expect(controlCall([odd], odd, ents)).toHaveProperty('refused');
  });
});

describe('entitiesOf and toggleBlocker: switching a fixture from the model', () => {
  const states: Entities = {
    'light.a': st('light.a', 'on'),
    'light.b': st('light.b', 'unavailable'),
    'switch.s': st('switch.s', 'off'),
  };
  const policy = { light: true, switch_marked_as_light: true };

  it('entitiesOf keeps only light.* and switch.* entities', () => {
    expect(entitiesOf({ entity_id: 'light.a' })).toEqual(['light.a']);
    expect(entitiesOf({ entity_id: ['light.a', 'lock.x', 'switch.s', 'cover.g'] })).toEqual(['light.a', 'switch.s']);
    expect(entitiesOf({ entity_id: 'lock.front_door' })).toEqual([]);
    expect(entitiesOf({ entity_id: null })).toEqual([]);
    expect(entitiesOf(undefined)).toEqual([]);
  });

  it('allows a mapped light when connected (live or mock)', () => {
    for (const status of ['live', 'mock'] as Status[])
      expect(toggleBlocker({ entry: { entity_id: 'light.a' }, policy, status, states })).toBeNull();
  });

  it('refuses when not connected', () => {
    for (const status of ['disconnected', 'connecting', 'error'] as Status[])
      expect(toggleBlocker({ entry: { entity_id: 'light.a' }, policy, status, states })).toBe(
        'not connected to Home Assistant',
      );
  });

  it('refuses a fixture with no entity, or only non-light entities', () => {
    expect(toggleBlocker({ entry: undefined, policy, status: 'live', states })).toMatch(/no Home Assistant entity/);
    expect(toggleBlocker({ entry: { entity_id: 'lock.front_door' }, policy, status: 'live', states })).toMatch(
      /no Home Assistant entity/,
    );
  });

  it('refuses lights when the policy allows none', () => {
    expect(toggleBlocker({ entry: { entity_id: 'light.a' }, policy: {}, status: 'live', states })).toMatch(
      /isn't a light the model may switch/,
    );
  });

  it('refuses a switch unless the map marks it as a light and the policy allows that', () => {
    const entry = { entity_id: 'switch.s' };
    expect(toggleBlocker({ entry, policy, status: 'live', states })).toMatch(/switch_is_light/);
    expect(toggleBlocker({ entry: { ...entry, switch_is_light: true }, policy, status: 'live', states })).toBeNull();
    expect(
      toggleBlocker({ entry: { ...entry, switch_is_light: true }, policy: { light: true }, status: 'live', states }),
    ).not.toBeNull();
  });

  it('refuses when every entity is unavailable or missing', () => {
    expect(toggleBlocker({ entry: { entity_id: 'light.b' }, policy, status: 'live', states })).toBe(
      'unavailable in Home Assistant',
    );
    expect(toggleBlocker({ entry: { entity_id: 'light.zzz' }, policy, status: 'live', states })).toBe(
      'unavailable in Home Assistant',
    );
    expect(toggleBlocker({ entry: { entity_id: ['light.a', 'light.b'] }, policy, status: 'live', states })).toBeNull();
  });
});
