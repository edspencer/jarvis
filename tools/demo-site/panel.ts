// The main panel's schedule (docs/demo-house.md#panel-schedule): every breaker, what it feeds, and the circuit
// monitor's clamp (CT) on it if any. Wall plates name their breaker as a string ("5", "1+3"); the energy map and the
// panel's registry entry are built from this list. Invented, like the rest of the demo.

export interface Circuit {
  /** the energy map's meter id */
  id: string;
  label: string;
  /** one space, or the two of a 240 V circuit */
  breaker: number | [number, number];
  amps: number;
  volts: 120 | 240;
  /** the monitor's clamp channel (1-16); none: only in the monitor's Balance */
  ct?: number;
  /** AFCI / GFCI protection, as the breaker's label says */
  protection?: 'AFCI' | 'GFCI' | 'dual';
  /** a source (back-fed PV breaker), not a load */
  source?: boolean;
}

export const PANEL = {
  name: 'Main panel',
  main_amps: 200,
  spaces: 40,
};

export const SCHEDULE: Circuit[] = [
  { id: 'circuit.range', label: 'Range', breaker: [1, 3], amps: 40, volts: 240, ct: 1 },
  { id: 'circuit.heat_pump', label: 'Heat pump (outdoor unit)', breaker: [2, 4], amps: 40, volts: 240, ct: 2 },
  {
    id: 'circuit.living_outlets',
    label: 'Living room outlets',
    breaker: 5,
    amps: 20,
    volts: 120,
    ct: 3,
    protection: 'AFCI',
  },
  { id: 'circuit.air_handler', label: 'Air handler', breaker: [6, 8], amps: 60, volts: 240, ct: 4 },
  {
    id: 'circuit.lights_ground',
    label: 'Lighting, ground floor',
    breaker: 7,
    amps: 15,
    volts: 120,
    ct: 5,
    protection: 'AFCI',
  },
  {
    id: 'circuit.kitchen_counter',
    label: 'Kitchen counter outlets',
    breaker: 9,
    amps: 20,
    volts: 120,
    ct: 6,
    protection: 'dual',
  },
  { id: 'circuit.water_heater', label: 'Water heater', breaker: [10, 12], amps: 30, volts: 240, ct: 7 },
  { id: 'circuit.fridge', label: 'Fridge', breaker: 11, amps: 20, volts: 120, ct: 8 },
  {
    id: 'circuit.dishwasher',
    label: 'Dishwasher and disposal',
    breaker: 13,
    amps: 20,
    volts: 120,
    ct: 9,
    protection: 'dual',
  },
  { id: 'circuit.dryer', label: 'Dryer', breaker: [14, 16], amps: 30, volts: 240, ct: 10 },
  { id: 'circuit.microwave', label: 'Microwave', breaker: 15, amps: 20, volts: 120, protection: 'dual' },
  { id: 'circuit.study', label: 'Study outlets', breaker: 17, amps: 20, volts: 120, ct: 12, protection: 'AFCI' },
  { id: 'circuit.ev_charger', label: 'EV charger', breaker: [18, 20], amps: 50, volts: 240, ct: 13 },
  {
    id: 'circuit.primary_suite',
    label: 'Primary suite lights and outlets',
    breaker: 19,
    amps: 20,
    volts: 120,
    ct: 14,
    protection: 'AFCI',
  },
  {
    id: 'circuit.bedrooms',
    label: 'Bedrooms 2 and 3, hall bath, landing',
    breaker: 21,
    amps: 20,
    volts: 120,
    ct: 15,
    protection: 'AFCI',
  },
  { id: 'circuit.washer', label: 'Washer', breaker: 22, amps: 20, volts: 120, ct: 16, protection: 'GFCI' },
  { id: 'circuit.bath_outlets', label: 'Bathroom outlets', breaker: 23, amps: 20, volts: 120, protection: 'GFCI' },
  { id: 'circuit.garage', label: 'Garage', breaker: 24, amps: 20, volts: 120, ct: 11, protection: 'GFCI' },
  { id: 'circuit.outside', label: 'Outside lights and outlets', breaker: 25, amps: 20, volts: 120, protection: 'GFCI' },
  { id: 'circuit.alarms', label: 'Smoke and CO alarms', breaker: 26, amps: 15, volts: 120, protection: 'AFCI' },
  { id: 'circuit.irrigation', label: 'Irrigation and doorbell', breaker: 27, amps: 15, volts: 120 },
  { id: 'pv', label: 'Solar PV (back-fed)', breaker: [28, 30], amps: 40, volts: 240, source: true },
];

/** a breaker as wall plates write it: "5", "1+3" */
export const breakerText = (c: Circuit): string => (Array.isArray(c.breaker) ? c.breaker.join('+') : String(c.breaker));

/** the circuit on a breaker ("5", "1+3", 5); throws if there is none, so a plate can't name a breaker that isn't in
 * the schedule */
export function circuitOn(breaker: string | number): Circuit {
  const want = String(breaker);
  const c = SCHEDULE.find(
    (x) => breakerText(x) === want || (Array.isArray(x.breaker) && x.breaker.map(String).includes(want)),
  );
  if (!c) throw new Error(`no circuit on breaker ${want}`);
  return c;
}

export const circuit = (id: string): Circuit => {
  const c = SCHEDULE.find((x) => x.id === id);
  if (!c) throw new Error(`no circuit ${id}`);
  return c;
};
