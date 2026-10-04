// What an entity's state means for a fixture's glow.
import * as THREE from 'three';
import type { EntityState } from '../../plugin-api';

/** a switch, or a light with no colour: warm white */
export const DEFAULT_K = 2700;

export type Look =
  { kind: 'none' } | { kind: 'off' } | { kind: 'fault' } | { kind: 'on'; colour: THREE.Color; level: number };

/** Tanner Helland's black-body fit, good to a few % over 1,000-12,000 K */
export function kelvinRGB(k: number, out: THREE.Color): THREE.Color {
  const t = THREE.MathUtils.clamp(k, 1000, 12000) / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v: number) => THREE.MathUtils.clamp(v, 0, 255) / 255;
  return out.setRGB(c(r), c(g), c(b), THREE.SRGBColorSpace);
}

/** `um`: the map's unavailable_means ('off' for a smart bulb behind a wall switch, which drops off the network whenever
 * the switch is off; for it, unavailable is the normal "off", not a fault) */
export function lookOf(st: EntityState | undefined, um?: string): Look {
  if (!st) return { kind: 'none' };
  if (st.state === 'unavailable' && um === 'off') return { kind: 'off' };
  if (st.state === 'unavailable' || st.state === 'unknown') return { kind: 'fault' };
  if (st.state !== 'on') return { kind: 'off' };
  const a = st.attributes || {};
  const c = new THREE.Color();
  if (Array.isArray(a.rgb_color) && a.color_mode !== 'color_temp') {
    const [r, g, b] = a.rgb_color.map((v) => v / 255);
    c.setRGB(r, g, b, THREE.SRGBColorSpace);
  } else kelvinRGB(a.color_temp_kelvin || (a.color_temp ? 1e6 / a.color_temp : DEFAULT_K), c);
  const level = a.brightness != null ? THREE.MathUtils.clamp(a.brightness / 255, 0.02, 1) : 1;
  return { kind: 'on', colour: c, level };
}

/** several entities, one fixture: on if any bulb is on (at the brightest one's level and colour), else off if any is
 * off, else a fault if any is unavailable / unknown */
export function combine(looks: Look[]): Look {
  if (looks.length === 1) return looks[0];
  const on = looks.filter((l): l is Extract<Look, { kind: 'on' }> => l.kind === 'on').sort((a, b) => b.level - a.level);
  if (on.length) return on[0];
  for (const k of ['off', 'fault'] as const) if (looks.some((l) => l.kind === k)) return { kind: k };
  return { kind: 'none' };
}
