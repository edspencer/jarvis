# jarvis

## 0.6.0

### Minor Changes

- [#29](https://github.com/edspencer/jarvis/pull/29) [`32ecfe0`](https://github.com/edspencer/jarvis/commit/32ecfe0bd5b38c2e68afc89cde7bbba249ddd1f4) Thanks [@edspencer](https://github.com/edspencer)! - The demo house is now a furnished four-bedroom suburban house: three bedrooms and two bathrooms upstairs, a study and
  a powder room downstairs, and a garage wing with a laundry; furniture, appliances, lights, switches and outlets in
  every room, and the equipment as registry pins. The living room has one TV, with the sofa facing it. The main panel in
  the garage has a 16-circuit monitor beside it (an Emporia Vue 2 stand-in), and the energy map is what that monitor
  would report to Home Assistant: the mains, the Balance and a meter per clamped circuit, each feeding what is on its
  breaker. The mock energy loads are more believable (a dishwasher is no longer a washing machine, the air handler has
  its own profile, the EV charges overnight, the dryer runs in the evening). `docs/demo-house.md` is the house's
  inventory and panel schedule.

## 0.5.0

### Minor Changes

- [#20](https://github.com/edspencer/jarvis/pull/20) [`b7e802b`](https://github.com/edspencer/jarvis/commit/b7e802bc7be2740ba818b32041bc498e0ed35c1d) Thanks [@edspencer](https://github.com/edspencer)! - A voice assistant, optional and off unless a site enables it (`plugins.assistant.server`, a same-origin path such as
  `/assistant`). The browser plugin adds an Assistant panel (Shift-M) with the streamed transcript, tool chips that fly
  to what they name, a text box and a mic button; hold M anywhere to talk (a phone holds the mic button), answer the
  assistant's confirmations in a dialog with a countdown, and hear replies through the browser's speech synthesis. It
  can fly the view to a subject, highlight things and switch view layers. `?assistant=mock` scripts a fake server in the
  page. The plugin's code is downloaded only on sites that enable it.

  The server, `server/` (`jarvis-assistant`, a separate Node 22 package that is not in the image), runs one rolling
  Claude Agent SDK session behind one WebSocket, with house tools over Home Assistant, the site's registry, rooms and
  fixture map, and a small memory folder; web search and fetch (never to the LAN) and read-only files from a knowledge
  folder; no shell. `POST /assistant/transcribe` forwards audio to any OpenAI-compatible transcription endpoint. Models:
  Claude Sonnet 5 by default, Claude Opus 5.5 for a hard question, both configurable. Credentials: `ANTHROPIC_API_KEY`,
  or `CLAUDE_CODE_OAUTH_TOKEN` for personal use with your own plan only.

  Everything that changes the house goes through one tool and a policy file the site supplies: allow, confirm or deny
  by domain, entity, service, device class and surface, with value bounds and timed runs; anything not listed is denied.
  Confirmations are held by the server (30 s, once, by the person and screen that asked); the model can't approve its
  own request. Authentication is required (access codes or the person's Home Assistant login), with per-user
  confirmations and rate limits. See `docs/assistant.md`.

## 0.4.0

### Minor Changes

- [#26](https://github.com/edspencer/jarvis/pull/26) [`b7b99a6`](https://github.com/edspencer/jarvis/commit/b7b99a65538a8423a5d5feec65eab3178895c4bc) Thanks [@edspencer](https://github.com/edspencer)! - Plugins without a fork. A `plugins.<id>` section with a `module` loads that ES module (relative to the manifest) as a
  plugin, with the section's other fields as its `ctx.config`; `npm run build-plugin -- plugin.ts out.js` builds one.
  Only a manifest on the viewer's own origin (after redirects) loads external plugins, from that origin or one it lists
  in the new top-level `pluginOrigins`, and never through a redirect: a `?site=` link can't bring code. The container now
  sends a Content-Security-Policy (`script-src 'self' 'unsafe-eval'` plus `JARVIS_PLUGIN_ORIGINS`) that enforces this
  in the browser; `'unsafe-eval'` is there for three.js's Basis (KTX2) transcoder, and the demo house gained a KTX2
  texture to keep that tested. An external plugin whose id is a built-in's is skipped with a warning. A plugin may
  declare its letter `keys` (a section's `keys` wins, and `validate-site` checks it) and a `validate(config)` that runs
  before `setup`; `validate-site` checks the module is there, and with `--run-plugin-code` imports it to check what it
  exports. Only the enabled plugins' code is downloaded now (every built-in chunk was fetched on every site before).
  Plugins can bind Esc, with a `when` (bindings with a `when` share a key): after a modal, a text field, the mouse lock,
  a menu and the search, Esc cancels a plugin's active tool before it closes the inspector.

- [#24](https://github.com/edspencer/jarvis/pull/24) [`21a9eca`](https://github.com/edspencer/jarvis/commit/21a9eca9b0135debb19192bad72adfa506fae7d3) Thanks [@edspencer](https://github.com/edspencer)! - Walk on a touch screen: a thumb-stick (analog: push further to go faster), drag on the view to look around (at the same time as the stick), and tap to inspect what is under the finger. Phones still open in the overview; the status strip keeps its Walk / Overview switch on small screens, so walking is one tap away. Help lists the touch controls on a touch device.

### Patch Changes

- [#23](https://github.com/edspencer/jarvis/pull/23) [`6e8dea9`](https://github.com/edspencer/jarvis/commit/6e8dea9337856b04ad2d0da393e2ec6f3489bedf) Thanks [@edspencer](https://github.com/edspencer)! - The rail's red count badge (the Faults panel's devices in fault) has a darker fill, a new `--jv-bad-fill` token, so its
  white number meets WCAG AA contrast (5.2:1; it was 3.4:1 on `--jv-bad`, which is unchanged). The neutral badge's fill
  is a token too, `--jv-badge-fill`.

- [#22](https://github.com/edspencer/jarvis/pull/22) [`fc27252`](https://github.com/edspencer/jarvis/commit/fc272526e80aa8ebd7cae095e27a3738c87d4222) Thanks [@edspencer](https://github.com/edspencer)! - Blueprint fade and energy mode no longer leave the house faded: B on, J on, B off (or any other order) now puts back the right materials. Plugins get one core mechanism for temporary materials, `ctx.three.materials.push(meshes, material | fn, { priority })` (an override taken off with `dispose()`, and when the plugin stops) `materials.base(mesh)` and `MATERIAL_PRIORITY`; the blueprints, energy and lights plugins use it.

- [#27](https://github.com/edspencer/jarvis/pull/27) [`5d5318e`](https://github.com/edspencer/jarvis/commit/5d5318e879deb677d0621f18f14c0bd94bdd2466) Thanks [@edspencer](https://github.com/edspencer)! - `MATERIAL_PRIORITY.energy` is 10 (it was 0), so a plugin's material override at the default priority sits under energy mode instead of tying with it. `materials.base(mesh)` is typed as the mesh's material (`Material | Material[]` for a plain `THREE.Mesh`) instead of casting the array case away, and it is the way to read a mesh's own material: picking and the inspector's Material row use it (they no longer show energy mode's ghost), and `mesh.userData.baseMaterial` is internal. On a touch screen, the window losing focus lets go of the thumb-stick, so a stick held through an app switch doesn't keep walking.

## 0.3.0

### Minor Changes

- [#15](https://github.com/edspencer/jarvis/pull/15) [`4a33584`](https://github.com/edspencer/jarvis/commit/4a33584e5d9c884f9345d7ad8c51265dc631c2b1) Thanks [@edspencer](https://github.com/edspencer)! - An Energy plugin, vendor-neutral: it reads power and energy entities from the store (whichever connector supplies them)
  through a site map, `plugins.energy.map` (`jarvis-energy/1`, schema in `schema/energy.schema.json`, checked by
  `npm run validate-site`), that arranges meters from the feed down to a plug, sums the legs of 240 V circuits, shows
  each parent's unmetered remainder as _Other_ and ties every meter to the registry items, plates, fixtures, nodes and
  rooms it feeds. It adds an Energy panel (Shift-J: the house's load, sources and storage, panels, top consumers, now or
  today), energy mode (J: the house ghosted, metered rooms and objects tinted by load on a log scale, with a legend), an
  Energy section in the inspector with a 24-hour sparkline, a status item, hover labels and search. `?ha=mock` makes up
  loads for the demo; the demo house has a map. Documented in `docs/plugins/energy.md`.

- [#15](https://github.com/edspencer/jarvis/pull/15) [`4a33584`](https://github.com/edspencer/jarvis/commit/4a33584e5d9c884f9345d7ad8c51265dc631c2b1) Thanks [@edspencer](https://github.com/edspencer)! - A `plugins.<id>` section this build doesn't have is now a warning, not an error: the viewer skips that plugin, says so
  once in the console ("site config for plugin 'x', which this build doesn't have: skipped", with a "did you mean" for a
  near miss) and loads the rest, so a site written for a newer viewer no longer stops an older one at the loading screen.
  `npm run validate-site` reports it the same way. A typo inside a known plugin's section is still an error.

### Patch Changes

- [#18](https://github.com/edspencer/jarvis/pull/18) [`5070c67`](https://github.com/edspencer/jarvis/commit/5070c67e54d7fd3ada153b132787bd3eaae9f0a0) Thanks [@edspencer](https://github.com/edspencer)! - HUD accessibility fixes, found by the new axe checks:

  - The 3D view is now the page's `<main>` landmark, named by a visually hidden `<h1>` with the site's name.
  - The rail's panel toolbar sits inside a `<nav>`.
  - Rows in a block list are list items.
  - The status chips' variant buttons are at least 24 px wide.
  - A modal's scrolling body can be reached from the keyboard.

- [#17](https://github.com/edspencer/jarvis/pull/17) [`778c17a`](https://github.com/edspencer/jarvis/commit/778c17a19317b7ca23d7017a6cace09a631c33c4) Thanks [@edspencer](https://github.com/edspencer)! - `validate-site` accepts models compressed with `KHR_meshopt_compression` (`gltfpack -ce khr`) as well as
  `EXT_meshopt_compression`; the viewer loads both.

- [#10](https://github.com/edspencer/jarvis/pull/10) [`f385079`](https://github.com/edspencer/jarvis/commit/f385079aeb39ac58d866129602a11ad94df3eae9) Thanks [@edspencer](https://github.com/edspencer)! - The build now ships `LICENSE` and `THIRD_PARTY_NOTICES.md` (the licences of the bundled three.js, three-mesh-bvh, Lit,
  home-assistant-js-websocket, and the meshopt, KTX2 and Basis Universal decoders), so the release tarball and the
  container image carry them. `npm run notices` regenerates the notices from the build; a new workflow checks them and
  the production dependencies' licences.

- [#13](https://github.com/edspencer/jarvis/pull/13) [`3cb694e`](https://github.com/edspencer/jarvis/commit/3cb694e8d786c8344fede1dbca7f7cc07c306774) Thanks [@edspencer](https://github.com/edspencer)! - A connector's `refusal(ids, action, data)` now gets the call's data. Home Assistant's connector now refuses up front for
  everything its `call()` would refuse, data keys included, so a `store.call()` across connectors is never half sent
  because of bad data. A plugin icon that the sanitiser strips completely now shows the default icon instead of nothing.

- [#19](https://github.com/edspencer/jarvis/pull/19) [`75d9a3b`](https://github.com/edspencer/jarvis/commit/75d9a3b3dc08de7c33d093c4ad919ee47d545f8b) Thanks [@edspencer](https://github.com/edspencer)! - The status strip makes room for the inspector as soon as it opens. It used to wait for its next refresh, and in the
  meantime a wide strip (with the energy load in it, say) could cover the inspector's close button.

## 0.2.0

### Minor Changes

- [#1](https://github.com/edspencer/jarvis/pull/1) [`2873805`](https://github.com/edspencer/jarvis/commit/28738055641f4aaea853ac1c5335e2e5c371ce2e) Thanks [@edspencer](https://github.com/edspencer)! - A generated demo house (`examples/demo-site`, the default dev site), CI, and a release flow that publishes a tarball and
  a container image (nginx serving the viewer, with your site folder mounted).

- [#2](https://github.com/edspencer/jarvis/pull/2) [`d5041f2`](https://github.com/edspencer/jarvis/commit/d5041f2471396b512efd2255094c5526df161cb8) Thanks [@edspencer](https://github.com/edspencer)! - A plugin API and a new HUD. Everything over the 3D view now comes from plugins through one API, imported from
  `jarvis/plugin` and documented in `docs/plugins.md`: dock panels, inspector sections, status-strip chips and items,
  legends, toasts, modals, hover labels, search providers and keys (help is generated from the key registry). Plugins
  start in `requires` / `after` order, in isolation (one that fails is disposed and reported; the walkthrough carries on).
  A core entity store sits between connectors (Home Assistant) and feature plugins (lights, faults, pins, plates), with
  bindings from the site's mapping files and recorder history.

  The HUD is Lit components behind declarative blocks, per `docs/design/hud-panels.md`: a rail and a two-panel dock on
  the left, an inspector with sections from several plugins on the right, a status strip with clickable layer chips,
  global search, generated help, a staged loading screen, and bottom sheets on phones (overview only).

  Home Assistant calls are allow-listed per entity at the one `send()` choke point, from the site's controls file and
  fixture map. The fixture map moves to `plugins.lights.map`; `plugins["home-assistant"].map` is still read, with a
  warning.

### Patch Changes

- [#9](https://github.com/edspencer/jarvis/pull/9) [`45d68eb`](https://github.com/edspencer/jarvis/commit/45d68eba6c1ad02187c81aa533f770d104057e23) Thanks [@edspencer](https://github.com/edspencer)! - Safer plugin plumbing. A plugin's own SVG icon now goes through an allowlist: the HUD rebuilds it from drawing
  elements and presentation attributes, and drops scripts, event handlers, styles, links, `<use>` and animation. A
  `store.call()` across several connectors now checks every connector's refusal before it sends anything, so a refusal
  can't leave the action half done. Each `<jv-blocks>` element now keeps its own expanded and collapsed state.
