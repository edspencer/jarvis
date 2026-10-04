import { Color } from 'three';
import { describe, expect, it } from 'vitest';
import { combine, kelvinRGB, lookOf, type Look } from '../../src/plugins/lights/look';

const st = (state: string, attributes = {}) => ({ entity_id: 'light.x', state, attributes });

describe('kelvinRGB', () => {
  it('is warm at 2700 K and near white at 6600 K', () => {
    const warm = kelvinRGB(2700, new Color()).getRGB(new Color(), 'srgb');
    expect(warm.r).toBeCloseTo(1);
    expect(warm.b).toBeLessThan(warm.g);
    const white = kelvinRGB(6600, new Color()).getRGB(new Color(), 'srgb');
    expect(white.r).toBeGreaterThan(0.95);
    expect(white.g).toBeGreaterThan(0.95);
    expect(white.b).toBeGreaterThan(0.95);
  });
});

describe('lookOf', () => {
  it('no state = none; off = off; unavailable / unknown = fault', () => {
    expect(lookOf(undefined).kind).toBe('none');
    expect(lookOf(st('off')).kind).toBe('off');
    expect(lookOf(st('unavailable')).kind).toBe('fault');
    expect(lookOf(st('unknown')).kind).toBe('fault');
  });
  it('unavailable means off for a bulb behind a wall switch', () => {
    expect(lookOf(st('unavailable'), 'off').kind).toBe('off');
    expect(lookOf(st('unknown'), 'off').kind).toBe('fault');
  });
  it('on: level from brightness (clamped to 2 %), colour from rgb or colour temperature', () => {
    const l = lookOf(st('on', { brightness: 255 }));
    expect(l).toMatchObject({ kind: 'on', level: 1 });
    expect(lookOf(st('on', { brightness: 0 }))).toMatchObject({ level: 0.02 });
    expect(lookOf(st('on'))).toMatchObject({ level: 1 });
    const blue = lookOf(st('on', { color_mode: 'rgb', rgb_color: [0, 0, 255] }));
    if (blue.kind !== 'on') throw new Error('expected on');
    expect(blue.colour.b).toBeCloseTo(1);
    expect(blue.colour.r).toBeCloseTo(0);
    const ct = lookOf(st('on', { color_mode: 'color_temp', rgb_color: [0, 0, 255], color_temp_kelvin: 2700 }));
    if (ct.kind !== 'on') throw new Error('expected on');
    expect(ct.colour.r).toBeGreaterThan(ct.colour.b);
  });
});

describe('combine', () => {
  const on = (level: number): Look => ({ kind: 'on', colour: new Color(), level });
  it('on if any is on, at the brightest', () => {
    expect(combine([{ kind: 'off' }, on(0.3), on(0.8), { kind: 'fault' }])).toMatchObject({ level: 0.8 });
  });
  it('else off before fault, else none', () => {
    expect(combine([{ kind: 'fault' }, { kind: 'off' }]).kind).toBe('off');
    expect(combine([{ kind: 'fault' }, { kind: 'none' }]).kind).toBe('fault');
    expect(combine([{ kind: 'none' }, { kind: 'none' }]).kind).toBe('none');
  });
});
