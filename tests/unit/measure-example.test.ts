// docs/guide/writing-a-plugin.md is built around docs/examples/measure.ts: this test checks the guide's excerpts are
// the file's own lines, then runs the plugin against a small fake host (the real event bus and storage, a real
// three.js scene), so the guide can't rot.
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import measure from '../../docs/examples/measure';
import { createStorage } from '../../src/core/plugin/env';
import { createBus } from '../../src/core/plugin/events';
import type {
  Block,
  ButtonSpec,
  Disposable,
  KeyBinding,
  PanelSpec,
  PickResult,
  PluginContext,
  SectionContentBlocks,
  SectionProvider,
  StatusItemSpec,
  Subject,
} from '../../src/plugin-api';

const ROOT = new URL('../../', import.meta.url);

it("the guide's excerpts are in the files they name", () => {
  const page = readFileSync(new URL('docs/guide/writing-a-plugin.md', ROOT), 'utf8');
  const trim = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trim())
      .join('\n');
  // an excerpt starts with a comment naming its file, and may skip lines (`// …`); each run between the skips is the
  // file's, word for word (indentation aside)
  const blocks = [...page.matchAll(/```ts\n\/\/ (\S+\.ts)\n([\s\S]*?)\n```/g)];
  const quoted = (name: string) => blocks.filter((m) => m[1] === name).length;
  expect(quoted('docs/examples/measure.ts')).toBeGreaterThan(4);
  expect(quoted('tests/unit/measure-example.test.ts')).toBe(2);
  for (const [, name, b] of blocks) {
    const file = trim(readFileSync(new URL(name, ROOT), 'utf8'));
    for (const run of b.split(/^\s*\/\/ …\n/m)) expect(file, name).toContain(trim(run).trim());
  }
});

/** a localStorage stand-in */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

async function start(opts: { config?: object; ls?: Storage } = {}) {
  const bus = createBus();
  const owned: Disposable[] = [];
  const own = (d: Disposable | (() => void)) => owned.push(typeof d === 'function' ? { dispose: d } : d);
  const scene = new THREE.Scene();
  const keys: KeyBinding[] = [];
  const panels: PanelSpec[] = [];
  const sections: SectionProvider[] = [];
  const items: StatusItemSpec[] = [];
  const toasts: string[] = [];
  const hits: (THREE.Vector3 | null)[] = []; // what the next picks find
  let current: Subject | null = null;
  const inspector = {
    registerSubject: vi.fn(),
    addSection: (s: SectionProvider) => sections.push(s),
    refresh: vi.fn(),
    open: vi.fn((ref: string) => (current = { kind: 'item', id: ref })),
    close: vi.fn(() => (current = null)),
    current: () => current,
  };
  const ctx = {
    id: 'measure',
    config: opts.config ?? {},
    site: { units: 'm' },
    three: { THREE, scene, toPlan: (v: THREE.Vector3) => ({ X: v.x, Y: -v.z, Z: v.y }) },
    view: { aim: () => new THREE.Vector2(), fly: vi.fn() },
    pick: {
      model: (): PickResult | null => {
        const p = hits.shift();
        return p ? ({ node: scene, hit: { point: p }, part: null } as unknown as PickResult) : null;
      },
    },
    events: bus.scoped('measure', own, (err) => {
      throw err;
    }),
    keys: { add: (k: KeyBinding) => keys.push(k) },
    hud: { addPanel: (p: PanelSpec) => (panels.push(p), { refresh: vi.fn() }), invalidate: vi.fn() },
    status: { addItem: (i: StatusItemSpec) => items.push(i) },
    inspector,
    storage: createStorage('jarvis.demo.measure', opts.ls ?? memoryStorage()),
    toast: (t: string) => toasts.push(t),
    expose: vi.fn(),
    own,
  } as unknown as PluginContext<object>;
  await measure.setup(ctx as never);

  const key = (code: string, shift = false) => keys.find((k) => k.code === code && !!k.shift === shift)!;
  const press = (code: string, shift = false) => key(code, shift).run!({} as KeyboardEvent);
  /** a click on the view, the way the core sends it; true if the plugin took it */
  const click = (at: THREE.Vector3 | null) => {
    hits.push(at);
    const e = { subject: null, shiftKey: false, handled: false };
    bus.emit('click', e);
    return e.handled;
  };
  const panelBlocks = () => {
    let fn: () => unknown[] = () => [];
    panels[0].render({ blocks: (f: () => unknown[]) => (fn = f) } as never);
    return fn().filter(Boolean) as Block[];
  };
  const rows = () => (panelBlocks().find((b) => b.type === 'list') as Extract<Block, { type: 'list' }>).rows;
  const section = (id: string) => sections[0].for({ kind: 'item', id: `measure:${id}` }) as SectionContentBlocks;
  const lines = () => scene.getObjectByName('measure')!.children.filter((o) => o instanceof THREE.Line);
  return {
    bus,
    scene,
    keys,
    key,
    press,
    panels,
    items,
    toasts,
    inspector,
    click,
    panelBlocks,
    rows,
    section,
    lines,
    owned,
  };
}

describe('the measure example runs', () => {
  it('claims M, Shift-M and Esc, adds the panel, a status item (hidden until measuring) and a group in the scene', async () => {
    const { keys, panels, items, scene } = await start();
    expect(keys.map((k) => [k.code, !!k.shift])).toEqual([
      ['KeyM', false],
      ['KeyM', true],
      ['Escape', false],
    ]);
    expect(measure.keys).toEqual(['M']); // declared: every letter it binds
    expect(panels.map((p) => p.id)).toEqual(['measure']);
    expect(items[0].render()).toBeNull();
    expect(scene.getObjectByName('measure')).toBeTruthy();
  });

  it('Esc stops measuring, and wants the key only while measuring', async () => {
    const { key, press, items, click } = await start();
    expect(key('Escape').when!()).toBe(false);
    press('KeyM');
    click(new THREE.Vector3(1, 0, 1)); // half a measurement: dropped
    expect(key('Escape').when!()).toBe(true);
    press('Escape');
    expect(items[0].render()).toBeNull();
    expect(key('Escape').when!()).toBe(false);
    expect(click(new THREE.Vector3(0, 0, 0))).toBe(false); // clicks inspect again
  });

  it('checks its section: unknown fields and wrong types are problems, {} is fine', () => {
    expect(measure.validate!({})).toEqual([]);
    expect(measure.validate!({ colour: '#fff', decimals: 1 })).toEqual([]);
    expect(measure.validate!({ decimal: 1, colour: 3, decimals: 1.5 })).toEqual([
      'decimal: unknown field (expected colour, decimals)',
      "colour: expected a CSS colour ('#ffb000')",
      'decimals: expected a whole number',
    ]);
  });

  it('leaves clicks alone until M is pressed', async () => {
    const { click, rows } = await start();
    expect(click(new THREE.Vector3(0, 0, 0))).toBe(false);
    expect(rows()).toEqual([]);
  });

  it('measures between two clicked points, draws the line, lists it, opens it and tells other plugins', async () => {
    const { press, click, items, rows, lines, inspector, bus } = await start();
    const added: unknown[] = [];
    bus.on('measure:added', (e) => added.push(e));
    press('KeyM');
    expect(items[0].render()?.text).toBe('click the first point');
    expect(click(new THREE.Vector3(1, 0, 1))).toBe(true);
    expect(items[0].render()?.text).toBe('click the second point');
    expect(click(new THREE.Vector3(4, 4, 1))).toBe(true); // 3 across, 4 up: 5 m
    expect(rows()).toMatchObject([{ text: 'Measurement 1', value: '5.00 m', subject: 'measure:1' }]);
    expect(lines()).toHaveLength(1);
    expect(inspector.open).toHaveBeenCalledWith('measure:1');
    expect(added).toEqual([{ id: '1', metres: 5 }]);
  });

  it('says so when a click finds nothing, and takes no point', async () => {
    const { press, click, toasts, items } = await start();
    press('KeyM');
    expect(click(null)).toBe(true);
    expect(toasts).toEqual(['Nothing there to measure to']);
    expect(items[0].render()?.text).toBe('click the first point');
  });

  it("the inspector section splits it into horizontal and vertical, in the site's plan units", async () => {
    const { press, click, section } = await start({ config: { decimals: 1 } });
    press('KeyM');
    click(new THREE.Vector3(0, 0, 0));
    click(new THREE.Vector3(3, 4, 0));
    const blocks = section('1').blocks as Block[];
    expect(blocks[0]).toEqual({ type: 'meter', value: '5.0', unit: 'm' });
    expect(blocks[1]).toMatchObject({
      type: 'kv',
      rows: [
        ['Horizontal', '3.0 m'],
        ['Vertical', '4.0 m'],
        ['From', { text: '0.0, 0.0, 0.0 m' }],
        ['To', { text: '3.0, 0.0, 4.0 m' }],
      ],
    });
    expect(section('2')).toBeNull();
  });

  it('switches to feet and remembers the choice for the next visit', async () => {
    const ls = memoryStorage();
    const a = await start({ ls });
    a.press('KeyM');
    a.click(new THREE.Vector3(0, 0, 0));
    a.click(new THREE.Vector3(0.3048, 0, 0));
    const units = a.panelBlocks().find((b) => b.type === 'segmented') as Extract<Block, { type: 'segmented' }>;
    units.onChange('ft');
    expect(a.rows()[0].value).toBe('1.00 ft');
    const b = await start({ ls });
    expect((b.panelBlocks().find((x) => x.type === 'segmented') as { value: string }).value).toBe('ft');
  });

  it('Delete removes one (and closes the inspector on it); Shift-M and Clear all remove the rest', async () => {
    const { key, press, click, section, rows, lines, inspector, panels } = await start();
    press('KeyM');
    for (const x of [1, 2, 3, 4]) click(new THREE.Vector3(x, 0, 0));
    expect(rows()).toHaveLength(2);
    (section('2').actions as ButtonSpec[])[0].onClick();
    expect(inspector.close).toHaveBeenCalled();
    expect(rows().map((r) => r.id)).toEqual(['1']);
    expect(lines()).toHaveLength(1);
    expect(panels[0].actions!()[0]).toMatchObject({ label: 'Clear all', confirm: 'Clear every measurement?' });
    expect(key('KeyM', true).when!()).toBe(true);
    press('KeyM', true);
    expect(rows()).toEqual([]);
    expect(lines()).toHaveLength(0);
    expect(key('KeyM', true).when!()).toBe(false);
  });

  it('when the plugin stops, its group leaves the scene and its handlers go', async () => {
    const { owned, scene, bus, press, click } = await start();
    press('KeyM');
    for (const d of owned.splice(0).reverse()) d.dispose();
    expect(scene.children).toEqual([]);
    expect(bus.count('click')).toBe(0);
    expect(click(new THREE.Vector3())).toBe(false);
  });
});
