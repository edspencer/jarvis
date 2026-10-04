import { ROOMS, eye, pos } from './layout.ts';
import { PINS } from './areas/index.ts';

// ------------------------------------------------------------------ registry pins (the pins plugin)
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
