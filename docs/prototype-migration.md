# How the prototype's building moved into a site manifest

JARVIS began as a viewer for one house. Phase 1 ported it to TypeScript and marked every value that described that
building (`// SITE:`); phase 2a moved them all into the house's own `site.json`, kept with its data in the house's
(private) repository. The code now holds no building. This note maps where each thing went, as a guide for anyone
moving a single-building viewer of their own onto JARVIS.

The house's manifest passes `npm run validate-site`, and the parity check (`tests/e2e/parity.spec.ts`) renders its
viewpoints identically to the prototype.

## Values

| In the prototype                                                                                 | Now                                                                                    |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| latitude, longitude, time zone                                                                   | `geo`                                                                                  |
| true azimuth of plan +Y                                                                          | `frame.northAzimuth`                                                                   |
| the building's centre (shadow target, far ground, orbit target)                                  | `centre`                                                                               |
| overview camera start                                                                            | `overview.camera` (default: fitted to the model)                                       |
| far ground level / colour                                                                        | `ground.z` / `ground.colour` (default grass)                                           |
| shadow camera extent (a 90 m square)                                                             | `sun.shadowRadius` (default: fitted to the model)                                      |
| viewpoints 1–6 and their names in the help                                                       | `viewpoints`, `startView`; the help row is generated                                   |
| upper floor level, "upper storey" threshold, HUD label threshold, the plates' upstairs threshold | `storeys[].z`, `objectsFrom`, `from` (the plates' threshold folded into `objectsFrom`) |
| "(upstairs)" for `Floor_U_*` rooms                                                               | a room above the first storey gets its storey's `short` name                           |
| eye height, crouch, radius, max step (tuned to steps without treads)                             | `walk` (metres; only `maxStep` differs from the defaults)                              |
| title, "Built from …" line, loading text                                                         | `name`, `description`                                                                  |
| EST / EDT labels                                                                                 | the runtime's own short zone names (`Intl`)                                            |
| file names (`house.glb`, parts, blueprints, HA files, registry)                                  | `models`, `plugins.*`                                                                  |
| default blueprint sheet                                                                          | `plugins.blueprints.default`                                                           |
| Home Assistant URL (`VITE_HASS_URL`)                                                             | `plugins["home-assistant"].url`                                                        |
| registry source link (`VITE_REGISTRY_SOURCE_URL`) and path prefix                                | `plugins.pins.sourceLink` (`{file}` template), `stripPrefix`                           |
| registry categories                                                                              | `plugins.pins.categories` (the old set is the default)                                 |
| source rows in the faults and plates panels                                                      | `plugins.faults.source`, `plugins.switches.source`                                     |
| wiring-sheet box-id format                                                                       | `plugins.switches.boxIdPattern` (default: the plates' own box ids)                     |
| emitter material hints                                                                           | `plugins["home-assistant"].emitterHints` (the old list is the default)                 |

## Model conventions

| In the prototype                                            | Now                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| `Roof_*` or material `roof_tile`                            | layer `roof` (`match`; `Roof_` is the default)                  |
| `Ceil_*`                                                    | layer `ceiling`                                                 |
| door material names, extra `door_leaf`                      | layer `door` (`door_leaf` is the default), key O                |
| an enclosure layer: a name prefix or a `layer` extra, key K | a site layer with its own key, label and help line              |
| furniture: extra `layer: furniture`, a second glb, key F    | an extra model whose nodes join a site layer with its own key   |
| `Win_`, `WinFrame_`, `WinMull_`, `Label_` walk-through      | `colliders.passable` (these are the defaults)                   |
| glass, water, a wire screen's wire fraction                 | `materials.glass`, `.water`, `.screens`                         |
| `Floor_*` rooms                                             | `rooms.floorPrefix` (the default)                               |
| plan frame in feet                                          | `frame.units` (`ft` default, or `m`)                            |
| blueprint index `corners_ft`, `z_floor_ft`, `rms_ft`        | read as they are; `corners`, `z_floor`, `rms` are the new names |

All of these are written down in [model-format.md](model-format.md).

## What changed for the viewer's users

- `?nofurniture` is now `?noextra` (every extra model with a key waits for it).
- The flag row is built from the manifest's layers, in the same order as before for a site with a door layer, its
  own layers and an extra model.
- The console hook gained `twin.site` and `twin.extras` / `twin.loadExtra()` (was `twin.furn` /
  `twin.loadFurniture()`), and `twin.root` (was `twin.house`).
