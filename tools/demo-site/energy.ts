import { SCHEDULE, PANEL } from './panel.ts';
import { onCircuit } from './areas/index.ts';

// ------------------------------------------------------------------ the energy plugin's map (docs/plugins/energy.md)
// The grid feed, the main panel and a meter per circuit of the panel schedule (panel.ts; 240 V ones on two legs), a
// smart plug and the pond pump's switch below their circuits (so there is an Other), PV and a battery. Each circuit
// feeds what the areas put on its breaker (onCircuit: registry pins, wall plates, fixtures, model nodes) and the rooms
// those are in. The sensors are invented: ?ha=mock makes up their values.
const SRC = 'tools/make-demo-site.ts';

/** rooms a circuit feeds though nothing on it is in the model yet */
const MORE_ROOMS: Record<string, string[]> = {
  'circuit.living_outlets': ['living_room', 'hall'],
  'circuit.range': ['kitchen'],
  'circuit.dishwasher': ['kitchen'],
  'circuit.microwave': ['kitchen'],
  'circuit.study': ['study'],
  'circuit.ev_charger': ['garage'],
  'circuit.garage': ['garage'],
  'circuit.washer': ['laundry'],
  'circuit.bath_outlets': ['primary_bath', 'hall_bath', 'powder_room'],
  'circuit.bedrooms': ['bedroom_2', 'bedroom_3', 'hall_bath'],
  'circuit.primary_suite': ['bedroom_1', 'primary_closet', 'primary_bath'],
};

/** meters below a circuit */
const CHILDREN: Record<string, Record<string, unknown>[]> = {
  'circuit.study': [
    {
      id: 'plug.desk',
      label: 'Desk (smart plug)',
      power: 'sensor.desk_plug_power',
      energy: { today: 'sensor.desk_plug_energy_today' },
      feeds: [{ node: 'Furn_desk' }],
      conf: 'high',
      src: SRC,
    },
  ],
  'circuit.outside': [
    {
      id: 'switch.pond_pump',
      label: 'Pond pump',
      power: 'sensor.pond_pump_power',
      feeds: [{ node: 'Pond' }],
      conf: 'high',
      src: SRC,
    },
  ],
};

/** what the map isn't sure of yet */
const QUESTIONS: Record<string, string> = {
  'circuit.dryer': 'The laundry has no dryer in the model yet: where is it, and is 14+16 really its breaker?',
};

type Feed = { registry?: string; plate?: string; fixture?: string; node?: string; room?: string };

function circuitMeter(c: (typeof SCHEDULE)[number]) {
  const on = onCircuit(c.id);
  const rooms = [
    ...new Set(
      // (not switch plates: a switch on this circuit may be in another room than what it switches)
      [...on.pins, ...on.plates.filter((p) => p.kind === 'outlet'), ...on.fixtures]
        .map((x) => x.room)
        .concat(MORE_ROOMS[c.id] ?? [])
        .filter((r) => r !== 'exterior'),
    ),
  ];
  const feeds: Feed[] = [
    ...on.pins.map((p) => ({ registry: p.id })),
    ...on.plates.map((p) => ({ plate: p.id })),
    ...on.fixtures.map((f) => ({ fixture: f.id })),
    ...on.nodes.map((n) => ({ node: n })),
    ...rooms.map((r) => ({ room: r })),
  ];
  const two = Array.isArray(c.breaker);
  const sensor = c.id.replace(/^circuit\./, '').replace(/\W/g, '_');
  const question = QUESTIONS[c.id];
  return {
    id: c.id,
    label: c.label,
    ...(two
      ? { power: [`sensor.${sensor}_l1_power`, `sensor.${sensor}_l2_power`], legs: ['L1', 'L2'], volts: 240 }
      : { power: `sensor.${sensor}_power` }),
    ...(question ? {} : { energy: { today: `sensor.${sensor}_energy_today` } }),
    panel: PANEL.name,
    breaker: c.breaker,
    ...(feeds.length ? { feeds } : {}),
    conf: question ? 'low' : 'high',
    src: SRC,
    ...(question ? { question } : {}),
    ...(CHILDREN[c.id] ? { children: CHILDREN[c.id] } : {}),
  };
}

export function energyMap() {
  return {
    $schema: '../../schema/energy.schema.json',
    jarvis: 'jarvis-energy/1',
    scale: { idle: 5, max: 5000 },
    meters: [
      {
        id: 'grid',
        label: 'Grid',
        kind: 'load',
        power: 'sensor.grid_power',
        conf: 'high',
        src: SRC,
        children: [
          {
            id: 'panel.main',
            label: PANEL.name,
            power: ['sensor.main_panel_l1_power', 'sensor.main_panel_l2_power'],
            legs: ['L1', 'L2'],
            remainder: 'sensor.main_panel_balance_power',
            energy: { today: 'sensor.main_panel_energy_today', month: 'sensor.main_panel_energy_month' },
            volts: 240,
            feeds: [{ registry: 'elec.panel' }],
            conf: 'high',
            src: SRC,
            children: SCHEDULE.filter((c) => !c.source).map(circuitMeter),
          },
        ],
      },
      {
        id: 'pv',
        label: 'Solar',
        kind: 'source',
        power: 'sensor.solar_power',
        energy: { today: 'sensor.solar_energy_today', month: 'sensor.solar_energy_month' },
        conf: 'high',
        src: SRC,
      },
      {
        id: 'battery',
        label: 'Battery',
        kind: 'storage',
        power: 'sensor.battery_power',
        conf: 'high',
        src: SRC,
      },
    ],
  };
}

/** every feed of the map, for the generator's check that each names something that exists */
export function energyFeeds(meters: { feeds?: Feed[]; children?: unknown[] }[] = energyMap().meters): Feed[] {
  return meters.flatMap((m) => [
    ...(m.feeds ?? []),
    ...energyFeeds((m.children ?? []) as { feeds?: Feed[]; children?: unknown[] }[]),
  ]);
}
