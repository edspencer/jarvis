import { SCHEDULE, PANEL, breakerText, circuit, type Circuit } from './panel.ts';
import { onCircuit } from './areas/index.ts';

// ------------------------------------------------------------------ the energy plugin's map (docs/plugins/energy.md)
// The house as a 16-channel circuit monitor (an Emporia Vue 2 stand-in, docs/demo-house.md#electrical-service) reports
// it to Home Assistant: the grid (the utility meter) → the main panel, measured by the monitor's two mains clamps as
// legs A and B, with the monitor's Balance as its Other → a meter per clamped circuit of the panel schedule (panel.ts),
// each feeding whatever the areas put on its breaker (onCircuit: registry pins, model nodes, wall plates, fixtures)
// and the rooms those are in; a smart plug and the pond pump's switch below their circuits; solar and the battery as
// their own roots. The sensors are named as ESPHome names them and are invented: ?ha=mock makes up their values from
// each meter's label (src/plugins/energy/mock.ts).
//
// Circuits without a clamp are left out of the map. A meter needs power of its own or children (the validator
// rejects one with neither), and the monitor knows nothing about those circuits except that they are in its Balance:
// so they show as the main panel's Other, the way the monitor's own app shows them, rather than as rows that would
// always read "no data" (grey in energy mode, and the Top consumers list padded with blanks).
const SRC = 'tools/make-demo-site.ts (panel schedule, monitor clamps)';

const sensor = (c: Circuit) => `vue2_${c.id.replace(/^circuit\./, '').replace(/\W/g, '_')}`;

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
      src: 'the plug',
    },
  ],
  'circuit.outside': [
    {
      id: 'switch.pond_pump',
      label: 'Pond pump',
      power: 'sensor.pond_pump_power',
      feeds: [{ node: 'Pond' }],
      conf: 'high',
      src: 'the pump plug',
    },
  ],
};

/** what the map isn't sure of */
const QUESTIONS: Record<string, string> = {
  'circuit.outside':
    "The coach lights by the garage door switch from the garage: are they on 25 with the other outside lights, or on the garage's 24? A breaker trip test would tell.",
};

type Feed = { registry?: string; plate?: string; fixture?: string; node?: string; room?: string };

function circuitMeter(c: Circuit) {
  const on = onCircuit(c.id);
  const rooms = [
    ...new Set(
      // the rooms of its equipment and outlets: not its lights (a room is tinted by the sum of the meters feeding
      // it, so a lighting circuit across five rooms would paint all five with its whole load), nor its switch
      // plates (a switch on this circuit may be in another room than what it switches)
      [...on.pins.filter((p) => p.category !== 'fixture'), ...on.plates.filter((p) => p.kind === 'outlet')]
        .map((x) => x.room)
        .concat(c.rooms ?? [])
        .filter((r) => r !== 'exterior'),
    ),
  ];
  // the first feed is where the meter's rows fly to: the equipment, the appliances' nodes, then the outlets, the
  // lights, and last the switches (a switch on this circuit may be in another room than what it switches)
  const feeds: Feed[] = [
    ...on.pins.map((p) => ({ registry: p.id })),
    ...on.nodes.map((n) => ({ node: n })),
    ...on.plates.filter((p) => p.kind === 'outlet').map((p) => ({ plate: p.id })),
    ...on.fixtures.map((f) => ({ fixture: f.id })),
    ...on.plates.filter((p) => p.kind !== 'outlet').map((p) => ({ plate: p.id })),
    ...rooms.map((r) => ({ room: r })),
  ];
  const s = sensor(c);
  const question = QUESTIONS[c.id];
  return {
    id: c.id,
    label: c.label,
    power: `sensor.${s}_power`,
    energy: { today: `sensor.${s}_energy_today` },
    panel: PANEL.name,
    breaker: breakerText(c),
    volts: c.volts,
    ...(feeds.length ? { feeds } : {}),
    conf: question ? 'low' : 'high',
    src: SRC,
    ...(question ? { question } : {}),
    note:
      `CT ${c.ct}` +
      (c.volts === 240 ? ' on one leg (a 240 V load: the monitor doubles it)' : '') +
      `; ${c.amps} A breaker${c.protection ? `, ${c.protection === 'dual' ? 'AFCI/GFCI' : c.protection}` : ''}`,
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
        // no power of its own: the panel's mains clamps are the house's feed, so the grid is their sum
        feeds: [{ registry: 'elec.meter' }, { node: 'Utility_meter' }],
        conf: 'high',
        src: SRC,
        children: [
          {
            id: 'panel.main',
            label: PANEL.name,
            power: ['sensor.vue2_phase_a_power', 'sensor.vue2_phase_b_power'],
            legs: ['A', 'B'],
            remainder: 'sensor.vue2_balance_power',
            energy: { today: 'sensor.vue2_total_energy_today', month: 'sensor.vue2_total_energy_month' },
            volts: 240,
            feeds: [
              { registry: 'elec.panel' },
              { node: 'Panel_main' },
              { registry: 'elec.energy-monitor' },
              { node: 'Energy_monitor' },
            ],
            conf: 'high',
            src: SRC,
            note:
              "The monitor's two 200 A mains clamps (phases A and B). Its Balance (the Other) is the mains less the " +
              '16 circuit clamps: the circuits without one (the microwave, the washer, the bathroom outlets, the ' +
              'alarms, the irrigation and doorbell, the monitor itself) and anything a clamp misses. The solar ' +
              "back-feeds the panel, so the monitor's settings add the inverter's output back: this is what the " +
              'house uses, not what it draws from the grid.',
            children: SCHEDULE.filter((c) => !c.source && c.ct).map(circuitMeter),
          },
        ],
      },
      {
        id: 'pv',
        label: 'Solar',
        kind: 'source',
        power: 'sensor.solar_power',
        energy: { today: 'sensor.solar_energy_today', month: 'sensor.solar_energy_month' },
        panel: PANEL.name,
        breaker: breakerText(circuit('pv')),
        volts: 240,
        feeds: [{ registry: 'elec.inverter' }, { node: 'PV_inverter' }, { node: 'Roof_solar' }],
        conf: 'high',
        src: "the inverter's own integration",
      },
      {
        id: 'battery',
        label: 'Battery',
        kind: 'storage',
        power: 'sensor.battery_power',
        feeds: [{ registry: 'elec.battery' }, { node: 'Home_battery' }],
        conf: 'high',
        src: "the battery's own integration",
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
