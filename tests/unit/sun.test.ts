import { describe, expect, it } from 'vitest';
import { daysInYear, hhmm, localToUTC, solarPosition, tzLabel, tzOffsetMin, utcToLocal } from '../../src/core/sun';

// Tampa, Florida (27.95° N, 82.46° W, America/New_York). The reference values below come from an independent
// implementation (the Python `astral` 3.2 package), not from this code.
const SITE = { lat: 27.95, lon: -82.46, tz: 'America/New_York' };
const doyOf = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86400000 + 1;

/** local clock minutes of solar noon, and the elevation then */
function noon(y: number, m: number, d: number) {
  const doy = doyOf(y, m, d);
  const s = solarPosition(localToUTC(y, doy, 12 * 60, SITE.tz), SITE.lat, SITE.lon);
  const noonUTC = Date.UTC(y, 0, doy) + s.solarNoonUTC * 60000;
  const local = utcToLocal(noonUTC, SITE.tz);
  return {
    local: hhmm(local.min),
    zone: tzLabel(noonUTC, SITE.tz),
    elevation: solarPosition(noonUTC, SITE.lat, SITE.lon).elevation,
  };
}

/** the local minute the sun's upper limb crosses the horizon (refracted elevation -0.267°), searching from `from` */
function crossing(y: number, m: number, d: number, from: number, to: number): number {
  const doy = doyOf(y, m, d);
  const el = (min: number) => solarPosition(localToUTC(y, doy, min, SITE.tz), SITE.lat, SITE.lon).elevation + 0.267;
  let a = from,
    b = to;
  for (let i = 0; i < 40; i++) {
    const c = (a + b) / 2;
    if (Math.sign(el(c)) === Math.sign(el(a))) a = c;
    else b = c;
  }
  return (a + b) / 2;
}

describe('solarPosition: the known values table (2026)', () => {
  it.each([
    // [month, day, solar noon (local clock), zone, noon elevation]
    [3, 20, '13:37:25', 'EDT', 62.11],
    [6, 21, '13:31:33', 'EDT', 85.49],
    [9, 22, '13:22:45', 'EDT', 62.17],
    [12, 21, '12:27:40', 'EST', 38.63],
  ])('%i/%i: solar noon %s %s (±1 min), elevation %f°', (m, d, local, zone, elevation) => {
    const n = noon(2026, m, d);
    const [hh, mm, ss] = local.split(':').map(Number);
    const toMin = (s: string) => +s.slice(0, 2) * 60 + +s.slice(3, 5);
    expect(Math.abs(toMin(n.local) - (hh * 60 + mm + ss / 60))).toBeLessThanOrEqual(1);
    expect(n.zone).toBe(zone);
    expect(n.elevation).toBeCloseTo(elevation, 0);
    expect(Math.abs(n.elevation - elevation)).toBeLessThan(0.15);
  });

  it('noon elevations agree with 90° − latitude ± obliquity', () => {
    expect(noon(2026, 6, 21).elevation).toBeCloseTo(90 - SITE.lat + 23.44, 0);
    expect(noon(2026, 12, 21).elevation).toBeCloseTo(90 - SITE.lat - 23.44, 0);
  });

  it.each([
    // [month, day, sunrise, sunset] in local clock time (astral, rounded to the minute)
    [6, 21, '06:34', '20:29'],
    [12, 21, '07:17', '17:39'],
  ])('%i/%i: sunrise %s, sunset %s (±2 min)', (m, d, rise, set) => {
    const toMin = (s: string) => +s.slice(0, 2) * 60 + +s.slice(3);
    expect(Math.abs(crossing(2026, m, d, 4 * 60, 11 * 60) - toMin(rise))).toBeLessThanOrEqual(2);
    expect(Math.abs(crossing(2026, m, d, 15 * 60, 22 * 60) - toMin(set))).toBeLessThanOrEqual(2);
  });

  it('azimuth is due south (≈180°) at solar noon in winter and north of east at a summer sunrise', () => {
    const doy = doyOf(2026, 12, 21);
    const s = solarPosition(localToUTC(2026, doy, 12 * 60 + 27, SITE.tz), SITE.lat, SITE.lon);
    expect(s.azimuth).toBeGreaterThan(178);
    expect(s.azimuth).toBeLessThan(182);
    const r = solarPosition(localToUTC(2026, doyOf(2026, 6, 21), 6 * 60 + 40, SITE.tz), SITE.lat, SITE.lon);
    expect(r.azimuth).toBeGreaterThan(55);
    expect(r.azimuth).toBeLessThan(70);
  });

  it('is below the horizon at local midnight', () => {
    expect(solarPosition(localToUTC(2026, 100, 0, SITE.tz), SITE.lat, SITE.lon).elevation).toBeLessThan(-30);
  });
});

describe('time-zone helpers', () => {
  it('tzOffsetMin: EST in winter, EDT in summer', () => {
    expect(tzOffsetMin(Date.UTC(2026, 0, 15, 17), SITE.tz)).toBe(-300);
    expect(tzOffsetMin(Date.UTC(2026, 6, 15, 17), SITE.tz)).toBe(-240);
    expect(tzOffsetMin(Date.UTC(2026, 6, 15, 17), 'UTC')).toBe(0);
    expect(tzOffsetMin(Date.UTC(2026, 6, 15, 17), 'Asia/Kolkata')).toBe(330);
  });

  it('localToUTC / utcToLocal round-trip on ordinary days', () => {
    for (const [doy, min] of [
      [1, 0],
      [100, 13 * 60 + 37],
      [200, 23 * 60 + 59],
      [365, 15 * 60],
    ]) {
      const ms = localToUTC(2026, doy, min, SITE.tz);
      const back = utcToLocal(ms, SITE.tz);
      expect(back.year).toBe(2026);
      expect(back.doy).toBe(doy);
      expect(back.min).toBeCloseTo(min, 6);
    }
  });

  it('localToUTC: 15:00 local is 20:00 UTC in January and 19:00 UTC in July', () => {
    expect(new Date(localToUTC(2026, 15, 15 * 60, SITE.tz)).toISOString()).toBe('2026-01-15T20:00:00.000Z');
    expect(new Date(localToUTC(2026, doyOf(2026, 7, 15), 15 * 60, SITE.tz)).toISOString()).toBe(
      '2026-07-15T19:00:00.000Z',
    );
  });

  it('localToUTC: a time in the spring-forward gap resolves to the hour before the change (as the prototype did)', () => {
    // 02:30 doesn't exist on 2026-03-08 in this zone; the two-pass offset lands on 01:30 EST, an hour earlier.
    // (The prototype's comment said "an hour later"; the behaviour is kept for parity and pinned here.)
    const doy = doyOf(2026, 3, 8);
    const ms = localToUTC(2026, doy, 2 * 60 + 30, SITE.tz);
    const back = utcToLocal(ms, SITE.tz);
    expect(back.min).toBe(1 * 60 + 30);
    expect(tzLabel(ms, SITE.tz)).toBe('EST');
  });

  it('localToUTC: the repeated hour at fall-back is resolved to one instant', () => {
    const doy = doyOf(2026, 11, 1); // DST ends 2026-11-01 02:00 local
    const ms = localToUTC(2026, doy, 1 * 60 + 30, SITE.tz);
    expect(utcToLocal(ms, SITE.tz).min).toBe(90);
  });

  it('utcToLocal crosses midnight into the previous local day', () => {
    const l = utcToLocal(Date.UTC(2026, 0, 2, 3), SITE.tz); // 22:00 on 1 Jan, EST
    expect(l).toMatchObject({ year: 2026, doy: 1, min: 22 * 60, offset: -300 });
  });

  it('daysInYear', () => {
    expect(daysInYear(2026)).toBe(365);
    expect(daysInYear(2028)).toBe(366);
    expect(daysInYear(2100)).toBe(365);
    expect(daysInYear(2000)).toBe(366);
  });

  it('hhmm and tzLabel', () => {
    expect(hhmm(0)).toBe('00:00');
    expect(hhmm(13 * 60 + 7)).toBe('13:07');
    expect(hhmm(25 * 60)).toBe('01:00');
    expect(tzLabel(Date.UTC(2026, 6, 1), SITE.tz)).toBe('EDT');
    expect(tzLabel(Date.UTC(2026, 0, 1), SITE.tz)).toBe('EST');
    expect(tzLabel(Date.UTC(2026, 0, 1), 'UTC')).toBe('UTC');
    expect(tzLabel(Date.UTC(2026, 6, 1), 'Asia/Kolkata')).toBe('GMT+5:30');
  });
});
