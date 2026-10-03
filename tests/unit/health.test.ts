import { describe, expect, it } from 'vitest';
import { health, healthEntities, type DeviceSpec, type Thresholds } from '../../src/plugins/faults/health';
import type { Entities } from '../../src/plugins/home-assistant/types';

const TH: Thresholds = { battery_pct: 20, lqi_weak: 50, rssi_weak_dbm: -85, wifi_weak_pct: 30, stale_h: { zha: 25 } };
const NOW = Date.UTC(2026, 9, 3, 12);
const iso = (ms: number) => new Date(ms).toISOString();
const ents = (list: [string, string, Record<string, unknown>?, number?][]): Entities =>
  Object.fromEntries(
    list.map(([e, state, attributes = {}, age = 3600e3]) => [
      e,
      { entity_id: e, state, attributes, last_changed: iso(NOW - age), last_updated: iso(NOW - age) },
    ]),
  );
const dev = (over: Partial<DeviceSpec> = {}): DeviceSpec => ({
  id: 'd1',
  name: 'A device',
  integration: 'zha',
  health: { avail: ['light.bulb'] },
  ...over,
});

describe('device health rules', () => {
  it('ok when its main entity answers', () => {
    const r = health(dev(), ents([['light.bulb', 'on']]), NOW, TH);
    expect(r).toMatchObject({ sev: 'ok', why: [], off: null, known: true });
  });

  it('unknown (not known) when none of its entities has a state', () => {
    expect(health(dev(), {}, NOW, TH)).toMatchObject({ sev: 'ok', known: false });
  });

  it('red when every main entity is unavailable', () => {
    const r = health(dev(), ents([['light.bulb', 'unavailable']]), NOW, TH);
    expect(r.sev).toBe('red');
    expect(r.why[0].text).toBe('unavailable');
  });

  it('a bulb behind a wall switch: unavailable is off, unless a bulb on the same switch answers', () => {
    const d = dev({ unavailable_means: { off: 'a smart bulb on a wall switch', unless_on: ['light.mate'] } });
    const off = health(
      d,
      ents([
        ['light.bulb', 'unavailable'],
        ['light.mate', 'unavailable'],
      ]),
      NOW,
      TH,
    );
    expect(off.sev).toBe('ok');
    expect(off.off).toMatch(/off at its wall switch/);
    const fault = health(
      d,
      ents([
        ['light.bulb', 'unavailable'],
        ['light.mate', 'on'],
      ]),
      NOW,
      TH,
    );
    expect(fault.sev).toBe('red');
    expect(fault.why[0].text).toMatch(/while light.mate on the same switch answers/);
  });

  it('powered_by: off there is off here; on there makes it a fault', () => {
    const d = dev({ unavailable_means: { off: 'on a plug' }, powered_by: 'switch.plug' });
    expect(
      health(
        d,
        ents([
          ['light.bulb', 'unavailable'],
          ['switch.plug', 'off'],
        ]),
        NOW,
        TH,
      ).off,
    ).toBe('off: switch.plug is off');
    expect(
      health(
        d,
        ents([
          ['light.bulb', 'unavailable'],
          ['switch.plug', 'on'],
        ]),
        NOW,
        TH,
      ).sev,
    ).toBe('red');
  });

  it('a dead Z-Wave node is red', () => {
    const d = dev({ integration: 'zwave_js', health: { avail: ['switch.x'], node_status: ['sensor.node'] } });
    const r = health(
      d,
      ents([
        ['switch.x', 'on'],
        ['sensor.node', 'dead'],
      ]),
      NOW,
      TH,
    );
    expect(r.sev).toBe('red');
    expect(r.why.map((w) => w.text)).toContain('Z-Wave node dead');
  });

  it('stale: not seen for longer than its integration allows', () => {
    const d = dev({ health: { avail: ['light.bulb'], seen: ['sensor.lqi'] } });
    const fresh = health(
      d,
      ents([
        ['light.bulb', 'on'],
        ['sensor.lqi', '200', {}, 3600e3],
      ]),
      NOW,
      TH,
    );
    expect(fresh.sev).toBe('ok');
    const stale = health(
      d,
      ents([
        ['light.bulb', 'on'],
        ['sensor.lqi', '200', {}, 30 * 3600e3],
      ]),
      NOW,
      TH,
    );
    expect(stale.sev).toBe('red');
    expect(stale.why[0].text).toBe('not seen for 30 h (stale over 25 h)');
  });

  it('amber: low battery, a low-battery sensor, weak signal', () => {
    const d = dev({
      health: {
        avail: ['light.bulb'],
        battery: ['sensor.batt'],
        battery_low: ['binary_sensor.low'],
        signal: [
          { entity: 'sensor.lqi', kind: 'lqi' },
          { entity: 'sensor.wifi', kind: 'wifi' },
        ],
      },
    });
    const r = health(
      d,
      ents([
        ['light.bulb', 'on'],
        ['sensor.batt', '12'],
        ['binary_sensor.low', 'on'],
        ['sensor.lqi', '30'],
        ['sensor.wifi', '20'],
      ]),
      NOW,
      TH,
    );
    expect(r.sev).toBe('amber');
    expect(r.why.map((w) => w.text)).toEqual([
      'battery 12 %',
      'battery low',
      'weak signal (lqi 30)',
      'weak signal (wifi 20)',
    ]);
  });

  it('blue: a firmware update; red outranks amber outranks blue', () => {
    const d = dev({ health: { avail: ['light.bulb'], update: ['update.fw'], battery: ['sensor.batt'] } });
    const fw = [['update.fw', 'on', { installed_version: '1.2.0', latest_version: '1.3.1' }]] as [
      string,
      string,
      Record<string, unknown>,
    ][];
    expect(health(d, ents([['light.bulb', 'on'], ...fw]), NOW, TH)).toMatchObject({ sev: 'blue' });
    expect(health(d, ents([['light.bulb', 'on'], ['sensor.batt', '5'], ...fw]), NOW, TH).sev).toBe('amber');
    expect(health(d, ents([['light.bulb', 'unavailable'], ['sensor.batt', '5'], ...fw]), NOW, TH).sev).toBe('red');
    expect(health(d, ents([['light.bulb', 'on'], ...fw]), NOW, TH).why[0].text).toBe('update 1.2.0 → 1.3.1');
  });

  it('healthEntities lists everything it reads', () => {
    const d = dev({
      unavailable_means: { off: 'x', unless_on: ['light.mate'] },
      powered_by: 'switch.plug',
      health: { avail: ['light.bulb'], battery: ['sensor.b'], signal: [{ entity: 'sensor.s', kind: 'rssi' }] },
    });
    expect(healthEntities(d)).toEqual(['light.bulb', 'sensor.b', 'sensor.s', 'light.mate', 'switch.plug']);
  });
});
