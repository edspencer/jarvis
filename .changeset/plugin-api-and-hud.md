---
'jarvis': minor
---

A plugin API and a new HUD. Everything over the 3D view now comes from plugins through one API, imported from
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
