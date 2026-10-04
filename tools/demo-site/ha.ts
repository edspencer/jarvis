import type { V3 } from './geometry.ts';
import { ROOMS, eye, pos } from './layout.ts';
import { FIXTURES } from './fixtures.ts';
import { PLATES } from './plates.ts';
import { PINS } from './pins.ts';

// ------------------------------------------------------------------ the plugins' data: Home Assistant
export function haMap() {
  const map: Record<string, unknown> = {};
  for (const f of FIXTURES.filter((f) => f.group === 'fixture.cans.living'))
    map[f.id] = { entity_id: 'light.living_room_cans', conf: 'high', group: f.group };
  for (const [i, f] of FIXTURES.filter((f) => f.group === 'fixture.pendants.kitchen').entries())
    map[f.id] = { entity_id: `light.kitchen_pendant_${i + 1}`, conf: 'high', group: f.group, unavailable_means: 'off' };
  map['hall.pendant'] = { entity_id: 'light.hall', conf: 'high', group: 'fixture.hall' };
  map['study.ceiling'] = { entity_id: 'light.study', conf: 'med', group: 'fixture.study' };
  map['bedroom_1.ceiling'] = { entity_id: 'light.bedroom_1', conf: 'high', group: 'fixture.bedroom_1' };
  map['bedroom_2.ceiling'] = { entity_id: null, conf: 'low', group: 'fixture.bedroom_2' };
  map['landing.ceiling'] = { entity_id: null, conf: 'low', group: 'fixture.landing' };
  map['bathroom.vanity'] = {
    entity_id: 'switch.bathroom_vanity',
    conf: 'high',
    group: 'fixture.bathroom',
    switch_is_light: true,
  };
  map['porch.lantern'] = { entity_id: 'light.porch', conf: 'high', group: 'fixture.porch' };
  for (const f of FIXTURES.filter((f) => f.group === 'fixture.terrace'))
    map[f.id] = { entity_id: 'light.terrace_wall_lights', conf: 'high', group: f.group };
  map['living.floor_lamp'] = { entity_id: 'light.floor_lamp', conf: 'high', group: 'fixture.lamp.living' };
  return map;
}

export const haControls = () => ({
  controls: [
    {
      id: 'film',
      label: 'Film night',
      entity_id: 'script.film_night',
      action: 'run',
      mock: { lights_off: ['living_room', 'kitchen', 'hall'] },
    },
    {
      id: 'goodnight',
      label: 'Good night',
      entity_id: 'script.goodnight',
      action: 'run',
      confirm: 'Run Good night? It turns off every light in the house.',
      mock: { lights_off: ['*'] },
    },
    {
      id: 'fountain',
      label: 'Pond pump',
      entity_id: 'switch.pond_pump',
      action: 'toggle',
      power: 'sensor.pond_pump_power',
    },
  ],
  fixture_toggle: { light: true, switch_marked_as_light: true },
});

export function haDevices() {
  const place = (src: string, ref: string | string[] | undefined, room: string, at: V3, approx = false) => {
    const r = ROOMS.find((x) => x.id === room);
    return {
      src,
      ref,
      plan: at.map((v) => +v.toFixed(3)),
      room: r?.name || room,
      approx,
      conf: approx ? 'low' : 'high',
      pos: pos(at),
      centre: r ? eye(r) : null,
    };
  };
  const fx = (id: string) => FIXTURES.find((f) => f.id === id)!;
  const devices = [
    ...[1, 2, 3].map((i) => ({
      id: `demo-kitchen-pendant-${i}`,
      name: `Kitchen pendant ${i}`,
      integration: 'hue',
      make: 'Example Lighting',
      model: 'A19 bulb',
      area: 'Kitchen',
      place: place('fixture', `kitchen.pendant.${i}`, 'kitchen', fx(`kitchen.pendant.${i}`).at),
      fixtures: [`kitchen.pendant.${i}`],
      unavailable_means: {
        off: 'the kitchen pendants wall switch (KT-S-A)',
        unless_on: [1, 2, 3].filter((j) => j !== i).map((j) => `light.kitchen_pendant_${j}`),
      },
      health: { avail: [`light.kitchen_pendant_${i}`], update: [`update.kitchen_pendant_${i}_firmware`] },
    })),
    {
      id: 'demo-living-dimmer',
      name: 'Living room dimmer',
      integration: 'zwave_js',
      make: 'Example Controls',
      model: 'ZD-1',
      area: 'Living room',
      place: place('plate', 'LV-S-A', 'living_room', PLATES[0].at),
      health: { avail: ['light.living_room_cans'], node_status: ['sensor.living_dimmer_node_status'] },
    },
    {
      id: 'demo-thermostat',
      name: 'Thermostat',
      integration: 'zwave_js',
      make: 'Example Controls',
      model: 'T-100',
      area: 'Hall',
      place: place('registry', 'hvac.thermostat', 'hall', PINS[1].at),
      health: {
        avail: ['climate.thermostat'],
        node_status: ['sensor.thermostat_node_status'],
        battery: ['sensor.thermostat_battery'],
      },
    },
    {
      id: 'demo-hall-motion',
      name: 'Hall motion sensor',
      integration: 'zha',
      make: 'Example Sensors',
      model: 'MS-2',
      area: 'Hall',
      place: place('area', 'hall', 'hall', [9.5, 2, 2.2], true),
      health: {
        avail: ['binary_sensor.hall_motion'],
        battery: ['sensor.hall_motion_battery'],
        seen: ['sensor.hall_motion_temperature'],
        signal: [{ entity: 'sensor.hall_motion_lqi', kind: 'lqi' }],
      },
    },
    {
      id: 'demo-leak-sensor',
      name: 'Leak sensor (kitchen sink)',
      integration: 'zha',
      make: 'Example Sensors',
      model: 'WL-1',
      area: 'Kitchen',
      place: place('area', 'kitchen', 'kitchen', [1.5, 8.7, 0.1]),
      health: { avail: ['binary_sensor.kitchen_leak'], battery: ['sensor.kitchen_leak_battery'] },
    },
    {
      id: 'demo-router',
      name: 'Router',
      integration: 'mqtt',
      make: 'Example Networks',
      model: 'R-6',
      area: 'Study',
      place: place('registry', 'net.router', 'study', PINS[3].at),
      health: { avail: ['device_tracker.router'], update: ['update.router_firmware'] },
    },
    {
      id: 'demo-pond-plug',
      name: 'Pond pump plug',
      integration: 'zha',
      make: 'Example Plugs',
      model: 'SP-1',
      area: 'Garden',
      place: place('area', 'garden', 'exterior', [-4.5, -3.3, 0.2], true),
      health: { avail: ['switch.pond_pump'], signal: [{ entity: 'sensor.pond_pump_rssi', kind: 'rssi' }] },
    },
    {
      id: 'demo-floor-lamp',
      name: 'Floor lamp bulb',
      integration: 'hue',
      make: 'Example Lighting',
      model: 'E27 bulb',
      area: 'Living room',
      place: place('fixture', 'living.floor_lamp', 'living_room', [0.55, 4.4, 1.4]),
      fixtures: ['living.floor_lamp'],
      powered_by: 'switch.living_outlet',
      health: { avail: ['light.floor_lamp'] },
    },
    {
      id: 'demo-smoke-landing',
      name: 'Smoke alarm (landing)',
      integration: 'zwave_js',
      make: 'Example Safety',
      model: 'SA-3',
      area: 'Landing',
      place: place('registry', 'safety.smoke.landing', 'landing', PINS[8].at),
      health: {
        avail: ['binary_sensor.smoke_landing'],
        node_status: ['sensor.smoke_landing_node_status'],
        battery: ['sensor.smoke_landing_battery'],
      },
    },
    {
      id: 'demo-doorbell',
      name: 'Doorbell',
      integration: 'mqtt',
      make: 'Example Security',
      model: 'DB-1',
      area: null,
      place: null,
      health: { avail: ['binary_sensor.doorbell'] },
    },
  ];
  return {
    generated_by: 'tools/make-demo-site.ts',
    thresholds: {
      battery_pct: 20,
      lqi_weak: 50,
      rssi_weak_dbm: -85,
      wifi_weak_pct: 30,
      stale_h: { zha: 25, mqtt: 25 },
    },
    devices,
  };
}
