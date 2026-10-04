// The energy plugin's edge cases found in review: a remainder without power, ids that clash with a generated Other,
// partial sums for a thing several meters feed, the bounded tint palette, and energy mode's material swap leaving a
// mesh's own material where another plugin (the lights) can find it.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { EntityState, ModelInfo } from '../../src/plugin-api';
import { checkEnergyMap, type MeterSpec } from '../../src/plugins/energy/map';
import { buildTree, compute, consumers, countable, sumOf, totals } from '../../src/plugins/energy/tree';
import { loadColour } from '../../src/plugins/energy/scale';
import { createEnergyScene } from '../../src/plugins/energy/scene';

const get =
  (states: Record<string, string>) =>
  (id: string): EntityState | undefined =>
    states[id] === undefined
      ? undefined
      : { entity_id: id, state: states[id], attributes: { unit_of_measurement: 'W' } };
const run = (meters: MeterSpec[], states: Record<string, string>) => {
  const tree = buildTree({ meters });
  return { tree, rs: compute(tree, get(states)) };
};

describe('energy: a remainder on a meter without power', () => {
  const meters: MeterSpec[] = [
    {
      id: 'p',
      remainder: 'sensor.bal',
      children: [
        { id: 'a', power: 'sensor.a' },
        { id: 'b', power: 'sensor.b' },
      ],
    },
  ];
  it('makes no Other (its power is its children sum), so the consumers add up to the load', () => {
    const { tree, rs } = run(meters, { 'sensor.a': '100', 'sensor.b': '50', 'sensor.bal': '300' });
    expect(tree.byId['p'].other).toBeNull();
    const sum = consumers(tree).reduce((a, m) => a + (rs.get(m.id)!.w ?? 0), 0);
    expect(sum).toBe(150);
    expect(totals(tree, rs).load).toBe(150);
  });
  it('is a warning in the map check', () => {
    const v = checkEnergyMap({ jarvis: 'jarvis-energy/1', meters });
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.path)).toEqual(['meters[0].remainder']);
  });
});

describe('energy: ids', () => {
  it("rejects an id ending in .other (a parent's Other)", () => {
    const v = checkEnergyMap({
      jarvis: 'jarvis-energy/1',
      meters: [
        { id: 'panel.a', power: 'sensor.p', children: [{ id: 'c', power: 'sensor.c' }] },
        { id: 'panel.a.other', power: 'sensor.x' },
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.path)).toEqual(['meters[1].id']);
  });
});

describe('energy: something several meters feed', () => {
  const meters: MeterSpec[] = [
    {
      id: 'circ',
      power: 'sensor.circ',
      children: [{ id: 'plug', power: 'sensor.plug' }],
    },
    { id: 'range', power: 'sensor.range' },
  ];
  const ms = (tree: ReturnType<typeof buildTree>) => [tree.byId.circ, tree.byId.plug, tree.byId.range];
  it('counts a meter once (not with its ancestor), and is whole when all have data', () => {
    const { tree, rs } = run(meters, { 'sensor.circ': '300', 'sensor.plug': '100', 'sensor.range': '50' });
    expect(sumOf(ms(tree), rs)).toEqual({ w: 350, partial: false });
  });
  it('says it is partial when one has no data, rather than passing the smaller sum off as whole', () => {
    const { tree, rs } = run(meters, { 'sensor.circ': '300', 'sensor.plug': '100', 'sensor.range': 'unavailable' });
    expect(sumOf(ms(tree), rs)).toEqual({ w: 300, partial: true });
  });
  it("counts a descendant when its ancestor has no data (the plug, when the circuit's sensor is down)", () => {
    const { tree, rs } = run(meters, { 'sensor.circ': 'unavailable', 'sensor.plug': '100', 'sensor.range': '50' });
    expect(countable(ms(tree), rs).map((m) => m.id)).toEqual(['circ', 'plug', 'range']); // circ counts as no data
    expect(sumOf(ms(tree), rs)).toEqual({ w: 150, partial: true });
  });
  it('is null when none has data', () => {
    const { tree, rs } = run(meters, {});
    expect(sumOf(ms(tree), rs).w).toBeNull();
  });
});

describe('energy: the tint palette is bounded', () => {
  it('a sweep of loads gives at most 49 colours above idle', () => {
    const colours = new Set<string>();
    for (let w = 5.01; w < 20000; w *= 1.002) colours.add(loadColour(w));
    expect(colours.size).toBeLessThanOrEqual(49);
    expect(colours.size).toBeGreaterThan(20);
  });
});

describe('energy mode: the material swap', () => {
  Object.assign(globalThis, { innerWidth: 800, innerHeight: 600 }); // the markers size to the viewport
  function setup() {
    const scene = new THREE.Scene();
    const root = new THREE.Group();
    const own = new THREE.MeshStandardMaterial({ name: 'oak' });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), own);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'tile' }));
    root.add(mesh, floor);
    scene.add(root);
    const model = { root, groups: { upper: [] }, rooms: [floor], fixtures: {} } as unknown as ModelInfo;
    const camera = new THREE.PerspectiveCamera();
    return { es: createEnergyScene({ scene, model, camera }), mesh, floor, own };
  }
  it('ghosts, tints, and puts every material back', () => {
    const { es, mesh, floor, own } = setup();
    const floorOwn = floor.material;
    es.show({ nodes: new Map(), rooms: new Map([[floor, '#ff0000']]), anchors: [] });
    expect(mesh.material).toBe(es.ghost);
    expect((floor.material as THREE.Material).name).toMatch(/^energy\.room\./);
    es.hide();
    expect(mesh.material).toBe(own);
    expect(floor.material).toBe(floorOwn);
  });
  it("leaves the mesh's own material in userData.baseMaterial while swapped (the lights read it), and clears it", () => {
    const { es, mesh, own } = setup();
    es.show({ nodes: new Map(), rooms: new Map(), anchors: [] });
    expect(mesh.userData.baseMaterial).toBe(own);
    es.hide();
    expect(mesh.userData.baseMaterial).toBeUndefined();
  });
  it("keeps another plugin's swap made meanwhile: re-ghosts it, and puts theirs back", () => {
    const { es, mesh } = setup();
    es.show({ nodes: new Map(), rooms: new Map(), anchors: [] });
    const theirs = new THREE.MeshStandardMaterial({ name: 'lamp-clone' });
    mesh.material = theirs; // the lights prepare a fixture while energy mode is on
    es.show({ nodes: new Map(), rooms: new Map(), anchors: [] });
    expect(mesh.material).toBe(es.ghost);
    expect(mesh.userData.baseMaterial).toBe(theirs);
    es.hide();
    expect(mesh.material).toBe(theirs);
    es.dispose();
  });
});
