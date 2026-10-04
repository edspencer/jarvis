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
that is marked `autoStart` (built-in plugins only). Only those plugins' code is downloaded: a site without an energy
section never fetches the energy plugin. `ctx.config` is that section: a built-in plugin's, with its file paths
resolved against the manifest; any other, as written (`ctx.load` resolves a relative path against the manifest either
way). If the plugin has a `validate(config)`, it runs first: any problem it returns keeps the plugin off, with a toast.
Plugins start in parallel; one waits only for those named in `requires` and `after`. Plugins caught in a cycle of
`requires` / `after` don't start (a toast names the cycle); the others do.

**A section for a plugin this build doesn't have**, and without a `module` (a site written for a newer viewer), is
skipped with a warning in the console and from `validate-site`; the rest of the site loads. Inside a built-in plugin's
section, an unknown field is still an error.

**When it fails.** If `setup` throws or rejects, or a required plugin isn't running, the plugin is stopped, everything
it registered so far is disposed, and a toast says so ("Equipment pins is off: registry.json: HTTP 404"). The rest of
the walkthrough carries on. An event handler that throws later is logged once and reported once; the frame loop keeps
running.

**Where plugins come from.** The built-in ones are listed in [`src/plugins/registry.ts`](../src/plugins/registry.ts),
each its own chunk, with the letter keys it claims. Any other plugin is an [external plugin](#external-plugins): the
site loads it from a module of its own, and nothing in JARVIS changes. The energy plugin and its map file have their
own page, [`plugins/energy.md`](plugins/energy.md).

## External plugins

A section with a `module` loads a plugin from the site:

```jsonc
// site.json
"plugins": {
  "measure": { "module": "plugins/measure.js", "decimals": 2 }
}
```

- **The module** is an ES module, resolved against the manifest, whose default export is the plugin
  (`export default definePlugin({ … })`). Its `id` must be the section's key. `ctx.config` is the section without
  `module`. The id is lower-case letters, digits and `-`. If it is a built-in plugin's id (a newer release may add one
  with your plugin's name), the section is skipped with a warning and the rest of the site loads: rename yours.
- **Building one.** `jarvis/plugin`'s run-time exports are `definePlugin`, which returns its argument, and plain
  constants (`MATERIAL_PRIORITY`); everything else is types. So a bundled plugin is one self-contained file that needs nothing from the viewer at run time but `ctx`:
  three.js is `ctx.three.THREE` (import three's types with `import type`), and the HUD's components are custom elements
  (`<jv-blocks>`, …). **Build it with `npm run build-plugin -- path/to/plugin.ts out.js`** in a JARVIS checkout (the
  plugin's source can live anywhere; its own imports are bundled in, and a run-time import of `three` is refused). A
  module that still says `import … from 'jarvis/plugin'` at run time doesn't load: the viewer has no import map for
  it, so bundle it (another bundler works too, the same way) or write plain JavaScript with no imports. [The tutorial, step 11](guide/writing-a-plugin.md#11-load-it-on-the-demo-house)
  walks through it.
- **Keys.** List the letter keys the plugin binds in its `keys` (`keys: ['M']`); the key registry warns about a
  letter that isn't listed. The site's section may declare them too (`"measure": { "module": "…", "keys": ["M"] }`),
  and then the section wins: the site owner can see and check them without running the plugin, and `validate-site`
  reports one that a layer, the core or another plugin already has (without a section `keys`, it learns the plugin's
  own only with `--run-plugin-code`). `keys` isn't part of `ctx.config`. At run time the first binding of a key wins and a second is ignored with a warning, except that
  bindings which both have a `when` share the key (a press runs the first whose `when` holds): that is how several
  plugins bind Esc. A plugin's Esc binding must have a `when` (one without is refused with a warning), so it can't take
  the presses that close the inspector.
- **Checking the section.** A plugin may export `validate(config)`, returning a list of problems. The viewer runs it
  before `setup` (a problem keeps the plugin off, with a toast). `npm run validate-site` checks that the module file is
  there and where it may load from; it runs no plugin code unless you ask: with `--run-plugin-code` it imports the
  module in Node (its top-level code runs, with your rights) to check what it exports, its keys, and its `validate`. A
  module that only runs in a browser is then reported and checked in the viewer only.
- **Lazy.** The module is fetched only for a site that has the section, once the main model is in, like a built-in
  plugin's chunk. A module that doesn't load or doesn't export a plugin is reported with a toast; the rest start.

**Trust.** A plugin runs with the viewer's full rights: it sees the whole page, including Home Assistant's login tokens
in `localStorage`, and can call the store like any plugin. The site owner chooses the code, the same way they choose
the site's data; JARVIS doesn't sandbox it. What is enforced is where code comes from:

- An **origin** is a scheme, host and port (`https://twin.example.org`), never a path. A viewer deployed under a
  sub-path (`https://example.org/jarvis/`) trusts every script on its whole host.
- **Only a manifest on the viewer's own origin loads external plugins.** A manifest opened from elsewhere
  (`?site=https://other.example/site.json`) may show its building, but none of its external plugins load, whatever its
  `pluginOrigins` say, not even a module on the viewer's own origin (any `.js` file there would run its top-level code
  before the viewer could see it isn't a plugin, and an owner-hosted plugin would start with the stranger's config): a
  link can't bring code onto your viewer. Built-in plugins still start.
- From such a manifest, a module on the **viewer's own origin** is allowed: whoever can put files there controls the
  page already.
- A module on **another origin** loads only if the manifest lists that origin in `pluginOrigins`
  (`"pluginOrigins": ["https://plugins.example.org"]`, one origin per entry). A cross-origin module also needs CORS
  headers on its server.
- **Redirects** count where they end. The manifest's origin is the one it was finally fetched from, so a `?site=` that
  goes through a redirect on the viewer's origin to another host is a manifest from that host. A module URL that
  redirects is refused: the viewer fetches it once without following redirects before it imports it.
- Only `http(s)` URLs: no `data:`, `blob:` or `javascript:` modules.
- **The Content-Security-Policy enforces it.** The checks above run in the viewer's own code, and a server could still
  answer the import differently from the check. The container sends
  `Content-Security-Policy: script-src 'self' 'unsafe-eval' <JARVIS_PLUGIN_ORIGINS>; worker-src 'self' blob:; …`
  (`deploy/nginx.conf`, `tools/csp.ts`), so the browser itself runs scripts only from the viewer's origin and the
  origins you list when you start it (`docker run -e JARVIS_PLUGIN_ORIGINS="https://plugins.example.org" …`), wherever
  a redirect points. A plugin origin has to be in both lists: the manifest's `pluginOrigins` and the server's CSP.
  Behind another server, send the same header ([deploying](deploy.md)). The policy allows `'unsafe-eval'`, because
  three.js's Basis (KTX2) texture transcoder compiles with `new Function` in a worker; that doesn't widen where script
  may come from, which stays the trust boundary.

So review a plugin's code as you would anything you deploy on the viewer's origin, and prefer a copy on your own
server to a third party's URL.

## `ctx`: what a plugin gets

| Field                       | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`, `site`, `config`      | This plugin's id; the resolved manifest; this plugin's section                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `load(path)`                | Fetch JSON relative to the manifest (a site mapping file: `ctx.load('irrigation.json')`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `three`                     | `THREE`, `scene`, `camera`, `renderer`, `model` (root, fixtures, rooms, owners, groups, box, `ownerOf`), `P()` plan → world, `toPlan()` world → plan, `unit`, `materials` (`push(meshes, material \| fn, { priority })` → override, `base(mesh)`; `MATERIAL_PRIORITY`; below)                                                                                                                                                                                                                                                                                                                                                  |
| `view`                      | `state` (mode, cutaway, …), `setMode`, `fly(target, centre)` (stand off towards `centre`; `null`: away from the building), `flyTo(subject)`, `teleport`, `here()` (the walker's room), `aim()` (crosshair or mouse), `seen(p)`, `addVisibilityRule(fn)`, `applyVisibility`, `toggleLayer`, `layers()`, `requestShadows()`                                                                                                                                                                                                                                                                                                      |
| `pick`                      | `at(ndc)` → subject; `model(ndc)`; `addScreenPicker` for markers drawn in screen space; `addResolver` to turn a model hit into your subject                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `events`                    | `frame`, `select`, `mode`, `visibility`, `model`, `pointerlock`, `click` (set `handled` to stop the inspect), `ready` (every plugin has started), and your own `'<id>:<name>'`                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `keys`                      | `add({ code, shift?, alt?, label, group?, when?, run, release? })`; help and tooltips are generated from it; `release` makes it a hold key (hold to talk): `run` once per press, `release` when it goes up. The movement keys (W A S D Q E C, Space, the arrows, Shift) are the core's. **Esc**, one thing per press: the topmost modal, else a text field's own, else it releases the mouse, else closes a menu or the search; then a plugin's Esc binding, the first whose `when` holds (an active tool is cancelled before the inspector closes); then the inspector. Plugins share Esc through `when`, so bind it with one |
| `store`                     | The entity store (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `hud`                       | `addPanel` (a dock panel and its rail button), `addLegend`, `invalidate()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `inspector`                 | `addSection`, `registerSubject`, `describeObject`, `open`, `close`, `current`, `refresh`, `describe`, `resolve`, `refOf`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `status`                    | `addItem` (status strip), `addToggle` (a chip; its key and variants are registered for you), `progress(label)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `hover`, `search`           | Hover-label providers ("· on 82 %"), global search providers (`/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `toast`, `confirm`, `modal` | Transient messages (`aria-live`; errors stay until dismissed), the standard confirm (never `window.confirm`), modals with blocks or your own content                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `url`, `storage`            | Query parameters (`has`, `get`, `num`, `set`); per-site, per-plugin `localStorage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `services`, `plugins`       | `services.provide(name, api)` / `get(name)` between plugins (looked up lazily: order doesn't matter); `plugins.has(id)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `log`                       | `info`, `warn`, `error` to the console, prefixed with the plugin's id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expose(name, api)`         | Put an API on the console hook, `window.twin.<name>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `own(disposer)`             | Tie anything else to the plugin's life                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

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
  copies; `fade: -5`, the blueprint fade; `energy: 10`, energy mode), so `{ priority: MATERIAL_PRIORITY.fade + 1 }`
  draws over the fade and under energy mode, and so does an override at the default 0 (energy mode is above it, not
  tied with it). The material can be a function of the one beneath it,
  `(below, mesh) => material` (the blueprint fade makes a faded copy of whatever is there; cache what it makes, it runs
  again whenever the stack changes). `o.set(m)` changes a layer in place; `o.refresh()` re-runs each of its meshes'
  whole stack, for when you edited your material and a function layer above copies from it. Anything pushed that isn't
  a mesh with one material is skipped, with a warning. `materials.base(mesh)` is the mesh's own material, whatever
  covers it: a plugin that prepares materials from a mesh's (the lights clone a fixture's) starts from it, and picking
  and the inspector report it. It is typed as the mesh's material (`Material | Material[]` for a plain `THREE.Mesh`;
  a mesh with an array is never covered, so narrow with `Array.isArray`). Read it rather than `mesh.material`, which
  is whatever is drawn now; the stack's `mesh.userData.baseMaterial` is internal, not part of the API.
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
