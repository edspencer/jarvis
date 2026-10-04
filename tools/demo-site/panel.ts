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
  /** rooms it serves by the schedule's own words (the energy map adds the rooms of whatever the areas put on it) */
  rooms?: string[];
}

export const PANEL = {
  name: 'Main panel',
  main_amps: 200,
  spaces: 40,
};

// Labels are what the panel's schedule card says; the energy mock (src/plugins/energy/mock.ts) picks a load profile
// from words in them (fridge, dryer, heat pump, light, desk…), so they also decide how the demo's circuits behave.
// Sixteen clamps (the monitor has 16): the big 240 V loads and the busiest 120 V circuits. The microwave, the washer,
// the bathroom outlets, the alarms, the irrigation and the monitor's own supply have none: they are only in the
// monitor's Balance (the main panel's Other).
export const SCHEDULE: Circuit[] = [
  { id: 'circuit.range', label: 'Range', breaker: [1, 3], amps: 40, volts: 240, ct: 1, rooms: ['kitchen'] },
  {
    id: 'circuit.heat_pump',
    label: 'Heat pump (outdoor unit)',
    breaker: [2, 4],
    amps: 40,
    volts: 240,
    ct: 2,
  },
  {
    id: 'circuit.living_outlets',
    label: 'Living room and hall outlets',
    breaker: 5,
    amps: 20,
    volts: 120,
    ct: 3,
    protection: 'AFCI',
    rooms: ['living_room', 'hall'],
  },
  {
    id: 'circuit.air_handler',
    label: 'Air handler and heat strips',
    breaker: [6, 8],
    // 4.8 kW of heat strips (20 A at 240 V) and the blower, a continuous load: × 1.25
    amps: 30,
    volts: 240,
    ct: 4,
    rooms: ['hall'],
  },
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
    rooms: ['kitchen'],
  },
  {
    id: 'circuit.water_heater',
    label: 'Water heater',
    breaker: [10, 12],
    amps: 30,
    volts: 240,
    ct: 7,
    rooms: ['garage'],
  },
  { id: 'circuit.fridge', label: 'Fridge', breaker: 11, amps: 20, volts: 120, ct: 8, rooms: ['kitchen'] },
  {
    id: 'circuit.dishwasher',
    label: 'Dishwasher and disposal',
    breaker: 13,
    amps: 20,
    volts: 120,
    ct: 9,
    protection: 'dual',
    rooms: ['kitchen'],
  },
  { id: 'circuit.dryer', label: 'Dryer', breaker: [14, 16], amps: 30, volts: 240, ct: 10, rooms: ['laundry'] },
  {
    id: 'circuit.microwave',
    label: 'Microwave',
    breaker: 15,
    amps: 20,
    volts: 120,
    protection: 'dual',
    rooms: ['kitchen'],
  },
  {
    id: 'circuit.study',
    label: 'Study outlets (network, desk)',
    breaker: 17,
    amps: 20,
    volts: 120,
    ct: 12,
    protection: 'AFCI',
    rooms: ['study'],
  },
  {
    id: 'circuit.ev_charger',
    label: 'EV charger',
    breaker: [18, 20],
    amps: 50,
    volts: 240,
    ct: 13,
    rooms: ['garage'],
  },
  {
    id: 'circuit.primary_suite',
    label: 'Primary suite: bedroom, closet, bath',
    breaker: 19,
    amps: 20,
    volts: 120,
    ct: 14,
    protection: 'AFCI',
    rooms: ['bedroom_1', 'primary_closet', 'primary_bath'],
  },
  {
    id: 'circuit.bedrooms',
    label: 'Bedrooms 2 and 3, hall bath, landing',
    breaker: 21,
    amps: 20,
    volts: 120,
    ct: 15,
    protection: 'AFCI',
    rooms: ['bedroom_2', 'bedroom_3', 'hall_bath', 'landing'],
  },
  {
    id: 'circuit.washer',
    label: 'Washer and laundry outlets',
    breaker: 22,
    amps: 20,
    volts: 120,
    protection: 'GFCI',
    rooms: ['laundry'],
  },
  {
    id: 'circuit.bath_outlets',
    label: 'Bathroom outlets',
    breaker: 23,
    amps: 20,
    volts: 120,
    protection: 'GFCI',
    rooms: ['primary_bath', 'hall_bath', 'powder_room'],
  },
  {
    id: 'circuit.garage',
    label: 'Garage: outlets, lights, freezer, door opener',
    breaker: 24,
    amps: 20,
    volts: 120,
    ct: 11,
    protection: 'GFCI',
    rooms: ['garage'],
  },
  {
    id: 'circuit.outside',
    label: 'Outside lights and outlets, pond pump',
    breaker: 25,
    amps: 20,
    volts: 120,
    ct: 16,
    protection: 'GFCI',
  },
  { id: 'circuit.alarms', label: 'Smoke and CO alarms', breaker: 26, amps: 15, volts: 120, protection: 'AFCI' },
  { id: 'circuit.irrigation', label: 'Irrigation and doorbell', breaker: 27, amps: 15, volts: 120 },
  { id: 'pv', label: 'Solar PV (back-fed)', breaker: [28, 30], amps: 40, volts: 240, source: true },
  { id: 'circuit.monitor', label: 'Energy monitor', breaker: [32, 34], amps: 15, volts: 240 },
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
