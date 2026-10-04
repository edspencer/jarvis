// docs/plugins.md's worked example is docs/examples/irrigation.ts, word for word: this test checks the page quotes the
// file, then runs the plugin against the real entity store and Home Assistant's allow-list, so the docs can't rot.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import irrigation from '../../docs/examples/irrigation';
import { createStore } from '../../src/core/plugin/store';
import type {
  ButtonSpec,
  PanelSpec,
  PluginContext,
  SectionProvider,
  SectionContentBlocks,
  Subject,
} from '../../src/plugin-api';
import { allowRefusal, buildAllowlist, planCalls } from '../../src/plugins/home-assistant/policy';

const ROOT = new URL('../../', import.meta.url);

it('docs/plugins.md quotes docs/examples/irrigation.ts exactly', () => {
  const page = readFileSync(new URL('docs/plugins.md', ROOT), 'utf8');
  const file = readFileSync(new URL('docs/examples/irrigation.ts', ROOT), 'utf8').trim();
  const at = page.indexOf('## A worked example');
  const block = /```ts\n([\s\S]*?)\n```/.exec(page.slice(at))![1].trim();
  expect(block).toBe(file);
});

describe('the worked example runs', () => {
  async function start() {
    const store = createStore();
    // the site's controls file lists zone 1's valve as a toggle control (turn_on / turn_off); zone 2 isn't listed
    const allow = buildAllowlist({
      controls: [{ id: 'z1', label: 'Front beds', entity_id: 'switch.garden_zone_1', action: 'toggle' }],
      map: {},
      toggle: {},
    });
    const sent: [string, string][] = [];
    const conn = store.addConnector({
      id: 'home-assistant',
      name: 'Home Assistant',
      refusal: (ids, action) => allowRefusal(allow, action, { entity_id: ids }),
      call: async (ids, action) => {
        const plan = planCalls(ids, action, {}, allow);
        if ('refused' in plan) throw new Error(plan.refused);
        for (const [, d] of plan.calls) sent.push([String(d.entity_id), action]);
      },
    });
    conn.update([
      { entity_id: 'switch.garden_zone_1', state: 'off', attributes: {} },
      { entity_id: 'switch.garden_zone_2', state: 'off', attributes: {} },
    ]);
    conn.status('live');
    const sections: SectionProvider[] = [];
    const panels: PanelSpec[] = [];
    const toasts: string[] = [];
    const ctx = {
      config: { zones: 'irrigation.json' },
      load: async () => ({
        zones: [
          { id: 'z1', name: 'Front beds', valve: 'switch.garden_zone_1', at: [40, 75, 0] },
          { id: 'z2', name: 'Back lawn', valve: 'switch.garden_zone_2', at: [10, 5, 0] },
        ],
      }),
      store,
      inspector: { registerSubject: vi.fn(), addSection: (s: SectionProvider) => sections.push(s), refresh: vi.fn() },
      hud: { addPanel: (p: PanelSpec) => (panels.push(p), { refresh: vi.fn() }) },
      view: { fly: vi.fn() },
      three: { P: vi.fn() },
      search: { add: vi.fn() },
      toast: (t: { text: string }) => toasts.push(t.text),
    } as unknown as PluginContext<{ zones: string }>;
    await irrigation.setup(ctx);
    const zone = (id: string) =>
      sections[0].for({ kind: 'item', id: `irrigation:${id}` } as Subject) as SectionContentBlocks;
    return { store, sent, zone, panels, toasts, conn };
  }

  it('offers Run on an allowed, idle zone and calls exactly the action it checked (turn_on, then turn_off)', async () => {
    const { sent, zone, conn } = await start();
    const run = zone('z1').actions as ButtonSpec[];
    expect(run.map((b) => b.label)).toEqual(['Run']);
    run[0].onClick();
    await Promise.resolve();
    expect(sent).toEqual([['switch.garden_zone_1', 'turn_on']]);
    conn.update([{ entity_id: 'switch.garden_zone_1', state: 'on', attributes: {} }]);
    const stop = zone('z1').actions as ButtonSpec[];
    expect(stop.map((b) => b.label)).toEqual(['Stop']);
    stop[0].onClick();
    await Promise.resolve();
    expect(sent.at(-1)).toEqual(['switch.garden_zone_1', 'turn_off']);
  });

  it("says why it can't switch a zone the allow-list doesn't name, and offers no button", async () => {
    const { zone, sent } = await start();
    const c = zone('z2');
    expect(c.actions).toEqual([]);
    expect(JSON.stringify(c.blocks)).toMatch(/Can't switch: refused: switch.garden_zone_2/);
    expect(sent).toEqual([]);
  });

  it('binds each zone to its valve and adds the panel', async () => {
    const { store, panels } = await start();
    expect(store.entitiesOf('irrigation:z1')).toEqual(['switch.garden_zone_1']);
    expect(panels.map((p) => p.id)).toEqual(['irrigation']);
  });
});
