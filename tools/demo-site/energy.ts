import { FIXTURES } from './fixtures.ts';

// ------------------------------------------------------------------ the energy plugin's map (docs/plugins/energy.md)
// The grid feed, the main panel and its circuits (breakers as on the wall plates), a smart plug and the pond pump's
// switch below their circuits (so there is an Other), PV and a battery. The sensors are invented: ?ha=mock makes up
// their values. Every feed names a real object: registry pins, wall plate boxes, fixture ids, rooms, model nodes.
export function energyMap() {
  const SRC = 'tools/make-demo-site.ts';
  type Feed = { registry?: string; plate?: string; fixture?: string; node?: string; room?: string };
  const circuit = (
    id: string,
    label: string,
    breaker: number | number[],
    feeds: Feed[],
    extra: Record<string, unknown> = {},
  ) => {
    const two = Array.isArray(breaker);
    const sensor = id.replace(/^circuit\./, '').replace(/\W/g, '_');
    return {
      id,
      label,
      ...(two
        ? { power: [`sensor.${sensor}_l1_power`, `sensor.${sensor}_l2_power`], legs: ['L1', 'L2'], volts: 240 }
        : { power: `sensor.${sensor}_power` }),
      energy: { today: `sensor.${sensor}_energy_today` },
      panel: 'Main panel',
      breaker,
      ...(feeds.length ? { feeds } : {}),
      conf: 'high',
      src: SRC,
      ...extra,
    };
  };
  const fixtures = (group: string) => FIXTURES.filter((f) => f.group === group).map((f) => ({ fixture: f.id }));
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
            label: 'Main panel',
            power: ['sensor.main_panel_l1_power', 'sensor.main_panel_l2_power'],
            legs: ['L1', 'L2'],
            remainder: 'sensor.main_panel_balance_power',
            energy: { today: 'sensor.main_panel_energy_today', month: 'sensor.main_panel_energy_month' },
            volts: 240,
            feeds: [{ registry: 'elec.panel' }],
            conf: 'high',
            src: SRC,
            children: [
              circuit('circuit.kitchen_counter', 'Kitchen counter outlets', 1, [
                { node: 'Kitchen_units' },
                { room: 'kitchen' },
              ]),
              circuit('circuit.fridge', 'Fridge-freezer', 3, [{ registry: 'appliance.fridge' }]),
              circuit('circuit.range', 'Range', [2, 4], [{ node: 'Kitchen_units' }]),
              circuit('circuit.living_outlets', 'Living room outlets', 5, [
                { plate: 'LV-O-A' },
                { fixture: 'living.floor_lamp' },
                { room: 'living_room' },
              ]),
              circuit('circuit.lights_ground', 'Lighting, ground floor', 7, [
                { plate: 'LV-S-A' },
                ...fixtures('fixture.cans.living'),
                { fixture: 'hall.pendant' },
                { plate: 'HL-S-A' },
                { room: 'living_room' },
                { room: 'hall' },
              ]),
              circuit('circuit.lights_outside', 'Outside lights', 9, [
                { fixture: 'porch.lantern' },
                ...fixtures('fixture.terrace'),
              ]),
              circuit('circuit.lights_kitchen', 'Kitchen lights', 11, [
                { plate: 'KT-S-A' },
                ...fixtures('fixture.pendants.kitchen'),
                { registry: 'fixture.kitchen-pendants' },
              ]),
              circuit('circuit.study', 'Study outlets', 13, [{ room: 'study' }, { registry: 'net.router' }], {
                children: [
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
              }),
              circuit('circuit.lights_upstairs', 'Lighting, upstairs', 14, [
                { plate: 'BA-S-A' },
                { fixture: 'bathroom.vanity' },
                { fixture: 'bedroom_1.ceiling' },
                { fixture: 'bedroom_2.ceiling' },
                { fixture: 'landing.ceiling' },
                { room: 'bedroom_1' },
                { room: 'bedroom_2' },
                { room: 'bathroom' },
                { room: 'landing' },
              ]),
              circuit('circuit.bedroom_outlets', 'Bedroom outlets', 15, [{ room: 'bedroom_1' }, { room: 'bedroom_2' }]),
              circuit('circuit.garden', 'Garden and pond', 17, [{ node: 'Pond' }, { registry: 'site.irrigation' }], {
                children: [
                  {
                    id: 'switch.pond_pump',
                    label: 'Pond pump',
                    power: 'sensor.pond_pump_power',
                    feeds: [{ node: 'Pond' }],
                    conf: 'high',
                    src: SRC,
                  },
                ],
              }),
              circuit('circuit.heat_pump', 'Heat pump and air handler', [6, 8], [{ registry: 'hvac.air-handler' }]),
              circuit('circuit.water_heater', 'Water heater', [10, 12], [{ registry: 'plumb.water-heater' }]),
              circuit('circuit.dryer', 'Dryer', [16, 18], [], {
                energy: undefined,
                conf: 'low',
                question: 'The model has no laundry: where is the dryer, and is 16+18 really its breaker?',
              }),
            ],
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
