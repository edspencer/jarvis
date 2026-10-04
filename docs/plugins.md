# Writing a plugin

Everything JARVIS shows over the 3D view comes from plugins through one API: the core's own Navigate panel and layer
chips use it too (`src/core/builtin.ts`). A plugin imports everything from one module, `jarvis/plugin`
([`src/plugin-api.ts`](../src/plugin-api.ts)); what it exports is the public contract, and this page explains it.
Nothing else in `src/` is: it may change without notice. The HUD design they implement is
[`design/hud-panels.md`](design/hud-panels.md). New to it? [The tutorial](guide/writing-a-plugin.md) builds one step by
step.

## The shape of a plugin

```ts
import { definePlugin } from 'jarvis/plugin';

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
that is marked `autoStart`. `ctx.config` is that section: a built-in plugin's, with its file paths resolved against the
manifest; any other, as written (`ctx.load` resolves a relative path against the manifest either way). Plugins start in
parallel; one waits only for those named in `requires` and `after`. Plugins caught in a cycle of `requires` / `after`
don't start (a toast names the cycle); the others do.

**A section for a plugin this build doesn't have** (a site written for a newer viewer) is skipped with a warning in
the console and from `validate-site`; the rest of the site loads. Inside a known plugin's section, an unknown field is
still an error.

**When it fails.** If `setup` throws or rejects, or a required plugin isn't running, the plugin is stopped, everything
it registered so far is disposed, and a toast says so ("Equipment pins is off: registry.json: HTTP 404"). The rest of
the walkthrough carries on. An event handler that throws later is logged once and reported once; the frame loop keeps
running.

**Built-in plugins** are listed in [`src/plugins/registry.ts`](../src/plugins/registry.ts), each loaded as its own
chunk, with the letter keys it claims (the site validator keeps a site layer's key off them; the key registry warns if a
plugin uses a letter it didn't declare). That list is the only way a plugin is loaded: one of your own is added to it,
and its section to the manifest schema (`schema/site.schema.json`), which names every section it checks ([the tutorial,
step 11](guide/writing-a-plugin.md#11-register-it-and-try-it-on-the-demo-house)). The energy plugin and its map file
have their own page, [`plugins/energy.md`](plugins/energy.md).

## `ctx`: what a plugin gets

| Field                       | What                                                                                                                                                                                                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `site`, `config`      | This plugin's id; the resolved manifest; this plugin's section                                                                                                                                                                                                                                                                    |
| `load(path)`                | Fetch JSON relative to the manifest (a site mapping file: `ctx.load('irrigation.json')`)                                                                                                                                                                                                                                          |
| `three`                     | `THREE`, `scene`, `camera`, `renderer`, `model` (root, fixtures, rooms, owners, groups, box, `ownerOf`), `P()` plan → world, `toPlan()` world → plan, `unit`, `materials` (`push(meshes, material \| fn, { priority })` → override, `base(mesh)`; `MATERIAL_PRIORITY`; below)                                                     |
| `view`                      | `state` (mode, cutaway, …), `setMode`, `fly(target, centre)` (stand off towards `centre`; `null`: away from the building), `flyTo(subject)`, `teleport`, `here()` (the walker's room), `aim()` (crosshair or mouse), `seen(p)`, `addVisibilityRule(fn)`, `applyVisibility`, `toggleLayer`, `layers()`, `requestShadows()`         |
| `pick`                      | `at(ndc)` → subject; `model(ndc)`; `addScreenPicker` for markers drawn in screen space; `addResolver` to turn a model hit into your subject                                                                                                                                                                                       |
| `events`                    | `frame`, `select`, `mode`, `visibility`, `model`, `pointerlock`, `click` (set `handled` to stop the inspect), `ready` (every plugin has started), and your own `'<id>:<name>'`                                                                                                                                                    |
| `keys`                      | `add({ code, shift?, alt?, label, group?, when?, run, release? })`; help and tooltips are generated from it; `release` makes it a hold key (hold to talk): `run` once per press, `release` when it goes up. The movement keys (W A S D Q E C, Space, the arrows, Shift) are the core's, and so is Esc (it never reaches a plugin) |
| `store`                     | The entity store (below)                                                                                                                                                                                                                                                                                                          |
| `hud`                       | `addPanel` (a dock panel and its rail button), `addLegend`, `invalidate()`                                                                                                                                                                                                                                                        |
| `inspector`                 | `addSection`, `registerSubject`, `describeObject`, `open`, `close`, `current`, `refresh`, `describe`, `resolve`, `refOf`                                                                                                                                                                                                          |
| `status`                    | `addItem` (status strip), `addToggle` (a chip; its key and variants are registered for you), `progress(label)`                                                                                                                                                                                                                    |
| `hover`, `search`           | Hover-label providers ("· on 82 %"), global search providers (`/`)                                                                                                                                                                                                                                                                |
| `toast`, `confirm`, `modal` | Transient messages (`aria-live`; errors stay until dismissed), the standard confirm (never `window.confirm`), modals with blocks or your own content                                                                                                                                                                              |
| `url`, `storage`            | Query parameters (`has`, `get`, `num`, `set`); per-site, per-plugin `localStorage`                                                                                                                                                                                                                                                |
| `services`, `plugins`       | `services.provide(name, api)` / `get(name)` between plugins (looked up lazily: order doesn't matter); `plugins.has(id)`                                                                                                                                                                                                           |
| `log`                       | `info`, `warn`, `error` to the console, prefixed with the plugin's id                                                                                                                                                                                                                                                             |
| `expose(name, api)`         | Put an API on the console hook, `window.twin.<name>`                                                                                                                                                                                                                                                                              |
| `own(disposer)`             | Tie anything else to the plugin's life                                                                                                                                                                                                                                                                                            |

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

**Custom UI with the HUD's components.** In a `custom` block, a panel's `render(el)` or a modal's `render`, a plugin can
use the core's components by tag name, without importing anything (custom elements are a browser contract):
`<jv-blocks>` (`el.blocks = [...]`: any of the blocks above), `<jv-meter value="1210" unit="W">` (`el.spark = [...]`)
and `<jv-list>` (`el.rows = [...]`). They take the theme, and their links open subjects in the inspector.

## The store: connectors and features

Data from outside comes through **connector** plugins into a core **store**; **feature** plugins read it and never
know which connector an entity came from.

- A connector registers with `store.addConnector({ id, name, call, refusal?, simulate? })`, gets a handle, and pushes
  states with `handle.replace(entities)` / `update(states)` and its status with `handle.status('live' | 'mock' | …)`.
  Entities use Home Assistant's state-object shape (`entity_id`, `state`, `attributes` with `device_class`,
  `unit_of_measurement`, `friendly_name`), a widely used one; another connector maps into it.
- Features read `store.get(id)`, `store.entities()`, `store.onChange(fn, filter?)`, `store.recent(id)` (the changes
  this page has seen, for a live sparkline) and `await store.history(id, from, to)`: past states from the owning
  connector's recorder if it has one (Home Assistant's history, read-only; a connector adds `history()` to its spec),
  else what the page has seen. Energy's 24-hour sparklines, and today's kWh where no sensor reports it, come from there.
- **Acting** goes through `store.call(entityIds, 'toggle' | 'turn_on' | 'turn_off', data?)`, which the store routes to
  the owning connector. The connector decides: Home Assistant allows only entities named in the site's controls file or
  its fixture map, at one choke point (`send()` in `src/plugins/home-assistant/policy.ts`), whatever the caller.
  `store.refusal(ids, action, data?)` says up front why a call would be refused, so a button can say "Can't switch:
  …"; pass the same `data` as the call, since a connector may refuse on it (Home Assistant checks the data's keys
  against what the service allows). The store hands it to each owning connector's `refusal(ids, action, data?)`, the
  optional spec method that mirrors `call`'s checks.
- **Bindings** say which entities belong to what: `store.bind({ ref: 'fixture:den.lamp', entities: ['light.den'],
conf, src, meta })`. They come from the site's mapping files (the lights plugin reads the fixture map; pins bind a
  registry item's entities; faults a device's), so any plugin can ask `store.entitiesOf('pins:elec.panel.a')`. The
  Home Assistant section appears on anything that has bindings. A mock connector's bindings (`conf: 'mock'`) give way
  to any real one. Bindings never extend what a connector allows.
- **Materials are shared.** A plugin never assigns `mesh.material` on the model: it pushes an override,
  `const o = ctx.three.materials.push(meshes, material, { priority })`, and takes it off with `o.dispose()` (or leaves
  that to the plugin's stop). Each mesh shows the top of its stack of overrides over its own material: the higher
  `priority` on top (default 0), the later push on top of an equal one; so any order of on and off puts back exactly
  what is left. The built-in plugins' places are exported as `MATERIAL_PRIORITY` (`glow: -10`, the lights' glowing
  copies; `fade: -5`, the blueprint fade; `energy: 0`, energy mode), so `{ priority: MATERIAL_PRIORITY.fade + 1 }`
  draws over the fade and under energy mode. The material can be a function of the one beneath it,
  `(below, mesh) => material` (the blueprint fade makes a faded copy of whatever is there; cache what it makes, it runs
  again whenever the stack changes). `o.set(m)` changes a layer in place; `o.refresh()` re-runs each of its meshes'
  whole stack, for when you edited your material and a function layer above copies from it. Anything pushed that isn't
  a mesh with one material is skipped, with a warning. `materials.base(mesh)` is the mesh's own material, whatever
  covers it (also in `mesh.userData.baseMaterial` while covered): a plugin that prepares materials from a mesh's (the
  lights clone a fixture's) starts from it, and picking reports it.
- The allow-list protects against bugs and misclicks, not hostile code: Home Assistant's login tokens are in
  `localStorage`, readable by any code on the page, plugins included. The README says how to limit the damage (a
  dedicated, non-admin Home Assistant user for the viewer).

## A worked example: irrigation zones

A feature plugin that shows the garden's irrigation zones, using a site mapping file and whichever connector supplies
the valve states. The code is [`examples/irrigation.ts`](examples/irrigation.ts), which the unit tests run against the
real store and Home Assistant's allow-list (`tests/unit/doc-example.test.ts`), so this page can't drift from it.

```jsonc
// site.json
"plugins": { "irrigation": { "zones": "irrigation.json" } }
```

```jsonc
// irrigation.json: the site's mapping (zone -> valve entity and where it waters)
{ "zones": [{ "id": "z1", "name": "Front beds", "valve": "switch.garden_zone_1", "at": [40, 75, 0] }] }
```

```ts
import { definePlugin } from 'jarvis/plugin';

interface Zone {
  id: string;
  name: string;
  valve: string;
  at: [number, number, number];
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
      describe: (id) => (byId[id] ? { title: byId[id].name, type: 'Irrigation zone', icon: 'pin' } : null),
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
        // ask for exactly what will be called: the connector's allow-list decides per action
        const action = running(z) ? 'turn_off' : 'turn_on';
        const why = ctx.store.refusal(z.valve, action);
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
                      .call(z.valve, action)
                      .catch((e: Error) => ctx.toast({ text: `${z.name}: ${e.message}`, tone: 'bad' })),
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
site's allow-list doesn't name. With Home Assistant, the site's controls file would list the valve as a `toggle`
control, which allows `turn_on` and `turn_off`: so the example asks `store.refusal` about the action it is about to
call, and calls exactly that.

## How the planned plugins fit

- **Energy** (`design/hud-panels.md` §3) is built: a feature plugin with no core change, described with its site
  mapping file in [`plugins/energy.md`](plugins/energy.md).
- **The voice assistant** (`design/voice-assistant.md`): a feature plugin with a dock panel (a custom block for the
  transcript), a hold-to-talk key (`keys.add({ …, run, release })`), a status item and `ctx.confirm` for
  confirmations. Its viewer commands map onto `view.flyTo(subject)`, `inspector.open(subject)`, the chips (`status`
  toggles, or their keys) and `search` providers to resolve names. Acting on the building goes through its own
  server-side policy, not the browser's store.
