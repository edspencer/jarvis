// Sun position: the NOAA solar-position approximation (the NOAA Solar Calculator / Meeus "Astronomical Algorithms"
// low-precision series; well under 0.1 deg of SPA for 1900-2100), with atmospheric refraction. Clock time is a named
// IANA time zone, DST-aware, through the runtime's own time-zone database (Intl). No three.js here: pure functions.
// The site's latitude, longitude and zone are passed in by the caller (from the site manifest).

const R = Math.PI / 180;

/** Minutes to add to UTC to get local clock time in `tz` at the instant `ms` (e.g. -240 for EDT). */
export function tzOffsetMin(ms: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - Math.floor(ms / 1000) * 1000) / 60000);
}

/** The UTC instant of local clock time `min` (minutes after midnight) on day-of-year `doy` (1 = 1 Jan) of `year`.
 * A time in the spring-forward gap (02:00-03:00 on the changeover day, which no clock shows) resolves to the hour
 * before it on the old offset (02:30 -> 01:30 standard time); the HUD's label shows the reading actually used. */
export function localToUTC(year: number, doy: number, min: number, tz: string): number {
  const wall = Date.UTC(year, 0, doy, 0, min); // the wall-clock reading, as if it were UTC
  let ms = wall - tzOffsetMin(wall, tz) * 60000;
  ms = wall - tzOffsetMin(ms, tz) * 60000; // second pass settles the DST edge
  return ms;
}

export interface LocalTime {
  year: number;
  /** day of the year, 1 = 1 Jan */
  doy: number;
  /** minutes after local midnight */
  min: number;
  /** minutes to add to UTC for local time */
  offset: number;
}

/** Local calendar parts of an instant. */
export function utcToLocal(ms: number, tz: string): LocalTime {
  const off = tzOffsetMin(ms, tz);
  const d = new Date(ms + off * 60000);
  const year = d.getUTCFullYear();
  const doy = Math.floor((Date.UTC(year, d.getUTCMonth(), d.getUTCDate()) - Date.UTC(year, 0, 1)) / 86400000) + 1;
  return { year, doy, min: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60, offset: off };
}

export const daysInYear = (y: number): number => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365);

export interface SolarPosition {
  /** degrees above the horizon, refracted */
  elevation: number;
  /** degrees from true north, clockwise */
  azimuth: number;
  declination: number;
  /** equation of time, minutes */
  eot: number;
  /** solar noon, minutes after UTC midnight */
  solarNoonUTC: number;
}

/** NOAA solar position at instant `ms` for a site at `lat`, `lon` (degrees, east positive). */
export function solarPosition(ms: number, lat: number, lon: number): SolarPosition {
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * R) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * R) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * R) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * R); // apparent longitude
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * R); // corrected obliquity
  const dec = Math.asin(Math.sin(eps * R) * Math.sin(lambda * R));
  const y = Math.tan((eps / 2) * R) ** 2;
  const eot =
    (4 / R) *
    (y * Math.sin(2 * L0 * R) -
      2 * e * Math.sin(M * R) +
      4 * e * y * Math.sin(M * R) * Math.cos(2 * L0 * R) -
      0.5 * y * y * Math.sin(4 * L0 * R) -
      1.25 * e * e * Math.sin(2 * M * R));

  const utcMin = (((ms / 60000) % 1440) + 1440) % 1440;
  const tst = (((utcMin + eot + 4 * lon) % 1440) + 1440) % 1440; // true solar time, minutes
  const ha = (tst / 4 - 180) * R; // hour angle
  const phi = lat * R;
  const cosZ = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZ)));
  const az =
    (Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) / R + 180 + 360) % 360;

  // refraction (NOAA's piecewise fit), degrees
  const h = 90 - zen / R;
  let refr = 0;
  if (h <= 85) {
    const te = Math.tan(h * R);
    if (h > 5) refr = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
    else if (h > -0.575) refr = 1735 + h * (-518.2 + h * (103.4 + h * (-12.79 + h * 0.711)));
    else refr = -20.772 / te;
    refr /= 3600;
  }
  return { elevation: h + refr, azimuth: az, declination: dec / R, eot, solarNoonUTC: 720 - 4 * lon - eot };
}

/** "HH:MM" for minutes after midnight */
export const hhmm = (m: number): string =>
  `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;

/** The zone's short name at an instant, as the runtime's time-zone data spells it in US English: 'EST', 'CEST', or
 * 'GMT+2' for a zone without a common abbreviation. */
export function tzLabel(ms: number, tz: string): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date(ms))
    .find((x) => x.type === 'timeZoneName');
  return part?.value || 'UTC';
}
