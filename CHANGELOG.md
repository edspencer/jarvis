# jarvis

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
