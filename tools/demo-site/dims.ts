// ------------------------------------------------------------------ the building's dimensions (plan metres)
export const W = 12, // east-west
  D = 9; // north-south
export const EXT = 0.25, // exterior wall thickness (outside the footprint)
  INT = 0.12; // interior walls (centred on their line)
export const UP = 3.2; // first-floor level
export const SLAB = 2.9; // underside of the first floor
export const CEIL0 = 2.7, // ground-floor ceilings
  CEIL1 = 5.6; // first-floor ceilings
export const EAVE = 5.95; // top of the roof at the eaves line... the wall plate
export const OVERHANG = 0.5;
export const PITCH = 30; // degrees
// the stair: 18 risers from 0 to UP, 17 treads running north from y = 3.0 along the east wall
export const RISERS = 18,
  TREAD = 0.27,
  STAIR_Y0 = 3.0,
  STAIR_X = [10.66, 12] as const;
export const STAIR_Y1 = STAIR_Y0 + (RISERS - 1) * TREAD; // 7.59: the top tread meets the landing

export const G = { lawn: -0.15 };
