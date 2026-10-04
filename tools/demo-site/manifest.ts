import { G, SLAB, UP, WING } from './dims.ts';

export const REPO = 'https://github.com/edspencer/jarvis';

// ------------------------------------------------------------------ the manifest
export function manifest() {
  return {
    $schema: '../../schema/site.schema.json',
    jarvis: 'jarvis-site/1',
    id: 'demo-house',
    name: 'Demo house',
    description: 'A synthetic four-bedroom house with a garage, made by tools/make-demo-site.ts.',
    geo: { lat: 51.4779, lon: -0.0015, timeZone: 'Europe/London' },
    frame: { units: 'm', northAzimuth: 12 },
    centre: [9.5, 4.5],
    overview: { camera: [24, -10, 21] },
    ground: { z: G.lawn - 0.02 },
    models: {
      main: { url: 'demo.glb', parts: 'demo.parts.json' },
      extra: [{ id: 'furniture', url: 'furniture.glb', parts: 'furniture.parts.json', layer: 'furniture' }],
    },
    storeys: [
      { name: 'ground floor', z: 0 },
      { name: 'first floor', short: 'upstairs', z: UP, from: 1.8, objectsFrom: SLAB - 0.05 },
    ],
    viewpoints: [
      { name: 'Front of the house', at: [9.4, -14, G.lawn], yaw: 0 },
      { name: 'Living room', at: [3.6, 4.5, 0], yaw: 180 },
      { name: 'Kitchen', at: [6.2, 5.6, 0], yaw: 45 },
      { name: 'Foot of the stair', at: [11.3, 1.2, 0], yaw: 0 },
      { name: 'Landing', at: [10.2, 4.6, UP], yaw: 90 },
      { name: 'Primary bedroom', at: [6.2, 3.4, UP], yaw: 120 },
      { name: 'Back terrace', at: [5, 18, G.lawn], yaw: 200 },
      { name: 'Garage', at: [17.6, 8.4, WING.z], yaw: 160 },
    ],
    startView: 2,
    layers: [
      { id: 'door', label: 'Doors', key: 'O', hidden: true, help: 'door leaves', match: { extra: ['door_leaf'] } },
      { id: 'pergola', label: 'Pergola', key: 'K', help: 'the pergola', match: { namePrefix: ['Pergola_'] } },
      { id: 'furniture', label: 'Furniture', key: 'F', help: 'the furniture' },
    ],
    walk: { maxStep: 0.35 },
    plugins: {
      'home-assistant': { url: 'https://homeassistant.example.org', controls: 'ha_controls.json' },
      lights: { map: 'ha_map.json' },
      faults: { devices: 'ha_devices.json', source: 'tools/make-demo-site.ts' },
      pins: { registry: 'registry_pins.json', sourceLink: `${REPO}/blob/main/{file}` },
      switches: { source: 'tools/make-demo-site.ts' },
      blueprints: { index: 'blueprints/index.json', default: 'A-1' },
      energy: { map: 'energy.json' },
      // (no assistant: it needs a server of its own, docs/assistant.md; the e2e test adds the section)
    },
  };
}
