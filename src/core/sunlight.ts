// The sun: the NOAA solar position (sun.ts) for the site's latitude and longitude, at a local clock time in the site's
// time zone (DST-aware) on a day of the year, turned into the plan frame with the plan's true-north bearing. The sun
// plugin's panel drives `sunAt`; the lighting itself is the core's, so a site without the plugin still has a sun.
import * as THREE from 'three';
import type { Site } from '../site';
import type { Stage } from './stage';
import { daysInYear, hhmm, localToUTC, solarPosition, tzLabel, utcToLocal, type SolarPosition } from './sun';
import { sunDirection } from './units';

export interface SunAt {
  year: number;
  doy: number;
  /** local clock minutes after midnight */
  min: number;
}

export interface SunReport extends SolarPosition {
  local: string;
  tz: string;
  /** '15:00 EDT · 42° up, az 230°' */
  timeLabel: string;
  /** '3 Oct 2026 · noon 13:24' */
  dateLabel: string;
  daysInYear: number;
}

export interface Sunlight {
  sunAt: SunAt;
  updateSun(): SunReport;
  setSun(hour?: number, doy?: number, year?: number): SunReport;
  sunNow(): SunReport;
  /** "animate the year": advance the date, about a month a second, while `animate` is on */
  step(dt: number): void;
  animate: boolean;
  /** the last report */
  last: SunReport | null;
  /** called after every change */
  onChange: Set<(r: SunReport) => void>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function createSunlight({
  site,
  stage,
  requestShadows,
}: {
  site: Pick<Site, 'geo' | 'northAzimuth'>;
  stage: Pick<Stage, 'sky' | 'sun' | 'hemi' | 'centre' | 'sunDistance'>;
  requestShadows: () => void;
}): Sunlight {
  const { sky, sun, hemi, centre } = stage;
  const { lat, lon, timeZone: tz } = site.geo;
  const sunAt: SunAt = (() => {
    const n = utcToLocal(Date.now(), tz);
    return { year: n.year, doy: n.doy, min: 15 * 60 }; // opens on today's date, at 15:00
  })();

  function updateSun(): SunReport {
    const ms = localToUTC(sunAt.year, sunAt.doy, sunAt.min, tz);
    const s = solarPosition(ms, lat, lon);
    const d = sunDirection(s.azimuth, s.elevation, site.northAzimuth);
    sky.material.uniforms.sunPosition.value.copy(d);
    sun.position.copy(centre).addScaledVector(d, stage.sunDistance);
    const k = THREE.MathUtils.clamp(Math.sin((s.elevation * Math.PI) / 180) * 3, 0, 1);
    sun.intensity = 2.8 * k;
    hemi.intensity = 0.35 + 0.35 * k;
    const loc = utcToLocal(ms, tz); // the clock reading actually shown (DST gap)
    const zone = tzLabel(ms, tz);
    const date = new Date(Date.UTC(sunAt.year, 0, sunAt.doy));
    const noon = utcToLocal(Date.UTC(sunAt.year, 0, sunAt.doy) + s.solarNoonUTC * 60000, tz).min;
    const timeLabel = `${hhmm(loc.min)} ${zone} · ${s.elevation >= 0 ? `${Math.round(s.elevation)}° up` : 'below horizon'}, az ${Math.round(s.azimuth)}°`;
    const dateLabel = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${sunAt.year} · noon ${hhmm(noon)}`;
    requestShadows();
    const r: SunReport = {
      ...s,
      local: hhmm(loc.min),
      tz: zone,
      timeLabel,
      dateLabel,
      daysInYear: daysInYear(sunAt.year),
    };
    api.last = r;
    for (const f of api.onChange) f(r);
    return r;
  }

  // scripting: setSun(hour [, doy [, year]]) in local clock hours
  function setSun(hour?: number, doy?: number, year?: number): SunReport {
    if (year) sunAt.year = year;
    if (doy) sunAt.doy = Math.min(doy, daysInYear(sunAt.year));
    if (hour !== undefined) sunAt.min = hour * 60;
    return updateSun();
  }

  function sunNow(): SunReport {
    const n = utcToLocal(Date.now(), tz);
    Object.assign(sunAt, { year: n.year, doy: n.doy, min: Math.round(n.min) });
    return updateSun();
  }

  let yearT = 0;
  function step(dt: number): void {
    // animate the year at the chosen time of day: ~a month a second
    if (!api.animate) return;
    yearT += dt * 30;
    if (yearT >= 1) {
      sunAt.doy += Math.floor(yearT);
      yearT %= 1;
      if (sunAt.doy > daysInYear(sunAt.year)) sunAt.doy = 1;
      updateSun();
    }
  }

  const api: Sunlight = { sunAt, updateSun, setSun, sunNow, step, animate: false, last: null, onChange: new Set() };
  return api;
}
