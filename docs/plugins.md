# Writing a plugin

Everything JARVIS shows over the 3D view comes from plugins through one API: the core's own Navigate panel and layer
chips use it too (`src/core/builtin.ts`). The types in [`src/core/plugin/types.ts`](../src/core/plugin/types.ts) are
the public contract; this page explains them. The HUD design they implement is
[`design/hud-panels.md`](design/hud-panels.md).

## The shape of a plugin

```ts
import { definePlugin } from '../../core/plugin/types';

export default definePlugin<{ zones: string }>({
  id: 'irrigation', // the manifest key: plugins.irrigation
  name: 'Irrigation', // shown in help, toasts and the inspector
  requires: [], // plugins that must be running first (it doesn't start without them)
  after: ['home-assistant'], // start after these if they are present (soft ordering)
  async setup(ctx) {
    // register panels, sections, chips, keys…; everything is removed again when the plugin stops
    return { dispose() {} }; // optional: your own cleanup
  },
});
```

**When it starts.** Once the main model is in, for every plugin whose section is in the manifest (`plugins.<id>`), or
that is marked `autoStart`. `ctx.config` is that section, with paths resolved against the manifest. Plugins start in
parallel; one waits only for those named in `requires` and `after`. A cycle is an error.

**When it fails.** If `setup` throws or rejects, or a required plugin isn't running, the plugin is stopped, everything
it registered so far is disposed, and a toast says so ("Equipment pins is off: registry.json: HTTP 404"). The rest of
the walkthrough carries on. An event handler that throws later is logged once and reported once; the frame loop keeps
running.

**Built-in plugins** are listed in [`src/plugins/registry.ts`](../src/plugins/registry.ts), each loaded as its own
chunk, with the letter keys it claims (the site validator keeps a site layer's key off them; the key registry warns
if a plugin uses a letter it didn't declare).

## `ctx`: what a plugin gets

| Field                       | What                                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site`, `config`            | The resolved manifest; this plugin's section                                                                                                                                                                               |
| `load(path)`                | Fetch JSON relative to the manifest (a site mapping file: `ctx.load('irrigation.json')`)                                                                                                                                   |
| `three`                     | `THREE`, `scene`, `camera`, `renderer`, `model` (fixtures, rooms, groups, parts), `P()` plan → world, `toPlan()` world → plan, `unit`                                                                                      |
| `view`                      | `state` (mode, cutaway, …), `setMode`, `fly(target, from)`, `flyTo(subject)`, `teleport`, `here()` (the walker's room), `aim()` (crosshair or mouse), `seen(p)`, `addVisibilityRule(fn)`, `applyVisibility`, `toggleLayer` |
| `pick`                      | `at(ndc)` → subject; `model(ndc)`; `addScreenPicker` for markers drawn in screen space; `addResolver` to turn a model hit into your subject                                                                                |
| `events`                    | `frame`, `select`, `mode`, `visibility`, `model`, `pointerlock`, `click` (set `handled` to stop the inspect), `ready` (every plugin has started), and your own `'<id>:<name>'`                                             |
| `keys`                      | `add({ code, shift?, alt?, label, group?, when?, run })`; help and tooltips are generated from it                                                                                                                          |
| `store`                     | The entity store (below)                                                                                                                                                                                                   |
| `hud`                       | `addPanel` (a dock panel and its rail button), `addLegend`, `invalidate()`                                                                                                                                                 |
| `inspector`                 | `addSection`, `registerSubject`, `describeObject`, `open`, `close`, `refresh`                                                                                                                                              |
| `status`                    | `addItem` (status strip), `addToggle` (a chip; its key and variants are registered for you), `progress(label)`                                                                                                             |
| `hover`, `search`           | Hover-label providers ("· on 82 %"), global search providers (`/`)                                                                                                                                                         |
| `toast`, `confirm`, `modal` | Transient messages (`aria-live`; errors stay until dismissed), the standard confirm (never `window.confirm`), modals with blocks or your own content                                                                       |
| `url`, `storage`            | Query parameters (`has`, `get`, `num`, `set`); per-site, per-plugin `localStorage`                                                                                                                                         |
| `services`, `plugins`       | `services.provide(name, api)` / `get(name)` between plugins (looked up lazily: order doesn't matter); `plugins.has(id)`                                                                                                    |
| `expose(name, api)`         | Put an API on the console hook, `window.twin.<name>`                                                                                                                                                                       |
| `own(disposer)`             | Tie anything else to the plugin's life                                                                                                                                                                                     |

## Subjects and the inspector

The inspector shows one **subject**: something picked in the model (`{ kind: 'object', node, part?, hit? }`) or an
item a plugin owns (`{ kind: 'item', id: 'pins:elec.panel.a' }`). String references work anywhere a subject does:
`'pins:<id>'`, `'plates:<box>'`, `'devices:<id>'`, and the core's `'fixture:<fixture id>'` and `'room:<room id>'`.

- `inspector.registerSubject('irrigation', { describe(id), fly(id) })` gives your items a title, an icon or glyph, a
  type line, and a way to fly there. Links (`{ type: 'links', items: ['irrigation:zone-3'] }`) then render as chips
  with that title and icon, and clicking one flies there and opens it, with back / forward history.
- `inspector.addSection({ id, title, icon, order, for(subject) })`: every provider is asked about every subject and
  answers with blocks or `null`. Sections are ordered by `order` (the owner's 10; others 50+; the core's Object section
  last) and each one's collapse state is remembered. One subject can have sections from many plugins: a light fixture
  gets Light (lights), Equipment (pins), Home Assistant (the connector) and Object (core).
- Live values: call `inspector.refresh(match?)` when your data changes. The core re-renders at most every 120 ms and
  diffs the DOM, so scroll position and focus survive.
- The `select` event tells you when the subject changes (pins pulse the selected pin; plates tint the selected plate).

## Blocks

Most UI is data. Panels, sections and modals take a list of blocks; the core renders them with its own Lit components
in the theme, and a refresh only changes what changed.

| Block                                               | Use                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `kv`                                                | Key / value rows; values are text or styled spans (`pill`, `tone`, `mono`, `href`)                     |
| `note`, `text`, `label`                             | Prose clamped to a few lines with "Show all"; a line of text; a small heading                          |
| `list`                                              | Rows with a dot, glyph or icon, text, secondary text, value, bar; a `subject` flies there and opens it |
| `group`                                             | A collapsible heading with a count (remembered per site)                                               |
| `chips`                                             | Filter chips (Alt-click or right-click: only this one)                                                 |
| `toggle`, `slider`, `select`, `segmented`, `search` | Themed controls                                                                                        |
| `meter`                                             | A big value with a unit and a sparkline                                                                |
| `status`, `callout`                                 | A status pill (always with a glyph, never colour alone); a highlighted note with an action             |
| `links`, `buttons`                                  | Subject links; buttons (`confirm` opens the standard modal first)                                      |
| `empty`, `error`, `loading`, `textarea`             | Standard states; read-only text to copy                                                                |
| `custom`                                            | `render(el)`: your own DOM, a chart, any framework (the `--jv-*` tokens reach it)                      |

`null`, `false` and `''` entries are skipped, so `cond && { … }` works.

## The store: connectors and features

Data from outside comes through **connector** plugins into a core **store**; **feature** plugins read it and never
know which connector an entity came from.

- A connector registers with `store.addConnector({ id, name, call, refusal?, simulate? })`, gets a handle, and pushes
  states with `handle.replace(entities)` / `update(states)` and its status with `handle.status('live' | 'mock' | …)`.
  Entities use Home Assistant's state-object shape (`entity_id`, `state`, `attributes` with `device_class`,
  `unit_of_measurement`, `friendly_name`), a widely used one; another connector maps into it.
- Features read `store.get(id)`, `store.entities()`, `store.onChange(fn, filter?)` and `store.history(id)` (a numeric
  history for sparklines).
- **Acting** goes through `store.call(entityIds, 'toggle' | 'turn_on' | 'turn_off', data?)`, which the store routes to
  the owning connector. The connector decides: Home Assistant allows only entities named in the site's controls file or
  its fixture map, at one choke point (`send()` in `src/plugins/home-assistant/policy.ts`), whatever the caller.
  `store.refusal(ids, action)` says up front why a call would be refused, so a button can say "Can't switch: …".
- **Bindings** say which entities belong to what: `store.bind({ ref: 'fixture:den.lamp', entities: ['light.den'],
conf, src, meta })`. They come from the site's mapping files (the lights plugin reads the fixture map; pins bind a
  registry item's entities; faults a device's), so any plugin can ask `store.entitiesOf('pins:elec.panel.a')`. The
  Home Assistant section appears on anything that has bindings. A mock connector's bindings (`conf: 'mock'`) give way
  to any real one. Bindings never extend what a connector allows.

## A worked example: irrigation zones

A feature plugin that shows the garden's irrigation zones, using a site mapping file and whichever connector supplies
the valve states.

```jsonc
// site.json
"plugins": { "irrigation": { "zones": "irrigation.json" } }
```

```jsonc
// irrigation.json: the site's mapping (zone -> valve entity and where it waters)
{
  "zones": [
    { "id": "z3", "name": "Front beds", "valve": "switch.rachio_zone_3", "at": [40, 75, 0], "room": "front_court" },
  ],
}
```

```ts
import { definePlugin } from '../../core/plugin/types';

interface Zone {
  id: string;
  name: string;
  valve: string;
  at: [number, number, number];
  room?: string;
}

export default definePlugin<{ zones: string }>({
  id: 'irrigation',
  name: 'Irrigation',
  after: ['home-assistant'],
  async setup(ctx) {
    const { zones } = await ctx.load<{ zones: Zone[] }>(ctx.config.zones); // a missing file: the plugin is just off
    const byId = Object.fromEntries(zones.map((z) => [z.id, z]));
    const running = (z: Zone) => ctx.store.get(z.valve)?.state === 'on';
    for (const z of zones) ctx.store.bind({ ref: `irrigation:${z.id}`, entities: [z.valve] }); // the HA section shows it

    ctx.inspector.registerSubject('irrigation', {
      describe: (id) => byId[id] && { title: byId[id].name, type: 'Irrigation zone', icon: 'pin' },
      fly: (id) => ctx.view.fly(ctx.three.P(...byId[id].at), null),
    });
    const panel = ctx.hud.addPanel({
      id: 'irrigation',
      title: 'Irrigation',
      icon: 'pin',
      order: 60,
      key: { code: 'KeyI', shift: true, label: 'Irrigation panel' },
      badge: () => zones.filter(running).length || null,
      render: (body) =>
        body.blocks(() => [
          {
            type: 'list',
            rows: zones.map((z) => ({
              id: z.id,
              text: z.name,
              secondary: ctx.store.get(z.valve)?.state ?? 'no state',
              dot: running(z) ? 'ok' : 'off',
              subject: `irrigation:${z.id}`,
            })),
          },
        ]),
    });
    ctx.store.onChange(
      () => (panel.refresh(), ctx.inspector.refresh()),
      zones.map((z) => z.valve),
    );

    ctx.inspector.addSection({
      id: 'irrigation',
      title: 'Zone',
      icon: 'pin',
      order: 10,
      for: (s) => {
        const z = s.kind === 'item' && s.id.startsWith('irrigation:') ? byId[s.id.slice(11)] : null;
        if (!z) return null;
        const action = running(z) ? 'turn_off' : 'turn_on';
        const why = ctx.store.refusal(z.valve, action); // e.g. not on the connector's allow-list
        return {
          blocks: [
            { type: 'status', tone: running(z) ? 'ok' : 'off', text: running(z) ? 'Watering' : 'Off' },
            why ? { type: 'text', text: { text: `Can't switch: ${why}`, muted: true } } : null,
          ],
          actions: why
            ? []
            : [
                {
                  label: running(z) ? 'Stop' : 'Run',
                  kind: 'primary',
                  confirm: running(z) ? undefined : `Water ${z.name} now?`,
                  onClick: () =>
                    ctx.store
                      .call(z.valve, 'toggle')
                      .catch((e) => ctx.toast({ text: `${z.name}: ${e.message}`, tone: 'bad' })),
                },
              ],
        };
      },
    });
    ctx.search.add({
      id: 'irrigation',
      label: 'Irrigation zones',
      search: (q) =>
        zones
          .filter((z) => z.name.toLowerCase().includes(q))
          .map((z) => ({ text: z.name, icon: 'pin', subject: `irrigation:${z.id}` })),
    });
  },
});
```

Note what it doesn't do: it names no connector, writes no CSS, touches no `index.html`, and can't switch a valve the
site's Home Assistant allow-list doesn't name (the house's controls file would have to list `switch.rachio_zone_3`).

## How the planned plugins fit

- **Energy** (`design/hud-panels.md` §3): a feature plugin. It loads the site's `energy.yaml` with `ctx.load`, reads
  power and energy entities from the store (`store.history` for sparklines), binds meters to model objects and plates
  with `store.bind` (so the Home Assistant section shows the sensors), adds the Energy panel, a section on any subject
  a meter feeds, a load-tint chip with a legend, a status item and a hover provider. No core change.
- **The voice assistant** (`design/voice-assistant.md`): a feature plugin with a dock panel (a custom block for the
  transcript), a hold-to-talk key, a status item and `ctx.confirm` for confirmations. Its viewer commands map onto
  `view.flyTo(subject)`, `inspector.open(subject)`, the chips (`status` toggles, or their keys) and `search` providers
  to resolve names. Acting on the house goes through its own server-side policy, not the browser's store.
