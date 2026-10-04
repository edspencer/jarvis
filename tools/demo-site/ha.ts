import { DEVICES, HA_MAP } from './areas/index.ts';

// ------------------------------------------------------------------ the plugins' data: Home Assistant
export const haMap = () => HA_MAP;

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
  const devices = DEVICES;
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
