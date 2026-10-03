// The plan frame and three.js's. The model (glTF) is in metres, +Y up; the plan frame is the site's units (feet by
// default, or metres: the manifest's frame.units), X = east, Y = north, Z up from the finished ground floor. So plan
// (X, Y, Z) -> three.js (X, Z, -Y) x the unit. Every position in the manifest and the data files is in the plan frame.
import { Vector3 } from 'three';

export const FT = 0.3048;

/** metres per plan unit: set once from the site manifest, before anything converts */
let unit = FT;
export function setPlanUnit(metres: number): void {
  unit = metres;
}
export const planUnit = (): number => unit;

export interface PlanPoint {
  X: number;
  Y: number;
  Z: number;
}

/** plan -> three.js metres */
export const P = (X: number, Y: number, Z = 0): Vector3 => new Vector3(X * unit, Z * unit, -Y * unit);

/** three.js metres -> plan */
export const toPlan = (v: { x: number; y: number; z: number }): PlanPoint => ({
  X: v.x / unit,
  Y: -v.z / unit,
  Z: v.y / unit,
});

/** a direction in the plan frame given as a compass bearing in degrees clockwise from true north, at `el` degrees
 * elevation, as a three.js unit vector; `planNorthAz` is the true bearing of plan +Y */
export function sunDirection(azimuth: number, elevation: number, planNorthAz: number): Vector3 {
  const r = Math.PI / 180;
  const el = elevation * r;
  const pa = (azimuth - planNorthAz) * r; // clockwise from plan north
  return new Vector3(Math.sin(pa) * Math.cos(el), Math.sin(el), -Math.cos(pa) * Math.cos(el));
}
