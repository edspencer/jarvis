import { G, SLAB, UP } from './dims.ts';

export const REPO = 'https://github.com/edspencer/jarvis';

// ------------------------------------------------------------------ the manifest
export function manifest() {
  return {
    $schema: '../../schema/site.schema.json',
    jarvis: 'jarvis-site/1',
    id: 'demo-house',
    name: 'Demo house',
    description: 'A synthetic two-storey house made by tools/make-demo-site.ts.',
    geo: { lat: 51.4779, lon: -0.0015, timeZone: 'Europe/London' },
    frame: { units: 'm', northAzimuth: 12 },
    centre: [6, 5],
    overview: { camera: [18, -6, 19] },
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
      { name: 'Front path', at: [9.5, -6, G.lawn], yaw: 10 },
      { name: 'Living room', at: [5.6, 0.8, 0], yaw: 50 },
      { name: 'Kitchen', at: [6.2, 5.6, 0], yaw: 120 },
      { name: 'Foot of the stair', at: [11.3, 1.2, 0], yaw: 0 },
      { name: 'Landing', at: [11.3, 8.3, UP], yaw: 140 },
      { name: 'Bedroom 1', at: [5.8, 4.2, UP], yaw: 135 },
      { name: 'Back terrace', at: [6, 12.4, 0], yaw: 180 },
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
