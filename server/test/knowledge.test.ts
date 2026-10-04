// Site knowledge from examples/demo-site: rooms and fixtures from the model, the registry, maps, the search, and the
// prompts.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, formatTurn, loadSite, roomName, searchSite, tokens } from '../src/core/knowledge.ts';

const DEMO = resolve(import.meta.dirname, '../../examples/demo-site');
const site = loadSite(DEMO);

describe('loadSite', () => {
  it('reads the manifest', () => {
    expect(site.name).toBe('Demo house');
    expect(site.timeZone).toBe('Europe/London');
    expect(site.storeys.map((s) => s.name)).toEqual(['ground floor', 'first floor']);
    expect(site.viewpoints).toContain('Kitchen');
    expect(site.layers.map((l) => l.id)).toEqual(['door', 'pergola', 'furniture']);
    expect(site.warnings).toEqual([]);
  });

  it("takes the rooms from the model's floors, with their storeys", () => {
    expect(site.rooms.map((r) => r.id).sort()).toEqual(
      ['bathroom', 'bedroom_1', 'bedroom_2', 'hall', 'kitchen', 'landing', 'living_room', 'study'].sort(),
    );
    expect(site.rooms.find((r) => r.id === 'living_room')).toMatchObject({
      name: 'Living room',
      storey: 'ground floor',
    });
    expect(site.rooms.find((r) => r.id === 'landing')?.storey).toBe('first floor');
    expect(site.rooms.find((r) => r.id === 'kitchen')?.fixtures).toEqual([
      'kitchen.pendant.1',
      'kitchen.pendant.2',
      'kitchen.pendant.3',
    ]);
  });

  it('merges model fixtures (both models) with the HA map', () => {
    const f = Object.fromEntries(site.fixtures.map((x) => [x.id, x]));
    expect(f['kitchen.pendant.1']).toMatchObject({
      kind: 'pendant',
      room: 'kitchen',
      entities: ['light.kitchen_pendant_1'],
    });
    expect(f['landing.ceiling'].entities).toEqual([]);
    expect(f['living.floor_lamp'].entities).toEqual(['light.floor_lamp']); // from furniture.glb + the map
  });

  it('reads the registry, devices and controls', () => {
    expect(site.registry).toHaveLength(12);
    expect(site.registry.find((r) => r.id === 'plumb.water-heater')).toMatchObject({
      name: 'Water heater',
      room: 'kitchen',
      placed: true,
    });
    expect(site.registry.find((r) => r.id === 'envelope.gutters')?.placed).toBe(false);
    expect(site.devices.find((d) => d.id === 'demo-thermostat')).toMatchObject({
      room: 'hall',
      subject: 'pins:hvac.thermostat',
    });
    expect(site.devices.find((d) => d.id === 'demo-hall-motion')?.subject).toBe('room:hall');
    expect(site.controls.map((c) => c.entity_id)).toEqual([
      'script.film_night',
      'script.goodnight',
      'switch.pond_pump',
    ]);
  });

  it('names rooms', () => {
    expect(roomName(site, 'bedroom_1')).toBe('Bedroom 1');
    expect(roomName(site, 'exterior')).toBe('Outside');
    expect(roomName(site, null)).toBe('');
  });
});

describe('searchSite', () => {
  it('tokens: lower case, plurals, stop words', () => {
    expect(tokens("Show me the kitchen's pendants")).toEqual(['kitchen', 'pendant']);
  });

  it('tokens: one spelling for British and American words', () => {
    expect(tokens('Theatre lights')).toEqual(tokens('Theater lights'));
    expect(tokens('centre colour')).toEqual(['center', 'color']);
    // short words keep their shape
    expect(tokens('hour four fire')).toEqual(['hour', 'four', 'fire']);
  });

  it('finds registry items, rooms and fixtures with subjects', () => {
    expect(searchSite(site, 'water heater')[0]).toMatchObject({ kind: 'registry', subject: 'pins:plumb.water-heater' });
    expect(searchSite(site, 'where is the router')[0]).toMatchObject({ id: 'net.router', room: 'study' });
    expect(searchSite(site, 'study')[0]).toMatchObject({ kind: 'room', subject: 'room:study' });
    const pend = searchSite(site, 'kitchen pendants');
    expect(pend[0].id).toBe('fixture.kitchen-pendants');
    expect(pend.some((h) => h.subject === 'fixture:kitchen.pendant.2')).toBe(true);
    expect(searchSite(site, 'thermostat')[0].subject).toBe('pins:hvac.thermostat');
    expect(searchSite(site, 'zzz')).toEqual([]);
    expect(searchSite(site, 'the')).toEqual([]);
  });
});

describe('prompts', () => {
  it('the system prompt is stable and outlines the building and the rules', () => {
    const p = buildSystemPrompt(site);
    expect(buildSystemPrompt(site)).toBe(p);
    expect(p).toContain('Demo house');
    expect(p).toContain('Ground floor: ');
    expect(p).toContain('Bedroom 1');
    expect(p).toContain('ha_find');
    expect(p).toMatch(/Never guess or invent an entity id/);
    expect(p).toMatch(/Safety:/);
    expect(p).not.toMatch(/\b20\d\d\b/); // no dates: the prompt cache must hold
    expect(p).not.toContain('Read, Grep');
    expect(buildSystemPrompt(site, { knowledge: true })).toContain('Read, Grep and Glob');
    expect(p.length).toBeLessThan(6000);
  });

  it('the turn carries the time (site time zone), surface and view', () => {
    const t = formatTurn(
      {
        text: 'what is this?',
        surface: 'screen',
        viewer: true,
        view: { room: 'kitchen', selected: 'pins:appliance.fridge' },
      },
      site,
      new Date('2026-07-01T12:00:00Z'),
    );
    // (the date's punctuation depends on the ICU data)
    expect(t).toMatch(
      /^\[Wed,? 1 Jul 2026,? 13:00; screen with the 3D viewer; viewer in Kitchen \(room:kitchen\), selected pins:appliance\.fridge\]\nwhat is this\?$/,
    );
    expect(formatTurn({ text: 'hi', surface: 'speaker', viewer: false }, site, new Date(0))).toMatch(
      /^\[.*; speaker \(voice only, no screen\)\]\nhi$/,
    );
  });
});
