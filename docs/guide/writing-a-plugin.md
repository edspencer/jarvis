# Writing a plugin

A step-by-step tutorial: a small plugin from nothing to running on the demo house. It builds on
[the plugin reference](../plugins.md) (every field of `ctx`, the blocks, the store); this page is the walk through it.

The plugin is **Measure**: the distance between two points on the model. The full file is
[`docs/examples/measure.ts`](../examples/measure.ts); the excerpts here are its own lines, and
[`tests/unit/measure-example.test.ts`](../../tests/unit/measure-example.test.ts) both checks that and runs the plugin,
so this page can't drift from working code.

## 1. What you'll build

- **M** turns measuring on and off (**Esc** stops it too). While it is on, the status strip says what to click, and a click on the model takes
  a point instead of inspecting.
- Every two points make a measurement: a line in the scene, a row in a **Measure** panel, and an inspector page with the
  distance, its horizontal and vertical parts, the two ends in plan coordinates and a Delete button.
- **Shift-M** clears them all. Metres or feet is a choice in the panel, remembered per site.

It needs no Home Assistant and no data files, and it touches most of the API: config, storage, keys, events, picking,
the scene, a status item, a panel, a subject kind, an inspector section and the console hook.

**The plugin model in one paragraph.** A plugin is an object, `definePlugin({ id, name, setup(ctx) })`. Once the main
model is in, the core calls `setup` for every plugin the site enables (a `plugins.<id>` section in `site.json`, or
`autoStart`). The plugin sees the viewer only through `ctx`, and everything it registers there (keys, handlers, panels,
sections) is removed again when it stops. If `setup` throws, the plugin is off, a toast says why, and the walkthrough
carries on. It imports one module, `jarvis/plugin` ([`src/plugin-api.ts`](../../src/plugin-api.ts)): that is the
public contract; nothing else in `src/` is.

## 2. Scaffold

```ts
// docs/examples/measure.ts
import { definePlugin, type Subject } from 'jarvis/plugin';
import type { Line, Vector3 } from 'three';

interface MeasureConfig {
  /** the lines' colour (default '#ffb000') */
  colour?: string;
  /** decimal places shown (default 2) */
  decimals?: number;
}
// …
export default definePlugin<MeasureConfig>({
  id: 'measure',
  name: 'Measure',
  keys: ['M'], // the letters it binds: validate-site keeps a site layer's key off them
  // …
  setup(ctx) {
```

- `id` is the manifest key (`plugins.measure`), the prefix of the plugin's own events (`measure:added`) and of its
  storage. `name` is what help, toasts and the inspector show.
- `definePlugin<MeasureConfig>` types `ctx.config`. It does nothing at run time (it returns its argument): it is there
  for the types. So a plugin needs nothing from JARVIS at run time but `ctx`, which is what lets it be built on its own
  and loaded by a site (step 11).
- `keys` lists the letter keys it binds (step 4).
- No `requires` or `after`: Measure uses no other plugin. A plugin that reads Home Assistant's entities says
  `after: ['home-assistant']` (start after it if it is there); one that can't work without another says `requires`.
- `setup` may be `async` (await a data file with `ctx.load`), and may return `{ dispose() }`. Measure needs neither.
- From three.js, import **types only**. At run time use the viewer's own copy, `ctx.three.THREE` (step 6).

## 3. Configuration from `site.json`

The site turns the plugin on with a section, and that section is `ctx.config`:

```jsonc
// site.json
"plugins": { "measure": { "colour": "#ff6a00", "decimals": 1 } }
```

```ts
// docs/examples/measure.ts
const colour = ctx.config.colour ?? '#ffb000';
const decimals = ctx.config.decimals ?? 2;
let units = ctx.storage.get<Units>('units', ctx.site.units); // the person's choice, else the site's plan units
```

- Give every option a default: `{}` is a valid section (`"measure": {}` turns it on with the defaults).
- `ctx.site` is the resolved manifest: `units` (`'ft'` or `'m'`, the plan's), `unit` (metres per plan unit), `storeys`,
  `viewpoints`, `geo`, `layers`. Measure starts in the site's units.
- `ctx.storage` is `localStorage`, per site and per plugin (`get(key, default)`, `set`, `remove`), JSON-encoded, and
  quiet in private mode. It is for the person's choices, not the site's: those belong in `site.json`.
- A data file (a mapping, a list of zones) is a path in the section, read with `ctx.load(ctx.config.file)`, which
  resolves it against the manifest. A failed load in `setup` is a failed start: the plugin is off with a toast.

The section is the site's, so check it. `validate(config)` runs before `setup`, and
`npm run validate-site -- <site> --run-plugin-code` runs it too; it returns the problems, and any problem keeps the plugin off with a toast that lists them:

```ts
// docs/examples/measure.ts
validate(config) {
  const c = config as Record<string, unknown>;
  return [
    ...Object.keys(c)
      .filter((k) => k !== 'colour' && k !== 'decimals')
      .map((k) => `${k}: unknown field (expected colour, decimals)`),
    c.colour !== undefined && typeof c.colour !== 'string' && "colour: expected a CSS colour ('#ffb000')",
    c.decimals !== undefined &&
      !(Number.isInteger(c.decimals) && (c.decimals as number) >= 0) &&
      'decimals: expected a whole number',
  ].filter((x): x is string => !!x);
},
```

## 4. Claim keys

```ts
// docs/examples/measure.ts
ctx.keys.add({
  code: 'KeyM',
  label: 'Measure: click two points on the model (M again to stop)',
  run: () => setMeasuring(!measuring),
});
ctx.keys.add({
  code: 'KeyM',
  shift: true,
  label: 'Clear the measurements',
  when: () => list.length > 0 || !!first,
  run: clear,
});
ctx.keys.add({
  code: 'Escape',
  label: 'Stop measuring',
  when: () => measuring, // only while there is something to cancel: then Esc is ours before the inspector's
  run: () => setMeasuring(false),
});
```

- `code` is `KeyboardEvent.code` (`'KeyM'`, `'Digit1'`, `'Slash'`), so the key is the same on every keyboard layout.
  `label` goes into help (H) and tooltips; you write no help text of your own.
- `when` gates a key: Shift-M does nothing unless there is something to clear. A key repeat never runs a binding
  again; `release` makes a hold key.
- Taken keys are reported, not shared: the movement keys (W A S D Q E C, Space, the arrows, Shift) and the core's view
  keys (X U G H N, Tab, `/`, `?`, and 1–9 for the viewpoints) are the core's, and a second binding of a taken key is
  ignored with a console warning.
- **Esc** is shared, in a fixed order: one press closes the topmost modal, else is a text field's, else releases the
  mouse, else closes a menu or the search; then it goes to a plugin's Esc binding, the first whose `when` holds (an
  active tool is cancelled before the inspector closes, as in a CAD program); only then does it close the inspector.
  So bind Esc with a `when` that holds only while there is something to cancel: plugins share the key that way.
  Measure stops measuring with it; the next press closes the inspector the last measurement opened.
- Every letter key is listed in the plugin's `keys` (step 2), so the site validator keeps a site layer's key off it;
  the key registry warns about a letter that isn't listed.

## 5. Take clicks: events and picking

```ts
// docs/examples/measure.ts
ctx.events.on('click', (e) => {
  if (!measuring) return;
  e.handled = true; // the click takes a point: it doesn't inspect
  const hit = ctx.pick.model(ctx.view.aim()); // the model under the mouse (or the crosshair)
  if (!hit) {
    ctx.toast('Nothing there to measure to');
    return;
  }
  const p = hit.hit.point.clone();
  // …
  const m: Measurement = { id: String(++n), a: first, b: p };
  list.push(m);
  draw(m);
  first = null;
  pending.visible = false;
  ctx.events.emit('measure:added', { id: m.id, metres: length(m) });
  ctx.inspector.open(`measure:${m.id}`);
  changed();
});
```

- `click` comes before the core inspects what was clicked; `handled = true` stops that. (The lights plugin uses the
  same event for Shift-click to switch a lamp.)
- The event's `subject` is what would have been inspected, which may be a pin or a fault marker drawn in screen space.
  Measure wants the model surface, so it asks `ctx.pick.model(ndc)` itself, at `ctx.view.aim()`: the mouse in the
  overview, the crosshair while walking. `hit.hit` is three.js's `Intersection`; `point` is in world space.
- While walking, the first click on the view captures the mouse and doesn't reach plugins; the clicks after it do.
- `ctx.events.emit('measure:added', …)` is the plugin's own event, `'<id>:<name>'`. Another plugin listens with
  `ctx.events.on('measure:added', (e) => …)` and neither imports the other (for a callable API between plugins, use
  `ctx.services`).

Measure also follows the inspector, through `select`, to tint the selected line:

```ts
// docs/examples/measure.ts
ctx.events.on('select', ({ subject }) => {
  for (const [id, line] of lines) line.material = id === idOf(subject) ? selectedMat : lineMat;
});
```

The other events are `frame` (every frame, with `dt`: animate here), `mode` (walk / overview), `visibility`, `model`
(an extra model is in), `pointerlock` and `ready` (every plugin has started). All handlers go when the plugin stops; one
that throws is logged and reported once, and the frame loop keeps running.

## 6. Draw in the scene

```ts
// docs/examples/measure.ts
const { THREE, scene, toPlan } = ctx.three;
const group = new THREE.Group();
group.name = 'measure';
scene.add(group);
const lineMat = new THREE.LineBasicMaterial({ color: colour, depthTest: false });
const selectedMat = new THREE.LineBasicMaterial({ color: '#ffffff', depthTest: false });
const dotMat = new THREE.MeshBasicMaterial({ color: colour, depthTest: false });
const dot = new THREE.SphereGeometry(0.04); // 4 cm
// …
const draw = (m: Measurement) => {
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([m.a, m.b]), lineMat);
  line.renderOrder = 10;
  line.add(marker(m.a), marker(m.b));
  group.add(line);
  lines.set(m.id, line);
};
ctx.own(() => {
  scene.remove(group);
  for (const l of lines.values()) l.geometry.dispose();
  for (const x of [lineMat, selectedMat, dotMat, dot]) x.dispose();
});
```

- The scene is three.js's frame: **metres, Y up**. The site's plan frame (X east, Y north, Z up, in the site's units)
  is `ctx.three.P(x, y, z)` to world and `ctx.three.toPlan(v)` back. Measure measures in world metres and shows the ends
  in plan coordinates, which is what the blueprints and `site.json` use.
- One group, named, makes the plugin's objects easy to find (`twin.scene.getObjectByName('measure')` in the console)
  and to remove.
- `ctx.three.model` is the loaded model (`root`, `fixtures`, `rooms`, `box`, `ownerOf`): read it, don't change it.
- **Clean up.** The host removes what it knows about (keys, handlers, panels, sections), but not your scene objects
  or GPU resources. `ctx.own(fn)` ties them to the plugin's life; returning `{ dispose() }` from `setup` does the same.

## 7. Contribute UI: a status item and a panel

The status strip says what to click while measuring, and nothing otherwise (`render` returns `null`):

```ts
// docs/examples/measure.ts
ctx.status.addItem({
  id: 'measure',
  order: 140,
  render: () =>
    measuring
      ? { icon: RULER, strong: 'Measure', text: first ? 'click the second point' : 'click the first point' }
      : null,
  onClick: () => setMeasuring(false),
});
```

The panel is a rail button and a dock panel, built from **blocks**: data that the core renders with its own components
in the theme. There is no CSS and no DOM to write.

<!-- prettier-ignore -->
```ts
// docs/examples/measure.ts
const panel = ctx.hud.addPanel({
  id: 'measure',
  title: 'Measure',
  icon: RULER,
  order: 60,
  badge: () => list.length || null,
  render: (body) =>
    body.blocks(() => [
      { type: 'toggle', label: 'Measuring', key: 'M', value: measuring, onChange: setMeasuring },
      {
        type: 'segmented',
        label: 'Units',
        value: units,
        options: [
          { value: 'm', label: 'Metres' },
          { value: 'ft', label: 'Feet' },
        ],
        onChange: (v) => {
          units = v as Units;
          ctx.storage.set('units', units);
          changed();
        },
      },
      {
        type: 'list',
        rows: list.map((m) => ({
          id: m.id,
          text: `Measurement ${m.id}`,
          value: fmt(length(m)),
          subject: `measure:${m.id}`,
        })),
        empty: 'Press M, then click two points on the model.',
      },
    ]),
  actions: () =>
    list.length
      ? [{ label: 'Clear all', key: 'Shift-M', confirm: 'Clear every measurement?', onClick: clear }]
      : [],
});
```

- `icon` is a core icon name (`'pin'`, `'sun'`, …: `src/ui/icons.ts`) or your own `'<svg …>'` string, as here
  (`RULER`, drawn in `currentColor`).
- `order` places it on the rail (the core's panels 10–30, plugins 40+). `badge`, `meta` and `actions` are functions:
  they are read again on every refresh.
- The `list` rows' `subject` makes each row a link: click it and the camera flies there and the inspector opens it
  (step 8). `id` keeps rows stable across refreshes.
- `confirm` on a button opens the standard confirm first (never `window.confirm`).
- The blocks function runs again on `panel.refresh()`. The panel doesn't watch your variables, so say when they
  change. Measure has one helper for it:

```ts
// docs/examples/measure.ts
const changed = () => {
  panel.refresh();
  ctx.inspector.refresh();
  ctx.hud.invalidate(); // the status item and the badge
};
```

Refreshes are throttled and the DOM is diffed, so calling them often is cheap and focus and scroll survive. For a chip
in the status strip (a layer-like on/off with its own key) use `ctx.status.addToggle`; for a key to the colours on
screen, `ctx.hud.addLegend`. The full list of blocks is in [Blocks](../plugins.md#blocks); `custom` takes your own DOM.

## 8. Subjects and the inspector

A measurement is an item the plugin owns, with a reference string `measure:<id>`. Registering the kind gives every such
reference a title, an icon and a way to fly there, wherever it appears (list rows, links, search hits, history):

```ts
// docs/examples/measure.ts
ctx.inspector.registerSubject('measure', {
  describe: (id) => {
    const m = byId(id);
    return m ? { title: `Measurement ${m.id}`, type: fmt(length(m)), icon: RULER } : null;
  },
  fly: (id) => {
    const m = byId(id);
    if (m) ctx.view.fly(m.a.clone().lerp(m.b, 0.5), null);
  },
});
```

What the inspector shows for a subject comes from **sections**. Every section provider is asked about every subject and
answers with blocks, or `null` for "nothing to say":

```ts
// docs/examples/measure.ts
ctx.inspector.addSection({
  id: 'measure',
  title: 'Measurement',
  icon: RULER,
  order: 10, // the subject's owner comes first
  for: (s) => {
    const m = byId(idOf(s));
    if (!m) return null;
    const d = m.b.clone().sub(m.a);
    return {
      blocks: [
        { type: 'meter', value: conv(d.length()).toFixed(decimals), unit: units },
        {
          type: 'kv',
          rows: [
            ['Horizontal', fmt(Math.hypot(d.x, d.z))],
            ['Vertical', fmt(Math.abs(d.y))],
            ['From', { text: plan(m.a), mono: true }],
            ['To', { text: plan(m.b), mono: true }],
          ],
        },
      ],
      actions: [{ label: 'Delete', kind: 'danger', onClick: () => remove(m.id) }],
    };
  },
});
```

- `idOf` turns a subject into a measurement id: `s.kind === 'item' && s.id.startsWith('measure:')`. A section can as
  well answer for things in the model (`s.kind === 'object'`, with `s.node`): that is how several plugins add their
  own section to one light fixture.
- `order` 10 is for the subject's owner; a plugin adding to others' subjects uses 50 or more.
- The core adds the header (from `describe`) and a Fly to button (from `fly`). `ctx.inspector.open(ref)` shows a
  subject, `current()` is the one showing, `close()` closes it: Measure's `remove` closes the inspector when its
  measurement goes.

## 9. The console

```ts
// docs/examples/measure.ts
ctx.expose('measure', { list: () => list.map((m) => ({ id: m.id, metres: length(m) })), clear });
```

`window.twin.measure.list()` in the browser's console, for debugging and for end-to-end tests. It goes when the plugin
stops.

## 10. Test it

A plugin is a function of `ctx`, so a unit test can run `setup` against a small fake of the parts it uses, with the
real pieces where they matter. The test for Measure uses the core's event bus and storage, and a real three.js scene:

```ts
// tests/unit/measure-example.test.ts
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
```

Then it drives the plugin the way the core would: it runs the M key's `run`, emits `click` events (with the pick
results queued in `hits`), and reads what the plugin registered: the panel's blocks, the section's answer, the
lines in the scene.

```ts
// tests/unit/measure-example.test.ts
press('KeyM');
expect(items[0].render()?.text).toBe('click the first point');
expect(click(new THREE.Vector3(1, 0, 1))).toBe(true);
expect(items[0].render()?.text).toBe('click the second point');
expect(click(new THREE.Vector3(4, 4, 1))).toBe(true); // 3 across, 4 up: 5 m
expect(rows()).toMatchObject([{ text: 'Measurement 1', value: '5.00 m', subject: 'measure:1' }]);
expect(lines()).toHaveLength(1);
expect(inspector.open).toHaveBeenCalledWith('measure:1');
expect(added).toEqual([{ id: '1', metres: 5 }]);
```

The last test stops the plugin, running what it gave `ctx.own` and the bus, and checks the scene is empty and no
handler is left. The test lives in `tests/unit/` and runs with `npx vitest run`; `npm run typecheck` covers
`docs/examples/` and `tests/`. For a plugin that reads the store, see
[`tests/unit/doc-example.test.ts`](../../tests/unit/doc-example.test.ts): it runs the irrigation example against the
real store and Home Assistant's allow-list.

## 11. Load it on the demo house

A site loads a plugin that isn't built into JARVIS from a module of its own: a section with a `module`, an ES module
whose default export is the plugin. Nothing in JARVIS changes, and no fork is needed.

**Build the module.** What a plugin imports from `jarvis/plugin` at run time is `definePlugin`, which returns its
argument (and perhaps a constant such as `MATERIAL_PRIORITY`), so a bundler inlines it and the result is one
self-contained file. In a JARVIS checkout:

```sh
cp -r examples/demo-site sites/measure-demo   # sites/ is git-ignored; examples/demo-site is generated, don't edit it
npm run build-plugin -- docs/examples/measure.ts sites/measure-demo/plugins/measure.js
```

`build-plugin` (`tools/build-plugin.ts`) bundles everything the plugin imports into the one file, except three.js: a
run-time `import … from 'three'` is an error, since the viewer's own copy is `ctx.three.THREE`.

**Turn it on.** Add the section to `plugins` in `sites/measure-demo/site.json`. `module` is resolved against the
manifest; the other fields are the plugin's own (`ctx.config`, without `module`):

```jsonc
"plugins": {
  // …
  "measure": { "module": "plugins/measure.js", "decimals": 2 }
}
```

```sh
npm run validate-site -- sites/measure-demo --run-plugin-code
JARVIS_SITE=sites/measure-demo npm run dev
```

`validate-site` checks that the module is there. `--run-plugin-code` also imports it (in Node: its code runs, so use it
for code you trust) to check that it exports a plugin with this id, that its `keys` are free, and runs its `validate`
on the section; without the flag none of the plugin's code runs. Open `http://localhost:5173/?ha=mock` (the demo's
Home Assistant is a placeholder: `ha=mock` makes up its states). Press Tab for the overview, M to measure, and click
two points on the house: the line appears, the inspector opens on it, and the rail has a Measure button with a count.
H lists its keys under Measure. If the plugin fails to load or start, a toast says why and the console has the stack.
`tests/e2e/external-plugin.spec.ts` does all of this in a browser.

**Outside a JARVIS checkout.** Any ES module bundler works; the plugin's project needs JARVIS only for the types
(`npm install --save-dev github:edspencer/jarvis`, whose `jarvis/plugin` export is the API's TypeScript source). With
esbuild:

```sh
npx esbuild src/measure.ts --bundle --format=esm --target=es2022 --external:three --outfile=dist/measure.js
```

A plugin can also skip the build: plain JavaScript with no imports at all, typed by a JSDoc comment if you like.

```js
/** @type {import('jarvis/plugin').PluginDef} */
export default {
  id: 'hello',
  name: 'Hello',
  setup: (ctx) => void ctx.toast(`Hello from ${ctx.site.name}`),
};
```

**Where the module may come from.** The site owner chooses the code their site runs, and the module runs with the
viewer's full rights (it can read Home Assistant's tokens: see the README). So the viewer imports a module only from
its own origin, unless the manifest lists another origin in `pluginOrigins` (and then only if the manifest itself is on
the viewer's origin: a manifest opened with `?site=https://elsewhere/…` can bring data, never code), and never through
a redirect. The container's Content-Security-Policy enforces the same in the browser; another origin has to be in its
`JARVIS_PLUGIN_ORIGINS` too. [The reference](../plugins.md#external-plugins) has the details.

**Building one into JARVIS** instead (a plugin for everyone, in a pull request) takes three edits: the code under
`src/plugins/<id>/`, a line in [`src/plugins/registry.ts`](../../src/plugins/registry.ts) with its keys (each built-in
plugin is its own chunk, downloaded only by the sites that enable it), and its section in
[`schema/site.schema.json`](../../schema/site.schema.json) and `PluginConfigs` (`src/site/manifest.ts`).

## 12. Where next

- [The plugin reference](../plugins.md): [`ctx`](../plugins.md#ctx-what-a-plugin-gets) field by field,
  [subjects and the inspector](../plugins.md#subjects-and-the-inspector), [blocks](../plugins.md#blocks).
- [The store](../plugins.md#the-store-connectors-and-features) for live data: read entities, bind them to model objects
  and act through a connector's allow-list. The [irrigation example](../plugins.md#a-worked-example-irrigation-zones)
  ([`docs/examples/irrigation.ts`](../examples/irrigation.ts)) is a feature plugin built on it, with a data file.
- The built-in plugins in [`src/plugins/`](../../src/plugins) are plugins like this one: `sun` is the smallest; `pins`
  adds a screen-space picker, a hover provider, search and a chip with variants.
- [The HUD design](../design/hud-panels.md): where panels, sections, chips and status items sit, and why.
