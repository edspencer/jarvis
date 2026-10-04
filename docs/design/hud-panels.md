# HUD panel standard

Status: **implemented in phase 2b** (the plugin API: `src/core/plugin/`, documented in `../plugins.md`; the HUD:
`src/ui/`). What changed on the way is in §11. Companion docs: `hud-audit.md` (what was wrong), `mockup/index.html`
(the target look).

Goals, from the audit:

- The 3D view is the product: the default screen shows **almost nothing** over it, and nothing grows without bound.
- One standard panel anatomy, so every plugin's UI looks and behaves the same.
- **Plugins contribute UI through an API**, never by editing `index.html` or `main.ts`.
- Keyboard-first stays; pointer and touch get equal reach; help is generated.

## 1. Layout regions

```
┌───────────────────────────────────────────────────────────────────────────┐
│ [rail]  ┌ status strip: place · mode · layer chips · connectors · progress ┐ │
│  ☰      └──────────────────────────────────────────────────────────────────┘ │
│  ⌕      ┌ dock (left) ┐                                 ┌ inspector (right) ┐│
│  ☀      │ panel       │                                 │ header            ││
│  ▦      │ panel       │            3D view              │ section (base)    ││
│  ⚑      │  …          │                                 │ section (plugin)  ││
│  ⚡      └─────────────┘                                 │ section (plugin)  ││
│  ◎                                                       └───────────────────┘│
│  ?                    ┌ toasts (bottom centre) ┐                              │
│                       └────────────────────────┘    [legend] (bottom right)   │
└───────────────────────────────────────────────────────────────────────────┘
```

| Region           | Position                                                 | Holds                                                                                    | Rules                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Rail**         | Left edge, 44 px wide, full height                       | One icon button per dock panel, plus search and help at the ends                         | Always visible (it's 3 % of the width). Badges for counts (faults: `17`). Tooltip = title + key                                                                                                 |
| **Dock**         | Right of the rail, 320 px, top-aligned                   | The open dock panels, stacked                                                            | 0–2 panels open at once by default (opening a third collapses the oldest unpinned one). Scrolls internally; never taller than the viewport minus the status strip. Width can be dragged 280–480 |
| **Inspector**    | Right edge, 360 px, top-aligned                          | One _subject_ (the selected object) with sections from every plugin that knows it        | Opens on select, closes on Esc / ✕ / deselect. Sections collapse independently; the body scrolls, the header doesn't. Back / forward history when following links                               |
| **Status strip** | Top, centred between rail and inspector, one line, 32 px | Read-only status items and **toggle chips** for layers                                   | Never wraps: overflow goes into a `⋯` menu. Chips are real buttons (click = same as the key)                                                                                                    |
| **Legend**       | Bottom right, above the inspector's bottom               | Colour keys for whatever overlays are on (faults, load tint, pin categories)             | Only while an overlay that registered a legend is on; stacked, compact                                                                                                                          |
| **Toasts**       | Bottom centre                                            | Transient results and errors ("Turned off Den lamp", "Home Assistant: login expired") | Auto-dismiss 4 s (errors stay until dismissed); max 3; `aria-live`                                                                                                                              |
| **Modal**        | Centre                                                   | Help, confirms, guided flows (blink test), settings                                      | Focus-trapped, Esc closes, scrolls inside, max 90 vh. Replaces every `window.confirm()`                                                                                                         |
| **Hover label**  | At the crosshair (walk) or cursor (overview)             | Title + one line from the providers                                                      | Plugins contribute through `hover` providers, not suffix hacks                                                                                                                                  |
| **Loading**      | Centre over a dimmed first frame                         | Stage list with progress (model, colliders, furniture, plugins)                          | Background loads after the first walkable frame move to a thin progress bar in the status strip                                                                                                 |

**Walk mode with pointer lock.** While the pointer is locked, the dock and inspector stay _visible but inert_ (dimmed
to 85 % opacity, no hover states) and the status strip shows `Esc to use the panels`. Esc releases the lock (as now).
Inspect-by-click in walk mode opens the inspector without releasing the lock. **Esc releases the lock; a second Esc
closes the inspector**, so one key press never does two things. Panels never
steal focus from the canvas while the lock is held.

**Overview (orbit) mode.** Everything is live; the dock and inspector take pointer events, the canvas the rest.
Overview gets a larger default for the dock (a panel such as equipment pins or top consumers is usually open).

**Remembering state.** Per site, in `localStorage` (`jarvis.ui.<siteId>`): which dock panels are open, pinned and
collapsed, dock width, inspector section collapse per section id, status-chip states that the plugins mark persistent.
URL parameters (`?pins`, `?bp=…`) still win on load.

**Small screens (< 720 px wide) and touch.**

- The rail becomes a bottom tab bar (5 icons + "more").
- The dock and inspector become **bottom sheets** with three snap points (peek 96 px, half, full); only one sheet open.
- The status strip shrinks to the place, the Walk / Overview switch and one overflow menu.
- Walk mode gets on-screen controls: a left thumb-stick and look-by-drag on the right half; tap = inspect.
  (As built: see §11.)
- Hit targets ≥ 40 px; no hover-only information (tooltips become long-press).

## 2. Panel kinds and anatomy

Three kinds, one anatomy.

| Kind                   | Lives in                   | Examples                                                                                                 |
| ---------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Dock panel**         | Dock, opened from the rail | Navigate (rooms, viewpoints), Sun & time, Blueprints, Equipment, Faults, Energy, Home Assistant controls |
| **Inspector section**  | Inspector, for a subject   | Base (object), Fixture, Equipment, Wall plate, Device health, Energy, Home Assistant entity              |
| **Status item / chip** | Status strip               | Place, mode, layer toggles, connector status, background progress                                        |

Anatomy of a panel and of a section:

```
┌──────────────────────────────────────────┐
│ [icon] Title             [badge] [⋯] [▾] │  header: 32 px; icon 16 px in the plugin's accent colour;
├──────────────────────────────────────────┤          ⋯ = panel menu (settings, pin, docs); ▾ = collapse
│ body                                     │  body: standard blocks (below), scrolls if needed
│                                          │
├──────────────────────────────────────────┤
│ [secondary]                    [primary] │  actions: optional footer, right-aligned primary
└──────────────────────────────────────────┘
```

**Standard body blocks** (core provides them; plugins compose them, so most plugins never write CSS):

| Block                                               | Use                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `kv`                                                | Key/value rows. Keys 12 px muted; values 13 px. Long values clamp to 3 lines with "more"                                        |
| `note`                                              | Prose (notes, location notes). Clamped to 3 lines, expand inline. Never full-height by default                                  |
| `list`                                              | Clickable rows: leading dot/icon, primary text, secondary text, trailing value. A row with a `subject` flies there and opens it |
| `group`                                             | Collapsible group heading with a count (rooms in the fault list)                                                                |
| `chips`                                             | Filter chips (toggle, solo with Alt-click _and_ a "only" item in the chip's menu, so it's discoverable)                         |
| `toggle`, `slider`, `select`, `segmented`, `search` | Themed controls                                                                                                                 |
| `meter`                                             | Live value with unit and a sparkline (energy W, battery %)                                                                      |
| `badge` / `status`                                  | Severity pill using the shared status colours                                                                                   |
| `link`                                              | Subject link (object, registry item, plate, device): styled as a chip with its type icon, not underlined prose                  |
| `button`                                            | Primary / secondary / danger; `confirm` option opens the standard modal                                                         |
| `empty`, `error`, `loading`                         | Standard states with a retry action                                                                                             |

**Inspector as a host.** The inspector shows one **subject**. A subject is a typed reference, not a DOM node:

```ts
type Subject =
  | { kind: 'object'; node: Object3D; part?: PartRef; hit?: Vector3 } // anything picked in the model
  | { kind: 'entity'; id: string }; // something a plugin owns: 'pins:elec.panel.a', 'plates:KT-S-A', 'devices:zha-1234'
```

The core resolves a subject's **title, icon and type line** from the plugin that owns it (or from the model for a
plain object), then asks every registered section provider "do you have something for this subject?". Providers
answer synchronously with a section or `null`, and may update it live. Sections are ordered by `order` (base first,
then owner, then others), each collapsible and remembered by id. Example: a wall plate that has a circuit sensor and
a smart switch on it shows **four sections from four plugins**: _Object_ (core), _Wall plate_ (plates),
_Energy_ (energy), _Home Assistant_ (HA). See the mockup.

Base section (core, collapsed by default): the developer data the old panel showed up front: source node, part,
material, extras, hit point. The header and the owner's section carry the human-readable information.

## 3. Data architecture the UI sits on: connectors, the store, feature plugins

From the owner's direction (2026-10-03):

- **Connector plugins** talk to a system and normalise what they get into a shared **store** in core: devices,
  entities (with a `deviceClass`, unit, state, attributes), and readings (time series). Home Assistant is the first
  connector; others (MQTT, a vendor cloud, a CSV replay) can follow. A connector also contributes UI: a **status item**
  (connected / live / error) and, optionally, an "account" panel or modal for login.
- **Feature plugins** (lights, faults, pins, plates, energy, sun, blueprints) read the store and the site's mapping
  files, draw in the scene, and contribute panels and sections. They **don't know which connector** supplied an
  entity. Service calls go through `ctx.store.call(entityId, action)`, which the owning connector executes under its
  allow-list.
- **Site mapping files** bind store entities to model objects (fixtures, registry items, plates, rooms). They belong
  to the site, not the plugin, so the same plugin works for another building.

### Worked example 2: Energy

A vendor-neutral energy plugin. Readings arrive as ordinary store entities with a `power` (W) or `energy` (kWh)
device class, from circuit monitors, smart plugs, PV inverters and batteries; Home Assistant is just where they come
from today. A site file binds them to the model in a hierarchy, so totals don't double-count:

```yaml
# site/energy.yaml (sketch)
meters:
  - id: main
    power: sensor.main_power # whole-house
    children:
      - id: panel.a
        object: { registry: elec.panel.a }
        power: sensor.panel_a_power
        children:
          - id: circuit.a.12
            label: Kitchen counter outlets
            breaker: { registry: elec.panel.a, position: 12 }
            power: sensor.panel_a_circuit_12_power
            feeds: [{ plate: KT-O-A }, { room: kitchen }]
            children:
              - id: plug.coffee
                power: sensor.coffee_plug_power
                feeds: [{ registry: appl.coffee }]
  - id: pv
    kind: source # sources and storage are signed, not summed into loads
    power: sensor.pv_power
  - id: battery
    kind: storage
    power: sensor.battery_power
```

A meter's **unmetered remainder** is its power minus its children's, shown as "other" so the hierarchy always adds up.

UI contributions:

| Contribution                           | Region         | Content                                                                                                                                                                                                       |
| -------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rail button ⚡ + dock panel **Energy** | Dock           | Now: total load, PV, battery, grid (signed). **Top consumers**: a `list` of meters sorted by W, each with a bar and sparkline; a row flies to its object and opens it. A segmented control: _Now / Today_.    |
| Overlay **load tint** + legend         | Scene + legend | Objects and rooms tinted by W on a sequential scale (5 steps, 0 → max), off by default; key `E`; chip in the status strip; legend bottom right                                                                |
| Inspector section **Energy**           | Inspector      | For a breaker / circuit, appliance, plate or room that a meter feeds: live W (`meter` block), today's kWh, a 1-hour sparkline, the parent ("on Panel A · circuit 12") and children as links, share of parent. |
| Status item                            | Status strip   | `⚡ 2.4 kW` (click opens the panel)                                                                                                                                                                           |
| Hover provider                         | Hover label    | `· 1,210 W` after the name of a metered object                                                                                                                                                                |

## 4. Plugin UI API (sketch)

Everything a plugin adds is returned as a **disposable**; unloading the plugin removes it. All text is plain strings
or the standard blocks; `render` is the escape hatch.

```ts
export interface Plugin {
  id: string; // 'energy'
  name: string; // 'Energy'
  requires?: string[]; // ['store'] — connector-agnostic
  setup(ctx: PluginContext): void | Promise<void>;
}

export interface PluginContext {
  site: SiteInfo; // ids, units, the site's mapping files: ctx.site.load('energy.yaml')
  scene: SceneApi; // overlays, markers, tint, fly(subject), select(subject), pick providers
  store: Store; // devices/entities/readings from every connector
  hud: HudApi;
  inspector: InspectorApi;
  status: StatusApi;
  keys: KeyApi;
  toast(t: ToastSpec): void;
  confirm(c: ConfirmSpec): Promise<boolean>;
  modal(m: ModalSpec): ModalHandle;
  prefs: Prefs; // per-site persisted plugin prefs
  log: Logger;
}

// ---------------------------------------------------------------- dock panels and the rail
interface HudApi {
  addPanel(p: PanelSpec): PanelHandle;
  addLegend(l: LegendSpec): LegendHandle;
}
interface PanelSpec {
  id: string; // 'energy.consumers'
  title: string;
  icon: IconRef; // a core icon name or an SVG string
  key?: KeySpec; // opens / closes it; shown in help and tooltip
  order?: number; // position on the rail
  badge?: () => string | number | null;
  render(body: PanelBody): void | (() => void); // fill with blocks; return cleanup
  actions?: ActionSpec[];
  when?: () => boolean; // e.g. hide until the store has energy entities (no layout jump: the rail icon just appears)
}

// ---------------------------------------------------------------- inspector sections
interface InspectorApi {
  addSection(s: SectionProvider): Disposable;
  registerSubject(kind: string, r: SubjectResolver): Disposable; // titles/icons for 'pins:*', 'plates:*'…
  open(s: Subject): void;
  refresh(match?: (s: Subject) => boolean): void; // re-render live sections (throttled by core)
}
interface SectionProvider {
  id: string; // 'energy'
  title: string;
  icon: IconRef;
  order?: number; // base 0, owner 10, others 50+
  defaultCollapsed?: boolean;
  for(s: Subject): SectionContent | null; // null = not relevant
}
type SectionContent = { blocks: Block[]; actions?: ActionSpec[] } | { render(el: HTMLElement): () => void };

// ---------------------------------------------------------------- status strip, keys
interface StatusApi {
  addItem(i: { id: string; order?: number; render(): StatusView; onClick?(): void }): Disposable;
  addToggle(t: {
    id: string;
    label: string;
    icon?: IconRef;
    key?: KeySpec;
    get(): boolean;
    set(v: boolean): void;
    variants?: { label: string; key: KeySpec; get(): boolean; set(v: boolean): void }[];
  }): Disposable;
  progress(label: string): ProgressHandle;
}
interface KeySpec {
  code: string;
  shift?: boolean;
  label: string;
  group?: string;
  when?: () => boolean;
}
interface KeyApi {
  add(k: KeySpec & { run(e: KeyboardEvent): void }): Disposable;
}
```

The energy plugin, in those terms:

```ts
export default definePlugin({
  id: 'energy',
  name: 'Energy',
  requires: ['store'],
  async setup(ctx) {
    const map = await ctx.site.load<EnergyMap>('energy.yaml'); // no file: the plugin just doesn't appear
    const meters = buildTree(map, ctx.store); // entity ids → live readings, remainders

    ctx.hud.addPanel({
      id: 'energy',
      title: 'Energy',
      icon: 'bolt',
      key: { code: 'KeyE', shift: true, label: 'Energy panel' },
      badge: () => fmtKW(meters.root.power),
      render: (body) =>
        body.blocks(() => [
          {
            type: 'kv',
            rows: [
              ['Load', fmtKW(meters.load)],
              ['Solar', fmtKW(meters.pv)],
              ['Battery', fmtKW(meters.batt)],
            ],
          },
          {
            type: 'list',
            title: 'Top consumers',
            rows: meters.top(8).map((m) => ({
              icon: m.icon,
              text: m.label,
              secondary: m.parentLabel,
              value: fmtW(m.power),
              bar: m.share,
              spark: m.history('1h'),
              subject: m.subject,
            })),
          },
        ]),
    });

    const tint = ctx.scene.addTint({
      id: 'energy.load',
      scale: 'sequential',
      domain: () => [0, meters.max],
      value: (obj) => meters.forObject(obj)?.power ?? null,
    });
    ctx.status.addToggle({
      id: 'energy.tint',
      label: 'Load',
      icon: 'bolt',
      key: { code: 'KeyE', label: 'Tint by load' },
      get: () => tint.on,
      set: (v) => tint.set(v),
    });
    ctx.hud.addLegend({ id: 'energy.load', title: 'Load (W)', when: () => tint.on, scale: tint.scale });

    ctx.inspector.addSection({
      id: 'energy',
      title: 'Energy',
      icon: 'bolt',
      order: 60,
      for: (s) => {
        const m = meters.forSubject(s);
        return (
          m && {
            blocks: [
              { type: 'meter', value: m.power, unit: 'W', spark: m.history('1h') },
              {
                type: 'kv',
                rows: [
                  ['Today', fmtKWh(m.today)],
                  ['Share of parent', pct(m.share)],
                ],
              },
              { type: 'links', title: 'On', items: [m.parent?.subject] },
              { type: 'links', title: 'Feeds', items: m.children.map((c) => c.subject) },
            ],
          }
        );
      },
    });
    ctx.store.onChange(meters.entityIds, () => ctx.inspector.refresh((s) => !!meters.forSubject(s)));
  },
});
```

Notes on the API:

- **Declarative blocks first.** Most plugins build UI from blocks; the core renders them, diffs on refresh (so a
  live value updating every second doesn't lose scroll or focus, unlike today's 300 ms `innerHTML` rewrite), and
  applies the theme. `render(el)` exists for anything bespoke (a chart, a guided flow) and gets a container element
  with the theme's CSS variables in scope.
- **Keys are registered, never hard-coded**: the help modal and every tooltip are generated from the registry; a
  conflict is reported in the console at load. Core keeps the movement and view keys.
- **Subjects make links universal.** Any plugin can link to any subject (`{ type: 'link', subject: 'pins:elec.panel.a' }`),
  and the core flies there and opens it, with history (Back with `Alt+←` or the header's ←).
- **`when` instead of hidden rows.** A feature with no data simply doesn't register (or its rail icon appears),
  so nothing jumps.

## 5. Visual design tokens

Dark translucent surfaces over a bright 3D scene. CSS custom properties on `:root` (`--jv-*`), the same values
exported as a TS object for the WebGL markers so panels and markers share a palette.

**Surfaces**

| Token                 | Value                                                                  | Use                           |
| --------------------- | ---------------------------------------------------------------------- | ----------------------------- |
| `--jv-surface`        | `rgba(18, 21, 27, 0.86)` + `backdrop-filter: blur(12px) saturate(1.2)` | Panels, inspector, strip      |
| `--jv-surface-raised` | `rgba(32, 37, 46, 0.92)`                                               | Headers, menus, hover rows    |
| `--jv-surface-sunken` | `rgba(255, 255, 255, 0.04)`                                            | Inputs, list rows, sparklines |
| `--jv-border`         | `rgba(255, 255, 255, 0.08)`                                            | 1 px hairlines                |
| `--jv-shadow`         | `0 8px 24px rgba(0,0,0,.35)`                                           | Floating surfaces             |
| `--jv-radius`         | 10 px panels, 6 px controls, 999 px chips                              |

Fallback without `backdrop-filter`: opacity 0.94.

**Text** (on `--jv-surface` over white, the worst case; all ≥ 4.5:1)

| Token             | Value     | Use                                      |
| ----------------- | --------- | ---------------------------------------- |
| `--jv-text`       | `#e9edf2` | Primary                                  |
| `--jv-text-muted` | `#9aa4b2` | Keys, secondary                          |
| `--jv-text-faint` | `#6b7585` | Disabled, hints (not for essential info) |
| `--jv-accent`     | `#7cc4ff` | Links, focus, selected                   |

**Status colours** (shared with the fault markers, plate markers and toasts; one meaning each)

| Token       | Value     | Meaning                                           |
| ----------- | --------- | ------------------------------------------------- |
| `--jv-ok`   | `#3fcf6a` | Healthy, on, live                                 |
| `--jv-warn` | `#f0b43c` | Attention (battery low, weak signal, unconfirmed) |
| `--jv-bad`  | `#ef5a4f` | Fault, offline, error                             |
| `--jv-info` | `#6aa8ff` | Update available, mock data, informational        |
| `--jv-off`  | `#7a8494` | Off, unknown, not connected                       |

**Badge fills** (a count badge's background, under its label; checked for 4.5:1 in `tests/unit/tokens.test.ts`)

| Token             | Value     | Use                                                          |
| ----------------- | --------- | ------------------------------------------------------------ |
| `--jv-bad-fill`   | `#c9372c` | A fault count (white label; `--jv-bad` under white is 3.4:1) |
| `--jv-badge-fill` | `#2c3c55` | A neutral count (`--jv-text` label)                          |

Status is never colour alone: each has a glyph (✓ ! ↑ ○) as the markers already do.

**Data scales.** Sequential (load tint): 5 steps from `#2b3a55` to `#ffd166` to `#ff6b3d`; categorical (pin
categories): 12 hues checked against each other and against the status colours, each with its letter.

**Type.** System UI stack; numbers `font-variant-numeric: tabular-nums`; monospace only for ids and code.
Scale: 11 (caption) · 12 (keys, chips) · 13 (body) · 15 (section title) · 17 (subject title) · 22 (modal title).
Line-height 1.4.

**Spacing.** 4 px grid: 4 · 8 · 12 · 16 · 24. Panel padding 12; row height 28 (36 on touch).

**Focus.** `outline: 2px solid var(--jv-accent); outline-offset: 2px` on `:focus-visible`, everywhere; no `blur()`
after click. Selected rows: accent left border plus raised surface.

**Motion.** 120 ms ease-out for open/collapse; `prefers-reduced-motion` turns it off (and the marker pulse).

## 6. Accessibility

- Every control reachable by Tab when the pointer isn't locked; the rail is a `toolbar` (arrow keys move), the dock
  and inspector are `region`s with labels; the inspector's sections are disclosure buttons.
- `F6` cycles regions (rail → dock → inspector → status → canvas); `Esc` closes the innermost (modal, menu, search)
  after releasing pointer lock, then cancels a plugin's active tool (its Esc binding), then closes the inspector
  (`src/core/escape.ts`).
- Live values announce politely only on user request (no `aria-live` for streaming W); toasts are `aria-live=polite`,
  errors `assertive`.
- Contrast ≥ 4.5:1 for text and 3:1 for UI boundaries on the surface over a white scene (worst case: the sky).
- Hit targets ≥ 24 px desktop, 40 px touch. Everything in a tooltip is also in the inspector or help.
- A screen-reader user on a touch-only device can't walk (the thumb-stick is `aria-hidden`, and W A S D need a
  keyboard), but walking only moves the camera: everything it can show is reachable without it, through the overview,
  search and the inspector (§11, touch walk controls).

## 7. Rendering technology

Options: **plain DOM + a tiny helper** (`h()` + a keyed list patcher, ~1 KB), **Lit** (web components,
~6 KB gzipped), **Preact** (+ signals, ~5 KB gzipped).

|                                                 | Plain DOM + helper                             | Lit                                                                                                                                                                    | Preact                                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Size                                            | ~1 KB                                          | ~6 KB                                                                                                                                                                  | ~5 KB (+ ~1 KB signals)                                                                                                                 |
| Live updates without losing focus/scroll        | Write a patcher (that's what we'd be building) | Built in (template diffing)                                                                                                                                            | Built in (VDOM)                                                                                                                         |
| TS support                                      | Fine, but untyped markup strings               | Good; `lit-analyzer` for templates                                                                                                                                     | Excellent (TSX)                                                                                                                         |
| Plugin authors' ergonomics                      | Imperative, verbose                            | Templates or plain elements                                                                                                                                            | JSX, familiar                                                                                                                           |
| Third-party plugins without build-time coupling | Yes                                            | **Yes: custom elements are a browser contract.** A plugin built with any tool (or none) can use `<jv-panel>`, `<jv-kv>` by tag name; no shared library instance needed | No: a plugin must use the host's Preact instance (two copies of Preact don't share hooks/context); forces a peer dependency and a build |
| Style isolation                                 | None                                           | Shadow DOM, themed by CSS variables that pierce it                                                                                                                     | None                                                                                                                                    |

**Recommendation: Lit for core's components, exposed to plugins as custom elements, behind the declarative block
API.**

- Plugins mostly write _data_ (blocks). The core renders them with its own Lit components, so plugin authors don't
  need to know Lit exists, and the core can change renderers later without breaking plugins.
- For bespoke UI, a plugin gets an `HTMLElement` and may use the core's custom elements (`<jv-meter>`,
  `<jv-list>`), any framework it bundles itself, or plain DOM. Custom elements and CSS variables are the stable
  contract; there's no shared JS instance to version-match.
- Shadow DOM keeps a plugin's CSS from leaking into the HUD and vice versa; the `--jv-*` variables theme across it.
- 6 KB is small next to three.js (~150 KB gzipped).
- Preact would be the pick for an app-internal UI, but the peer-instance problem bites exactly the case we care
  about (third-party plugins loaded at run time). Plain DOM is what the prototype has; the audit shows where it leads.

## 8. Mapping today's UI onto the new structure

| Today                                                             | New home                                                                                                                                         | Owner                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `#where` room, storey                                             | Status strip: place item (room · storey); coordinates move to the base inspector section and a "copy position" action                            | core                                                                 |
| Walk / Overview flags                                             | Status strip: segmented mode switch (Tab)                                                                                                        | core                                                                 |
| Cutaway, upper, doors, enclosure, furniture, ghost flags               | Status strip: **toggle chips** (clickable, keyed); rarely used ones in `⋯`                                                                       | core (enclosures and the like: layer toggles declared by the site, not hard-coded) |
| Crouch flag                                                       | Status strip, transient indicator only while crouched                                                                                            | core                                                                 |
| Go to room + 1–6 viewpoints                                       | Dock panel **Navigate** (rail ◎): searchable room list grouped by storey, saved viewpoints, "copy link to this view"                             | core                                                                 |
| Time / date / now / animate                                       | Dock panel **Sun & time** (rail ☀); status item shows the time when it isn't "now"                                                               | `sun` plugin                                                         |
| Blueprint list + options                                          | Dock panel **Blueprints** (rail ▦); B toggles; legend shows the sheet name and fit error                                                         | `blueprints` plugin                                                  |
| HA dot + Connect                                                  | Status strip: connector item (dot + "Home Assistant · live"); click opens a small connector panel (connect / disconnect / error details)         | `home-assistant` connector                                           |
| HA scene / script buttons                                         | Dock panel **Controls** (rail ⏻), site-configured actions with standard confirm                                                                  | `home-assistant` connector (actions declared by the site)            |
| Blink test                                                        | Modal guided flow launched from the fixture's HA section                                                                                         | `home-assistant` / `lights`                                          |
| Light switch button, bulb count, unconfirmed warning, entity rows | Inspector section **Light** (lights plugin: state, toggle) + **Home Assistant** (entity, mapping confidence, last change)                        | `lights` + `home-assistant`                                          |
| Faults through walls checkbox, V / Shift-V, fault list            | Status toggle chip **Faults** (V; Shift-V variant "all"); dock panel **Faults** (rail ⚑ with count badge) grouped by room; legend for severities | `faults` plugin                                                      |
| Fault device inspector                                            | Subject `devices:<id>`; section **Device health** + **Home Assistant**                                                                           | `faults` + `home-assistant`                                          |
| Pins on / through walls, category chips, count                    | Status toggle chip **Pins** (P; Shift-P variant); dock panel **Equipment** (rail ▤) with category chips (legend doubles as filter)               | `pins` plugin                                                        |
| Find equipment `/`                                                | **Global search** (rail ⌕, `/`): core search over providers; pins, rooms, plates, devices, fixtures each register a provider                     | core + every plugin                                                  |
| Pin inspector                                                     | Subject `pins:<id>`; section **Equipment** (specs, connections as links, documents, notes clamped)                                               | `pins` plugin                                                        |
| Plates on / through walls, kind select, count                     | Status toggle chip **Plates** (L; Shift-L variant); filter in the chip's menu                                                                    | `plates` plugin                                                      |
| Plate inspector                                                   | Subject `plates:<box>`; section **Wall plate** (positions as a list, breakers as links, notes clamped)                                           | `plates` plugin                                                      |
| Generic object inspector                                          | Header from the object's name, cleaned; **Object** base section (collapsed)                                                                      | core                                                                 |
| Hover label + HA suffix                                           | Hover providers                                                                                                                                  | core + plugins                                                       |
| Help + **?**                                                      | Generated help modal (keys grouped by plugin, only loaded plugins), rail **?**                                                                   | core                                                                 |
| Loading text, furniture loading flag                              | Loading screen with stages; status-strip progress bar for background loads                                                                       | core                                                                 |
| `window.confirm()`                                                | `ctx.confirm()` modal                                                                                                                            | core                                                                 |
| _(new)_ Energy                                                    | Rail ⚡ panel, inspector section, load tint + legend, status item                                                                                | `energy` plugin                                                      |

## 9. Decisions (owner)

**Decided 2026-10-03:** (1) rail + dock left, inspector right, as mocked; (2) status strip at the top, coordinates move
to the inspector's base section + copy-link; (3) two dock panels stacked; (4) Lit, behind the declarative block API;
(5) overview-only on phones for the first release; (6) energy hierarchy is site data, unmetered remainder shown as
_Other_; (7) dark theme only for now (keep the tokens theme-ready). The questions as asked:

1. **Rail + dock on the left, inspector on the right** (as mocked), or everything on one side so the other half of
   the view is always clear?
2. **Status strip at the top** with clickable layer chips, replacing the flag row. OK to drop the always-on plan
   coordinates (they move to the inspector's base section and a copy-link action)?
3. **How many dock panels open at once**: one (simplest, like a sidebar) or two stacked (proposed)?
4. **Lit** as the core component library, with the declarative block API for plugins (recommended), or Preact?
5. **Mobile walk controls** in scope for the first release, or overview-only on phones at first?
6. **Energy hierarchy file** (`site/energy.yaml` shape above): agree it's site data, with "unmetered remainder"
   shown as _Other_?
7. Theme: dark only, or a light theme too (the tokens allow it; it doubles the contrast checks)?

## 10. Mockup

`mockup/index.html` (static HTML/CSS; open it over any static server, `?scene=walk|equipment|faults|energy`).
Screenshots, before → after (taken on a private building, so not in the repository: `docs/design/img/` is git-ignored; the mockup in the repository uses demo-house backgrounds):

| Scene | Before | After |
|---|---|---|
| Walking, a light fixture inspected: *Light* + *Home Assistant* sections, *Equipment* and *Object* collapsed | `img/before-04-inspect-fixture-ha.jpg` | `img/after-walk.jpg` |
| Overview, Equipment panel (search, category chips, grouped list) + a breaker panel with *Equipment* + *Energy* sections | `img/before-08-pin-inspect.jpg` | `img/after-equipment.jpg` |
| Walking, faults through walls: Faults panel, legend, device with *Device health* + *Home Assistant* | `img/before-05-faults-list-and-device.jpg` | `img/after-faults.jpg` |
| Overview, Energy: totals, top consumers (fly-to), rooms tinted by load + legend; a wall plate with four sections from four plugins (*Wall plate*, *Energy*, *Home Assistant*, *Object*) | (new) | `img/after-energy.jpg` |

## 11. As built (phase 2b): what differs from the proposal

- **Subjects:** the proposal's `{ kind: 'entity', id }` is `{ kind: 'item', id }`, so it doesn't read as a store
  entity. String references (`'pins:<id>'`, `'fixture:<id>'`, `'room:<id>'`) work wherever a subject does.
- **The Object section comes last** (collapsed), as in the mockup, not first: "base first" put developer data above
  the information.
- **Section actions** (Turn off, Run) gather in the inspector's footer next to the core's *Fly to*, as mocked.
- **The store's entity shape is Home Assistant's state object** (`entity_id`, `state`, `attributes`), a widely used
  one, rather than a new one; other connectors map into it. Bindings (`store.bind`) are how site mapping files tie
  entities to fixtures, registry items, plates and devices, and why the Home Assistant section appears on all of them.
- **Lights are a feature plugin** (`plugins.lights`, with the fixture map); Home Assistant is only the connector. The
  old `plugins["home-assistant"].map` is still read (with a warning), so existing manifests keep working; a site with
  a `home-assistant` section and no `lights` section gets the lights plugin too.
- **Allow-list at the choke point:** every call names entities from the controls file or the fixture map (a
  `switch.*` only when marked as a light); an action across domains is checked whole before any part is sent. No
  plugin can widen it at run time (the console hook is read-only). It guards against bugs and misclicks, not hostile
  code: the login's tokens are in `localStorage` (see the README).
- **Public plugin entry:** plugins import from `jarvis/plugin` (`src/plugin-api.ts`) only; its types are narrowed to
  published shapes (`SiteInfo`, `ModelInfo`, `ViewState`), not the core's internals. Keys can be hold keys
  (`release`); connectors can serve recorder history (`store.history`). The public custom elements of §7 are
  `<jv-blocks>`, `<jv-meter>` and `<jv-list>`.
- **Chips:** rarely used ones (the site's layers, *Hide upper*) live in the strip's ⋯ menu from the start (their keys
  work); others overflow there when the strip is too narrow, chips that are off first. Variants (through walls; plates:
  switches / outlets only) are in a chip's ▾ menu.
- **Keys:** N opens Navigate (new; the site validator reserves it). `?` also opens help. Tab switches the mode only
  while focus isn't on a HUD control reached from the keyboard; F6 gets into the HUD.
- **Persisted state:** open, pinned and collapsed panels, dock width, section and group collapse, per site. Chips can
  ask to be remembered (`persist`); none of the built-in ones do yet (URL parameters cover the shared cases).
- **Small screens:** a bottom tab bar (search, four panels, more), one bottom sheet at a time (peek / half / full by
  dragging or tapping its handle). A phone still opens in the overview (decision 5); the strip keeps the
  **Walk / Overview** switch (its chips go into ⋯), so walking is one tap away.
- **Touch walk controls** (`<jv-stick>` in `ui/shell.ts`, `core/touch.ts`): on a touch screen (a coarse pointer, or
  the last pointer down was a finger: a mouse on a laptop's touch screen brings the pointer lock back), walk mode shows
  an analog **thumb-stick** bottom left: direction and how far it's pushed (36 px is full speed, a 12 % dead zone),
  fed to the walker as an analog input next to W A S D. `Hud.stickAt()` places it: on a phone above the tab bar or a
  peek sheet (hidden behind a half or full one); wider, right of the rail, or right of the dock while a panel is open,
  hidden when that leaves no room before the inspector. A modal hides it and lets go (no walking behind a dialog);
  toasts move up above it. **Drag on the view** to look (one finger, anywhere on the canvas, in practice the right
  thumb; drag right turns right, up looks up; the screen's width is half a turn), at the same time as the stick
  (Pointer Events with capture, one pointer each; a mode change or a lost capture ends the drag). A **tap** (under
  10 px and 500 ms) picks at the finger like a click in the overview, through the plugins' `click` event; a drag or a
  cancelled touch never inspects, and touch never asks for the pointer lock. A tap-inspect while walking on a phone
  opens the inspector as a peek sheet, so the view and the stick stay usable; the sheet's height comes back when the
  inspector closes. No crosshair on touch. The canvas and the stick are `touch-action: none`. The stick is
  `aria-hidden` and not focusable (the keyboard moves with W A S D, so it traps nothing); its knob springs back over
  `--jv-motion`, which reduced motion sets to 0. The window losing focus lets go of it too (as it does the held keys),
  so a stick held through an app switch doesn't keep walking. A screen-reader user on a touch-only device can't walk
  (no stick for them, and no keyboard), but reaches all the information through the overview, search and the
  inspector. The strip's mode switch has a 40 px tall hit area on small screens.
  Help lists the touch controls on a touch screen. Not yet on touch: jump and crouch (ghost, on at start, is in the
  strip's ⋯), running, pinch-to-zoom in walk mode, long-press for hover.
- **The blink test** (§8) is a confirm modal, then a sticky toast that steps through the bulbs ("Which fixture
  blinked? Aim at it and press T"), then a results modal, rather than one modal flow: the test needs the view, where you
  aim at the fixture that blinked, and a modal would cover it.
- **Energy** ([`plugins/energy.md`](../plugins/energy.md)): energy mode is on **J** (Shift-J the panel), not E: Q
  and E are the core's turn keys and Shift-E is the core's too. The map is JSON, `jarvis-energy/1` with a schema
  (`plugins.energy.map`), rather than the sketched `energy.yaml`, so the site validator checks it like the other
  mapping files; feeds name a `registry`, `plate`, `fixture`, `node` or `room`, and a breaker is a number on the
  circuit rather than an object. List rows have bars but no per-row sparkline (the `list` block has none); the meter
  and inspector sparklines cover 24 hours rather than one. The site schema interpreter gained `type` arrays (an entity
  or a list of them) for it.
- **Not done:** the overview's larger default dock; loading third-party plugins at run time (the host takes plugin
  definitions, but only the built-in registry feeds it); the `meter` block's live announcements; a light theme.

