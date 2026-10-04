# HUD audit: the prototype viewer's UI, as of the import

Status: design input for phase 2 (HUD panel standard). Source audited: `legacy/` (`index.html`, `main.js`, `ha.js`,
`faults.js`, `pins.js`, `switches.js`, `sun.js`), run with mock Home Assistant data at 1440 × 900 and 390 × 844.

> The screenshots this audit refers to (`img/before-*.jpg`) were taken of the prototype on a private building and are
> not in the repository (`docs/design/img/` is git-ignored); the file names are kept as references.

## Summary: the main problems

1. **One panel does everything.** `#hud` (bottom left) holds location, navigation, sun, blueprints, Home Assistant
   status, HA scene buttons, the faults toggle, equipment-pin toggles, category chips, equipment search, its results,
   wall-plate toggles and a 13-chip status row. It grows as plugins load and as features are switched on: from
   ~400 × 375 px to **1,095 × 575 px (≈ 49 % of a 1440 × 900 viewport)** with pins on and a search open
   (`img/before-07-pin-search.jpg`). The 3D view, which is the product, loses its lower half.
2. **The flag row sets the panel's width.** `#flags` is 13 chips in one line, so the whole HUD is ~1,100 px wide even
   when every other row is 400 px; the right two-thirds of the panel is empty translucent glass over the view.
3. **Layout shifts as things load.** HA, faults, pins and plates each un-hide rows when their module arrives, so the
   panel jumps upward 1–4 times during the first seconds; rows also appear and vanish with state (blueprint options,
   pin categories, search hits, blink test).
4. **Panels collide.** The inspector (`#info`, top right) and the HUD overlap each other at 1440 × 900 when either is
   tall (`img/before-08-pin-inspect.jpg`, `img/before-09-plate-inspect.jpg`). The fault list (top left) is placed with a
   fixed `top: 50px` and `max-height: 46vh`, and only misses the HUD by luck of the viewport height. The help overlay
   is taller than the viewport, clipped at the top, and the HUD draws on top of it (`img/before-01-first-visit-help.jpg`).
5. **Every plugin writes the same inspector by hand.** `main.js`, `pins.js`, `switches.js` and `faults.js` each set
   `#info.innerHTML` to their own `<h2>` + `<table>` and each re-wire the ✕. HA injects rows and a button into the
   generic panel from outside (`ha.infoRows`, `ha.panel`). No sections: an object that is a fixture _and_ a registry
   item _and_ an HA entity is one undifferentiated key/value table with colour-coded key cells as the only grouping.
6. **Raw data, not information.** The generic inspector dumps every glTF extra (`layer`, `fixture_group`,
   `material`, `hit at` plan coordinates). Notes fields are shown in full: a pin's location note or a plate's notes run
   to 40+ lines and push the panel to full height (`img/before-09-plate-inspect.jpg`). Titles are internal ids in
   monospace (`Fixture_den.fan`).
7. **No visual system.** Five different button styles (`#hud button` native, `.hactl`, `.haswitch button`,
   `.swtoggle`, `#pincats button`), native checkboxes, native selects, native range sliders (bright blue), ad-hoc
   colours (`#ffd479` for headings, links, keys and warnings alike; `#8fd3ff` for HA keys and links). 11–14 px
   type, no scale. No focus styles beyond the browser default; several controls `blur()` themselves after a click,
   so keyboard focus is thrown away.
8. **Hidden or inconsistent controls.** Most features have a key (X, U, O, K, F, G, V, P, L…) but only some have HUD
   controls; the flag chips _look_ like toggles but aren't clickable. Cutaway, upper storey, doors, an enclosure, furniture,
   ghost: only by keyboard (or the help sheet). On touch devices they are unreachable.
9. **No small-screen story.** At 390 px wide the HUD covers the lower 55 % of the screen, its rows overflow to the
   right, and there is no way to collapse it (`img/before-11-phone.jpg`). Walk mode needs a keyboard and pointer lock.
10. **Native dialogs.** `window.confirm()` for house-wide scripts and the blink test; the blink test's progress and
    results (a `<textarea>` of YAML) are rendered inside the HUD.
11. **Coupling.** Plugins find their UI by `document.getElementById` on ids that live in `index.html` (`#harow`,
    `#pinrow`, `#platerow`, `#pincats`…). A new plugin can't add UI without editing `index.html` and `main.js`'s
    `flags()`. `main.js`'s keydown switch hard-codes every plugin's keys, and the help table is hand-written HTML.

## Catalogue

Each entry: what it does · owner today · problems.

### Global / chrome

| Surface                                                 | What it does                                                                                                                                     | Owner                                  | Problems                                                                                                                                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading screen `#loading` (`img/before-00-loading.jpg`) | Full-screen slate "Loading house model…" until the glb is parsed; on failure the same element shows the error text                               | `main.js` `loadModel`                  | No progress (bytes, stages); the error is a sentence on a full-screen slate with dev instructions (a "run the sync script" hint); background colour unrelated to the rest of the UI. On a first visit the help sheet and the half-built HUD ("—", empty selects) draw _over_ the loading screen and hide its text |
| Furniture loading                                       | Shown only as a flag chip "Furniture loading…"                                                                                                   | `main.js` `flags()`                    | Background loads (furniture, parts, blueprints index, pins, devices) have no shared progress indicator                                                                                                                 |
| Help `#help` (`img/before-01-first-visit-help.jpg`)     | Key table, shown once on first visit and on H / **?**                                                                                            | `index.html` (static)                  | Taller than the viewport (no scroll; top clipped); HUD draws over it; prose-length rows; hand-maintained, so it drifts from the code (plugin keys listed even when the plugin isn't loaded); private names in the text |
| Help button `#helpbtn`                                  | **?** top-left                                                                                                                                   | `index.html`                           | The only toolbar button; nothing else is reachable by pointer except through the HUD                                                                                                                                   |
| Crosshair `#cross`                                      | Centre cross in walk mode                                                                                                                        | `main.js`                              | Fine. Hidden in overview                                                                                                                                                                                               |
| Hover label `#hover`                                    | Name of what's under the crosshair (walk: under it; overview: follows the cursor). Fault markers and pins win over the model; HA adds `· on 82%` | `main.js` `hover()` + `ha.hoverSuffix` | Internal ids (`Fixture_x`, merged-node names) as the label; monospace; no icon or category; plugins can only add a suffix through a special case in `main.js`                                                          |

### The HUD `#hud` (bottom left; `img/before-02-hud.jpg`)

| Row                                     | What it does                                                                                                                                | Owner                                                    | Problems                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where am I `#where`                     | Room name, storey, plan X/Y/Z in ft; in overview, an orbit-controls hint                                                                    | `main.js` `updateWhere`                                  | Coordinates are developer info shown permanently; the overview text is a hint, not status; no compass/heading                                                   |
| Go to                                   | `<select>` of rooms (alphabetical); choosing one teleports in walk mode                                                                     | `main.js` `buildRoomMenu`                                | Native select of every room (dozens), no search, no storey grouping; the 1–6 viewpoints are only on keys                                                        |
| Time / Date / Now / animate the year    | Sun position by local clock time and day of year; label gives elevation/azimuth and solar noon                                              | `main.js` + `sun.js`                                     | Three rows always open, though rarely used; native sliders; useful but not "always visible" material                                                            |
| Blueprint + options                     | Sheet `<select>` (with calibration error); when one is shown: model opacity slider, "hide above", "on floor"                                | `main.js` blueprint code (`img/before-10-blueprint.jpg`) | Rows appear/disappear; the option labels are terse ("on floor"); B toggles "the last sheet" which isn't visible anywhere                                        |
| HA status `#harow`                      | Dot (grey/amber/green/red/blue) + label + Connect / Disconnect                                                                              | `ha.js` `setStatus`                                      | Status, not a control panel: belongs in a status strip. Long error reasons are clipped with an ellipsis and only on `title`                                     |
| HA controls `#hactlrow`                 | Allow-listed script / scene / switch buttons ("Movie mode", "Pump: on · 490 W")                                                         | `ha.js` `drawControls`                                   | Site-specific buttons occupy the main panel permanently; wraps to two lines; `confirm()` for dangerous ones                                                     |
| Blink test `#hablink`                   | Step-by-step guided test inside the HUD, then YAML to paste                                                                                 | `ha.js` `drawBlink`                                      | A modal workflow squeezed into a HUD row                                                                                                                        |
| Faults through walls `#hawallrow`       | Checkbox for the V overlay                                                                                                                  | `ha.js` / `faults.js`                                    | The rest of the faults UI is a separate floating panel; Shift-V ("show all") has a checkbox only in that other panel                                            |
| Equipment pins `#pinrow`, `#pincats`    | On / through-walls checkboxes, count, 13 category chips (click hides, double-click solo)                                                    | `pins.js`                                                | Chips wrap to two rows; double-click-to-solo is undiscoverable; the chips are always there once pins are on                                                     |
| Find equipment `#pinsearch`, `#pinhits` | Search box (`/`), up to 8 hits that fly to the item                                                                                         | `pins.js` (`img/before-07-pin-search.jpg`)               | The only search in the app is a pins feature, inside the HUD; results expand the HUD upward; it doesn't search rooms, fixtures, plates or devices               |
| Wall plates `#platerow`                 | On / through-walls checkboxes, kind `<select>`, count                                                                                       | `switches.js`                                            | Third copy of the same "layer on / through walls / filter / count" pattern, each with different markup                                                          |
| Flags `#flags`                          | 13 status chips: Walk, Overview, Cutaway, Upper hidden, Doors, Ghost, Crouch, <enclosure> hidden, HA faults…, All devices, Pins, Plates, Furniture | `main.js` `flags()` (knows every plugin)                 | Not clickable though they look like toggles; sets the HUD's width to ~1,100 px; "Furniture hidden" lit means _loading_; mode (walk/overview) shown as two chips |

### Inspector `#info` (top right)

| Variant                                                     | What it does                                                                                                                                      | Owner                                                         | Problems                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic object (`img/before-03-inspect-generic.jpg`)        | Name (part name from `parts.json`, else node name) + every extra + material + hit point                                                           | `main.js` `showInfo`                                          | Internal names as titles; raw extras; no grouping                                                                                                                                                        |
| Light fixture + HA (`img/before-04-inspect-fixture-ha.jpg`) | Adds a Turn on / off button, "toggles N bulbs", a low-confidence warning, HA rows (entity, state, last changed), a registry link                  | `main.js` + `ha.js` `panel()`/`infoRows()` + `pins.byFixture` | HA's button is inserted after the `<h2>` by `main.js`; HA rows are told apart only by a blue key colour; the panel is re-rendered wholesale every 300 ms while state changes (focus and scroll are lost) |
| Equipment pin (`img/before-08-pin-inspect.jpg`)             | Id, category, status, where, make/model/serial, specs, connections (links that fly), linked-from, HA entities, documents, photos, questions, file | `pins.js` `show()`                                            | Its own markup; long notes in full; links styled as underlined text; category letter dot in the title is the only visual identity                                                                        |
| Wall plate (`img/before-09-plate-inspect.jpg`)              | Box id, kind, room, gangs, conf, notes, per-position role / breaker / fixtures (links) / box links, HA state, mock-only toggle                    | `switches.js` `info()`                                        | 40-line notes paragraph; the panel's height is the viewport; links inside prose                                                                                                                          |
| Fault device (`img/before-05-faults-list-and-device.jpg`)   | Status + reasons, model, integration, area, where + why, links (fixture, registry item, plate, "open in Home Assistant"), health entities         | `faults.js` `show()`                                          | Fourth bespoke layout; the severity dot is the only shared element with the list                                                                                                                         |

Shared: one inspector at a time, a ✕ in the corner, no keyboard close (Esc releases pointer lock instead), no
"back" after following a link, no pin/compare, `max-height: calc(100vh − 40px)` so it routinely runs the full height.

### Fault list `#faultlist` (top left; `img/before-05-faults-list-and-device.jpg`)

Device health while V is on: severity chips (click to hide a severity), "show all N", fold toggle, devices grouped by
room, worst first; a click flies there and opens the device's inspector. Owner `faults.js`.
Problems: a second floating panel with its own position rule; collides with the HUD on shorter screens; its own
chip/row/heading styles; the fold arrow is a tiny ▾ at the far right; the "show all" checkbox duplicates Shift-V
without saying so.

### Things that aren't HUD but are UI

- **3D markers** (fault markers, equipment pins, plate markers, light halos): drawn in WebGL by each plugin. Colours
  are chosen per plugin (fault red `#e0443a`-ish / amber / blue / green; pin category colours; plate amber / blue /
  violet). They must share a palette with the panels (see the standard's status colours).
- **Walk vs overview:** walk mode takes pointer lock on the first click; while locked, the HUD can't be used at all
  and nothing says so except the crosshair. Esc releases it. Overview uses OrbitControls; clicks inspect.
- **Blink test, confirm dialogs:** `window.confirm()`.

## What to keep

- The dark translucent surface over the 3D view, 8 px radius, small type: the right family, applied inconsistently.
- Keyboard-first operation (one key per layer, Shift for "through walls"): keep, but register keys through an API so
  help and tooltips are generated.
- Links that fly to objects (connections, fixtures, plates) and the fault list's "worst first, by room": the best
  interactions in the app; make them a shared pattern.
- Lazy plugin loading with graceful absence: a missing data file just hides the feature. Keep, without layout jumps.
