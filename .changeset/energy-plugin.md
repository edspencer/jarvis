---
'jarvis': minor
---

An Energy plugin, vendor-neutral: it reads power and energy entities from the store (whichever connector supplies them)
through a site map, `plugins.energy.map` (`jarvis-energy/1`, schema in `schema/energy.schema.json`, checked by
`npm run validate-site`), that arranges meters from the feed down to a plug, sums the legs of 240 V circuits, shows
each parent's unmetered remainder as _Other_ and ties every meter to the registry items, plates, fixtures, nodes and
rooms it feeds. It adds an Energy panel (Shift-J: the house's load, sources and storage, panels, top consumers, now or
today), energy mode (J: the house ghosted, metered rooms and objects tinted by load on a log scale, with a legend), an
Energy section in the inspector with a 24-hour sparkline, a status item, hover labels and search. `?ha=mock` makes up
loads for the demo; the demo house has a map. Documented in `docs/plugins/energy.md`.
