import { ROOMS, eye, pos } from './layout.ts';
import { PINS } from './areas/index.ts';
import type { Pin } from './area.ts';

// ------------------------------------------------------------------ registry pins (the pins plugin)
/** a pin's links to others: its own, or the thermostat's to the air handler (kept from before pins had their own) */
const connectionsOf = (p: Pin) =>
  p.connections ??
  (p.id === 'hvac.thermostat' ? [{ key: 'controls', text: 'the air handler', refs: ['hvac.air-handler'] }] : []);

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
      connections: connectionsOf(p),
      documents: p.documents ?? (p.model ? [{ text: `${p.model} manual (example)`, url: null }] : []),
      photos: [],
      open_questions: p.open_questions ?? [],
      fixtures: p.fixtures || [],
      ha: { entities: p.ha || [] },
      health: null,
      file: 'examples/demo-site/registry_pins.json',
      // every pin that links to this one, and how
      referenced_by: PINS.flatMap((q) =>
        connectionsOf(q)
          .filter((c) => c.refs.includes(p.id))
          .map((c) => ({ id: q.id, key: c.key })),
      ),
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
