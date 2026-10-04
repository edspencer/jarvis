import { describe, expect, it } from 'vitest';
import { FT, P, sunDirection, toPlan } from '../../src/core/units';

describe('plan <-> three.js', () => {
  it('maps plan X east, Y north, Z up (feet) to three.js X, -Z, Y (metres)', () => {
    const e = P(1, 0, 0);
    expect([e.x, e.y, Math.abs(e.z)]).toEqual([FT, 0, 0]);
    const n = P(0, 1, 0);
    expect(n.x).toBe(0);
    expect(n.y).toBe(0);
    expect(n.z).toBeCloseTo(-FT);
    expect(P(0, 0, 1).y).toBe(FT);
    expect(P(0, 0, 1).z + 0).toBe(0);
    expect(P(10, 20).y).toBe(0);
  });

  it('round-trips', () => {
    for (const [X, Y, Z] of [
      [41, 63, 0],
      [-3.5, 12.25, 10.5],
      [0, 0, 0],
      [110, -40, 95],
    ]) {
      const p = toPlan(P(X, Y, Z));
      expect(p.X).toBeCloseTo(X, 10);
      expect(p.Y).toBeCloseTo(Y, 10);
      expect(p.Z).toBeCloseTo(Z, 10);
    }
  });

  it('toPlan accepts any {x, y, z}', () => {
    expect(toPlan({ x: FT, y: 2 * FT, z: -3 * FT })).toEqual({ X: 1, Y: 3, Z: 2 });
  });
});

describe('sunDirection', () => {
  const north = 347.5;
  it('points along plan north (three.js -Z) when the sun is at the plan-north bearing on the horizon', () => {
    const d = sunDirection(north, 0, north);
    expect(d.x).toBeCloseTo(0);
    expect(d.y).toBeCloseTo(0);
    expect(d.z).toBeCloseTo(-1);
  });
  it('points to plan east (+X) 90° clockwise from plan north', () => {
    const d = sunDirection(north + 90, 0, north);
    expect(d.x).toBeCloseTo(1);
    expect(d.z).toBeCloseTo(0);
  });
  it('points straight up at 90° elevation, and is a unit vector', () => {
    expect(sunDirection(123, 90, north).y).toBeCloseTo(1);
    expect(sunDirection(200, 35, north).length()).toBeCloseTo(1);
  });
});
