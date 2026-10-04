import type { V3 } from './geometry.ts';
import { CEIL0, CEIL1, EXT, INT, UP, W } from './dims.ts';
import { ROOMS, eye, pos } from './layout.ts';

// ------------------------------------------------------------------ registry pins (the pins plugin)
export interface Pin {
  id: string;
  name: string;
  category: string;
  room: string;
  at: V3;
  make?: string;
  model?: string;
  approx?: 'room-centroid' | 'z-guess' | null;
  fixtures?: string[];
  ha?: string[];
  specs?: [string, string][];
  note?: string;
}
export const PINS: Pin[] = [
  {
    id: 'hvac.air-handler',
    name: 'Air handler',
    category: 'hvac',
    room: 'hall',
    at: [11.3, 8.4, 1.0],
    make: 'Example Air',
    model: 'AH-36',
    specs: [
      ['capacity', '3 ton'],
      ['filter', '20 × 25 × 4 in'],
    ],
    note: 'In the cupboard under the landing.',
  },
  {
    id: 'hvac.thermostat',
    name: 'Thermostat',
    category: 'hvac',
    room: 'hall',
    at: [7 + INT / 2 + 0.01, 0.8, 1.5],
    make: 'Example Controls',
    model: 'T-100',
    ha: ['climate.thermostat'],
  },
  {
    id: 'elec.panel',
    name: 'Consumer unit',
    category: 'elec',
    room: 'hall',
    at: [W - 0.02, 1.0, 1.6],
    make: 'Example Electric',
    model: 'CU-18',
    specs: [
      ['ways', '18'],
      ['main', '100 A'],
    ],
  },
  {
    id: 'net.router',
    name: 'Router',
    category: 'net',
    room: 'study',
    at: [10.1, 8.6, 0.85],
    make: 'Example Networks',
    model: 'R-6',
    ha: ['device_tracker.router'],
  },
  {
    id: 'net.access-point',
    name: 'Wi-Fi access point (upstairs)',
    category: 'net',
    room: 'landing',
    at: [8.8, 6, UP + 2.2],
    approx: 'room-centroid',
    note: 'On the landing ceiling; exactly where is not recorded.',
  },
  {
    id: 'plumb.water-heater',
    name: 'Water heater',
    category: 'plumb',
    room: 'kitchen',
    at: [0.35, 8.65, 1.6],
    make: 'Example Water',
    model: 'WH-50',
    specs: [['capacity', '190 l']],
  },
  { id: 'plumb.stopcock', name: 'Main stopcock', category: 'plumb', room: 'kitchen', at: [0.3, 5.9, 0.25] },
  {
    id: 'appliance.fridge',
    name: 'Fridge-freezer',
    category: 'appliance',
    room: 'kitchen',
    at: [6.6, 8.6, 1.0],
    make: 'Example Appliances',
    model: 'FF-70',
  },
  {
    id: 'safety.smoke.landing',
    name: 'Smoke alarm (landing)',
    category: 'safety',
    room: 'landing',
    at: [9.6, 5, CEIL1 - 0.03],
    ha: ['binary_sensor.smoke_landing'],
  },
  {
    id: 'site.irrigation',
    name: 'Irrigation controller',
    category: 'site',
    room: 'exterior',
    at: [-EXT - 0.05, 6.5, 1.3],
    make: 'Example Garden',
    model: 'IC-4',
  },
  {
    id: 'fixture.kitchen-pendants',
    name: 'Kitchen pendants',
    category: 'fixture',
    room: 'kitchen',
    at: [3.5, 7, CEIL0 - 0.7],
    fixtures: ['kitchen.pendant.1', 'kitchen.pendant.2', 'kitchen.pendant.3'],
    ha: ['light.kitchen_pendant_1', 'light.kitchen_pendant_2', 'light.kitchen_pendant_3'],
  },
];

export function registryPins() {
  const pins = PINS.map((p) => {
    const r = ROOMS.find((x) => x.id === p.room);
    return {
      id: p.id,
      name: p.name,
      category: p.category,
      status: 'in-service',
      conf: 'high',
      room: p.room,
      pos: pos(p.at),
      plan: p.at.map((v) => +v.toFixed(3)),
      loc_conf: p.approx ? 'low' : 'high',
      approx: p.approx || null,
      loc_note: p.note || null,
      room_centre: r ? eye(r) : null,
      make: p.make || null,
      model: p.model || null,
      serial: null,
      aliases: [],
      specs: p.specs || [],
      connections:
        p.id === 'hvac.thermostat' ? [{ key: 'controls', text: 'the air handler', refs: ['hvac.air-handler'] }] : [],
      documents: p.model ? [{ text: `${p.model} manual (example)`, url: null }] : [],
      photos: [],
      open_questions: [],
      fixtures: p.fixtures || [],
      ha: { entities: p.ha || [] },
      health: null,
      file: 'examples/demo-site/registry_pins.json',
      referenced_by: p.id === 'hvac.air-handler' ? [{ id: 'hvac.thermostat', key: 'controls' }] : [],
    };
  });
  return {
    generated_by: 'tools/make-demo-site.ts',
    frame: 'pos: viewer metres, three.js (X, Z, -Y) of plan metres (X east, Y north, Z up); plan: plan metres',
    count: { items: pins.length + 1, pins: pins.length, unplaced: 1 },
    pins,
    unplaced: [{ id: 'envelope.gutters', name: 'Gutters and downspouts', room: 'exterior', note: 'Not modelled.' }],
  };
}
