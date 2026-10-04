# Your own building

From a 3D model to a running viewer: what JARVIS needs, how to get a model out of Blender, SketchUp or a scan, how to
write the `site.json`, how to check it, run it and deploy it. The demo house in
[`examples/demo-site`](../../examples/demo-site) is the worked example throughout; the reference documents are the
[model format](../model-format.md) and the [manifest schema](../../schema/site.schema.json).

## 1. The site folder

The viewer holds no building. One building is a **site folder**: a `site.json` manifest, the model, and any data files
the manifest names. Paths in the manifest are relative to it. The demo's:

```
examples/demo-site/
  site.json                the manifest
  demo.glb                 the main model (walls, floors, roof, fixtures…): what you walk on
  demo.parts.json          the parts file for its merged nodes (optional)
  furniture.glb            an extra model, on the furniture layer (optional)
  furniture.parts.json
  ha_map.json              the fixture map: which Home Assistant entities light each fixture (optional)
  ha_controls.json         the Controls panel and the switching allow-list (optional)
  ha_devices.json          the faults plugin's device map (optional)
  registry_pins.json       equipment registry pins (optional)
  blueprints/              scanned drawings and their index (optional)
```

Keep your own under `sites/` in a checkout (git ignores it, and `*.glb` outside `examples/`), or anywhere else.

**The minimum** is a `site.json` with `jarvis`, `id`, `name`, `geo`, `models.main` and one viewpoint, and one glTF
file. With only that you can walk and orbit the model, inspect what you click, and have the sun in the right place for
the date and time. Each convention adds a feature:

| Convention                                                        | What it unlocks                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| top-level nodes with names                                        | the inspect panel's titles; layer and collider rules by name                     |
| `Floor_<room>` nodes with a `room` extra                          | the room list (N), "where am I", room search                                     |
| `Roof_` nodes                                                     | X (cutaway) and U hide them                                                      |
| `Ceil_` nodes                                                     | X hides them                                                                     |
| a `door_leaf` extra (or `layer: "door"`)                          | O shows and hides door leaves (hidden at start: doors are open)                  |
| `Win_`, `WinFrame_`, `WinMull_`, `Label_` names, `passable` extra | walked through                                                                   |
| materials named `glass` / `water` (or a `role` extra)             | see-through, click-through, walked through                                       |
| `storeys` in the manifest (two or more)                           | U hides the upper storey; "where am I" names the storey                          |
| your own `layers` (name prefix, extra, material)                  | a toggle key for each (the demo's pergola, K)                                    |
| extra models (`models.extra`)                                     | loaded after the main model, on their own layer (the demo's furniture, F)        |
| `merged` extra + parts file                                       | the inspect panel names the original object inside a merged mesh                 |
| `fixture_id` extra on a light fixture                             | the lights plugin: fixtures glow with their Home Assistant state, T switches one |
| a group with `layer: "plants"`                                    | plants drawn instanced, passable                                                 |
| a group with `layer: "switches"`                                  | wall plates (L), with their wiring                                               |
| `plugins.*` sections and their data files                         | Home Assistant, faults (V), pins (P), blueprints (B), energy (J)                 |

`Door_` is only a naming habit (the demo uses it and the inspect panel drops the prefix): the door layer takes nodes by
the `door_leaf` extra or `layer: "door"`, unless you give it a `match`.

## 2. Decide the frame first

Every position in the manifest and the data files is in the **plan frame**: X east, Y north, Z up, in `frame.units`
(`"ft"`, the default, or `"m"`). The model itself is glTF: metres, +Y up. A plan point (X, Y, Z) is the glTF point
(X, Z, −Y) × the unit. Before you export anything, decide:

- **the origin**: a corner of the building or a survey point; keep the building within a few hundred metres of it. The
  demo's is the house's south-west corner.
- **Z = 0 is the finished ground floor.** Storey heights, viewpoints and the far ground (`ground.z`) are measured from
  it.
- **plan north**: square the plan to the building (walls along X and Y), then measure the compass bearing of plan +Y.
  That is `frame.northAzimuth` (degrees clockwise from true north); the sun depends on it. The demo's is 12.
- **the units**: `"m"` is simplest. `"ft"` suits a building drawn in feet: the model stays in metres and only the
  manifest's numbers are in feet.

In Blender this is no work at all: Blender is Z up, and its glTF exporter writes Blender (x, y, z) as glTF (x, z, −y),
which is the plan-to-glTF mapping. Model with Blender +Y as plan north and the floor at Z = 0, and Blender's
coordinates _are_ plan coordinates in metres.

## 3. From Blender

### Units and axes

- Scene Properties → Units: Unit System Metric, Unit Scale 1.0, so a Blender unit is a metre (the exporter writes
  Blender units as they are).
- A model imported from elsewhere often arrives in the wrong units: scale it (0.0254 for inches, 0.3048 for feet,
  0.001 for millimetres), then apply the scale (Object → Apply → Scale, Ctrl-A). Apply rotations and scales you don't
  mean to keep; a node's own transform is fine.
- Keep the ground floor at Z = 0 and plan north along +Y, as above.

### Naming the top-level nodes

The viewer works with the **top-level nodes** of the scene: each is one thing it can show, hide, collide with and
inspect. In Blender, an object with no parent becomes a top-level node, named after the object; children of a parent
become its child nodes. Collections are not exported as nodes (by default).

- A room's floor: a mesh named `Floor_<room>`, e.g. `Floor_living_room`, with a `room` extra (below). One per room.
- Ceilings `Ceil_…`, roofs `Roof_…`; windows `Win_…` (glass), `WinFrame_…`, `WinMull_…` (all walked through).
- Walls, stairs and other solid things: any name. Several objects joined into one mesh are fine (fewer draw calls), but
  the inspect panel then shows the joined name, unless you write a parts file ([§6](#6-a-model-made-in-code-the-demo)).
- A light fixture: **one top-level node per fixture**, e.g. an Empty named `Fixture_hall_pendant` with the bulb, shade
  and canopy parented to it, and the `fixture_id` extra on the Empty.
- Doors: a node per leaf with a `door_leaf` extra; the demo names them `Door_<id>`.

The prefixes are defaults: the manifest can change each (`layers[].match`, `colliders.passable`, `rooms.floorPrefix`),
so a model with other names works with rules instead of renaming. See [model format §3](../model-format.md#3-top-level-nodes).

Blender appends `.001` to a duplicate name. That is harmless for nodes (prefix rules still match), but not for
materials (below), and fixture ids must be unique.

### Extras: Custom Properties

glTF `extras` come from Blender's **Custom Properties**. Select the object, Object Properties → Custom Properties →
New, then the gear icon to set the property's name, type and value:

| Object                     | Property       | Type    | Value          |
| -------------------------- | -------------- | ------- | -------------- |
| `Floor_living_room`        | `room`         | String  | `living_room`  |
| `Fixture_hall_pendant`     | `fixture_id`   | String  | `hall.pendant` |
| `Fixture_hall_pendant`     | `fixture_kind` | String  | `pendant`      |
| `Door_front`               | `door_leaf`    | Boolean | on             |
| `Pergola_posts` (optional) | `layer`        | String  | `pergola`      |

Anything else you add (`product`, `installed`, `notes`) shows in the inspect panel as it is. The extras the viewer
reads are listed in [model format §3](../model-format.md#extras-the-viewer-reads-on-top-level-nodes); they must be on
the top-level node (the parent Empty, not the bulb).

Materials take custom properties too (Material Properties → Custom Properties), exported as the material's extras: a
`role` of `glass`, `water` or `screen` (with a `wire` number) gives a material that role whatever its name.

### Materials

Colours and textures come through as they are (Principled BSDF → glTF PBR). The viewer only treats some materials
specially, by **exact name**: `glass` and `water` by default, or the names you list in the manifest's `materials`. So
name the glass material `glass` (not `Glass.001`, not `Window glass`), or list the names you have:

```json
"materials": { "glass": ["glass", "Window glass"], "water": ["pool_water"] }
```

Give the other materials stable names too: layers can select by material (`match.material`) and the inspect panel
shows it.

### Exporting

File → Export → glTF 2.0, Format **glTF Binary (.glb)**, and:

- Include → Data: tick **Custom Properties** (off by default: without it there are no extras, so no rooms and no
  fixtures). Leave Cameras and Punctual Lights off; the viewer has its own sun and fixture lights.
- Transform: **+Y Up** on (the default).
- Data → Mesh: Apply Modifiers on.
- Data → Compression: **off**. That is Draco, which the viewer doesn't load (validate-site reports
  `requires KHR_draco_mesh_compression, which the viewer doesn't load`). Compress with meshopt afterwards instead.

Export the furniture, or anything else you don't need to walk around, to a second file: it becomes an extra model,
loaded after the main one.

### Compressing

The viewer ships the **meshopt** decoder and the **KTX2 / Basis Universal** transcoder (no CDN; it works offline). It
doesn't load Draco. Compressed geometry is several times smaller and quick to decode.

**gltfpack** (from [meshoptimizer](https://github.com/zeux/meshoptimizer)):

```sh
gltfpack -i house-export.glb -o house.glb -cc -tc -kn -ke -km
```

- `-cc`: meshopt geometry, quantised (`EXT_meshopt_compression`, `KHR_mesh_quantization`);
- `-tc`: KTX2 / Basis textures (`KHR_texture_basisu`);
- `-kn` keeps named nodes, `-ke` keeps extras: without them gltfpack may merge nodes and drops the extras, and with
  them the rooms and fixtures;
- `-km` keeps named materials: without it gltfpack merges materials with the same values, whatever their names (a
  `water` that happens to match `glass` becomes `glass`).

Use a native build from the [meshoptimizer releases](https://github.com/zeux/meshoptimizer/releases). The npm package
(`npx gltfpack`) compresses geometry but was built without BasisU and WebP, so `-tc` and `-tw` fail with
`gltfpack was built without BasisU support`. Either meshopt extension loads: `EXT_meshopt_compression` (the default)
or `KHR_meshopt_compression` (`-ce khr`). `-si 0.5` simplifies meshes (half the triangles), useful for scans.

**gltf-transform** ([CLI](https://gltf-transform.dev/cli)): use the single steps, not `optimize`.

```sh
npx @gltf-transform/cli meshopt house-export.glb house.glb
npx @gltf-transform/cli etc1s house.glb house.glb   # or uastc; needs KTX-Software (toktx) installed
```

`gltf-transform optimize` defaults to flattening the scene, joining meshes and nodes (named ones too), instancing
repeated meshes and merging materials into palettes: it turns a whole model into a few nameless nodes. If you use it,
turn those off (`--flatten false --join false --instance false --palette false`), and know that it still merges
materials with the same values.

Check the result with `npm run validate-site` ([§8](#8-check-it)): its summary line counts fixtures and rooms, so a
step that dropped the extras shows at once.

## 4. From SketchUp

SketchUp's axes are already the plan frame: red X, green Y, blue Z up, and SketchUp's north is the green axis unless
set otherwise. Its internal unit is the inch.

- Export glTF with an extension from the Extension Warehouse (search for glTF), or export COLLADA (`.dae`) or FBX
  (SketchUp Pro) and go through Blender. Either way check the scale: a model that comes out 39.37 times too big is in
  inches, 3.28 times in feet.
- Groups and components become nodes; exporters usually name a node after the group's or component instance's name
  (Entity Info → Instance), else its definition. Name them as in §3, or write `match` rules in the manifest for the
  names you have. Open the export in Blender (or read validate-site's summary) to see what the top level ended up as.
- Floors with rooms, fixtures and door leaves need **extras**, which SketchUp exporters don't reliably write. Add them
  in Blender after import, or from the names with a small script before compressing:

  ```js
  // add-extras.mjs (npm install @gltf-transform/core): node add-extras.mjs in.glb out.glb
  import { NodeIO } from '@gltf-transform/core';

  const [input, output] = process.argv.slice(2);
  const io = new NodeIO();
  const doc = await io.read(input);
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  for (const node of scene.listChildren()) {
    const name = node.getName();
    const extras = { ...node.getExtras() };
    let m;
    if ((m = /^Floor_(.+)$/.exec(name))) extras.room = m[1];
    if ((m = /^Fixture_(.+)$/.exec(name))) extras.fixture_id = m[1];
    if (name.startsWith('Door_')) extras.door_leaf = true;
    node.setExtras(extras);
  }
  await io.write(output, doc);
  ```

  Run it on the uncompressed export (reading a meshopt file needs the extension registered), then compress.

Revit and other CAD tools are the same story: export glTF (or FBX, through Blender), check the units, then name or
write rules.

## 5. From a scan

Photogrammetry and LiDAR meshes (Polycam and similar apps export GLB or OBJ; Matterport's MatterPak includes an OBJ
mesh) work as they are: a single mesh is a valid model, and you can walk on it where it is closed. Conventions make
them more useful:

- **Scale and level.** A LiDAR scan is usually in metres; a photogrammetry model often isn't: measure a known
  dimension (a door, 2.0 m or so) and scale. Rotate so the floor is level, the ground floor at Z = 0 and the walls
  square to X and Y; then measure `frame.northAzimuth`.
- **Decimate.** Scans carry millions of triangles and large textures. Blender's Decimate modifier, `gltfpack -si`, or
  `gltf-transform simplify`; then `-tc` (KTX2) or a texture size limit (`gltfpack -tl 2048`).
- **Split out floors.** In Blender's Edit Mode select a room's floor faces, P → Selection, name the new object
  `Floor_<room>` and give it a `room` property. The room list and "where am I" then work.
- **Colliders.** The scan is solid as captured: holes in a floor drop the walker through, holes in a wall let it walk
  through, and scanned furniture and clutter are obstacles. Patch holes, or put a thin box under each room's scanned
  floor (a centimetre below it, as that room's `Floor_` node): you stand on the scan where there is one and on the box
  where there isn't. Move furniture and vegetation into an extra model (never solid) or mark them `passable`.
- **Light.** Scan textures have the light baked in, which looks odd under the viewer's sun; an unlit material
  (`KHR_materials_unlit`, which the viewer loads) can look better.
- There are no fixtures in a scan: add a small node per light fixture with a `fixture_id`, where the fixture is.

## 6. A model made in code: the demo

[`tools/make-demo-site.ts`](../../tools/make-demo-site.ts) (`npm run demo-site`) writes the whole demo site folder with
[glTF Transform](https://gltf-transform.dev): it is an example of producing a compliant model from your own data (a
BIM export, a floor-plan database, a parametric script). Its plan frame is metres, the origin the house's south-west
corner at finished ground-floor level, and one helper
([`tools/demo-site/geometry.ts`](../../tools/demo-site/geometry.ts)) converts plan to glTF:

```ts
export const toGltf = ([x, y, z]: V3): V3 => [x, z, -y];
```

Every node goes through one method, which sets the name, the extras and the position:

```ts
const n = this.doc.createNode(name);
if (what) n.setMesh(what instanceof Shape ? this.mesh(name, what) : what);
if (Object.keys(extras).length) n.setExtras(extras);
if (opts.at) n.setTranslation(toGltf(opts.at));
```

Rooms, doors, windows and fixtures follow the naming conventions:

```ts
m.node(`Floor_${r.id}`, s, { room: r.id, storey: r.storey ? 'first' : 'ground' });
m.node(`Ceil_${r.id}`, c, { room: r.id });
m.node(`Door_${o.id}`, s, {
  door_leaf: true,
  width_m: +(o.b - o.a).toFixed(2),
  ...(o.panels ? { kind: 'sectional garage door', panels: o.panels } : {}),
});
m.node(`Win_${o.id}`, glass, { kind: o.kind === 'glazed' ? 'glazed door' : 'window' });
m.node(`WinFrame_${o.id}`, frame);
m.node(
  `Fixture_${f.id}`,
  fxMesh.get(f.kind)!,
  { fixture_id: f.id, fixture_kind: f.kind.replace(/_/g, ' '), fixture_group: f.group, room: f.room },
  { at: f.at, yaw: f.yaw },
);
```

The walls of a storey are merged into one node (fewer draw calls). The node carries a `merged` key, and the parts file
records each wall under that key, with its box in glTF metres, so the inspect panel can still name the wall under the
cursor:

```ts
model.parts[key] = list;
return model.node(name, shape, { merged: key, ...extras });
```

```json
"walls_ground": [
  ["South wall (ground)", [-0.25, 0, 0, 12.25, 3.2, 0.25], ["render_white"], { "kind": "exterior wall", "thickness_m": 0.25 }],
```

And it writes meshopt-compressed GLB, as gltfpack `-cc` would:

```ts
await MeshoptEncoder.ready;
this.doc.createExtension(KHRMeshQuantization);
this.doc.createExtension(EXTMeshoptCompression).setRequired(true);
await this.doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
```

The script writes `site.json` from the same constants as the geometry (the first floor's `objectsFrom` is the slab's
underside, less 5 cm), so the manifest can't drift from the model.

## 7. The manifest, step by step

Start minimal and add. Every field is in the [schema](../../schema/site.schema.json); editors that read JSON Schema
complete and check it if the manifest names it (`"$schema"`, ignored by the viewer).

### The building and where it is

```json
{
  "$schema": "../../schema/site.schema.json",
  "jarvis": "jarvis-site/1",
  "id": "demo-house",
  "name": "Demo house",
  "description": "A synthetic four-bedroom house with a garage, made by tools/make-demo-site.ts.",
  "geo": { "lat": 51.4779, "lon": -0.0015, "timeZone": "Europe/London" },
  "frame": { "units": "m", "northAzimuth": 12 },
  "centre": [9.5, 4.5],
  "overview": { "camera": [24, -10, 21] },
  "ground": { "z": -0.17 },
```

- `id`: letters, digits, `-`, `_`. `name` is the title; `description` a line in the help.
- `geo`: latitude and longitude in degrees (north and east positive) and an IANA time zone; the sun uses them. The
  coarser the better for privacy: the sun doesn't need the street.
- `frame`: §2. Without it the plan is in feet with north up.
- `centre`: the building's centre on the plan (default 0, 0): the overview looks at it and the shadows centre on it.
- `overview.camera`: where Tab's orbit view starts (plan X, Y, Z); default fitted to the model.
- `ground`: the far ground plane, `z` just under the site's own grade (default 0), and `colour` (`#rrggbb`).
- `sun.shadowRadius`: half the side of the shadowed square round the centre, plan units (default fitted).

### The models

```json
  "models": {
    "main": { "url": "demo.glb", "parts": "demo.parts.json" },
    "extra": [{ "id": "furniture", "url": "furniture.glb", "parts": "furniture.parts.json", "layer": "furniture" }]
  },
```

`main` is required, and is the only model that is solid. Each `extra` has an `id` and a `url`, optionally a `parts`
file and a `layer`: every node of that model joins the layer, and the layer must be declared in `layers`. A URL may be
absolute.

### Storeys

```json
  "storeys": [
    { "name": "ground floor", "z": 0 },
    { "name": "first floor", "short": "upstairs", "z": 3.2, "from": 1.8, "objectsFrom": 2.85 }
  ],
```

Bottom up. `z` is the finished floor level; `from` is the height above which a standing position is on this storey
(default `z`; the demo's 1.8 puts you upstairs halfway up the stair); `objectsFrom` is the height above which an
object's bottom belongs to this storey (default `from`): U hides everything above the second storey's `objectsFrom`,
so set it just under that floor's structure (the demo's slab underside is 2.9). `short` is the HUD's short name.
Without `storeys` there is one, the ground floor at 0, and no U.

### Viewpoints

```json
  "viewpoints": [
    { "name": "Front of the house", "at": [9.4, -14, -0.15], "yaw": 0 },
    { "name": "Living room", "at": [2.0, 4.6, 0], "yaw": 225 },
    { "name": "Landing", "at": [10.2, 4.6, 3.2], "yaw": 90 }
  ],
  "startView": 2,
```

One to nine; keys 1–9 jump to them, and `startView` (1-based, default 1) is where the viewer opens. `at` is plan X, Y
and the floor level there (the walker drops onto the floor from just above it). `yaw` is degrees: 0 looks plan north,
90 west, 180 south, −90 east.

The easiest way to write one: walk to the spot in the viewer, open Navigate (N), Copy link to this view. The link ends
`?at=X,Y,Z,yaw`, in plan units: those four numbers are the viewpoint.

### Layers

```json
  "layers": [
    { "id": "door", "label": "Doors", "key": "O", "hidden": true, "help": "door leaves", "match": { "extra": ["door_leaf"] } },
    { "id": "pergola", "label": "Pergola", "key": "K", "help": "the pergola", "match": { "namePrefix": ["Pergola_"] } },
    { "id": "furniture", "label": "Furniture", "key": "F", "help": "the furniture" }
  ],
```

`roof`, `ceiling` and `door` are built in (X, U, O); list them only to change them. Others are yours: `label` for the
HUD, `key` one capital letter, `help` for the key list, `hidden` to start hidden. `match` takes a node if any rule
matches: `namePrefix`, `layer` (its `layer` extra), `material`, `extra` (a truthy extra). Without `match`, a layer takes
the nodes whose `layer` extra is its id. A `match` replaces the defaults, so restate what you still want.

Layers are never solid (a hidden wall that still blocks you would be confusing). Keys the viewer or an enabled plugin
uses are refused; validate-site lists them.

### Materials, colliders, rooms, walking

```json
  "materials": { "glass": ["glass"], "water": ["water"], "screens": { "insect_screen": { "wire": 0.2 } } },
  "colliders": { "passable": { "namePrefix": ["Win_", "WinFrame_", "WinMull_", "Label_", "Hedge_"], "extra": ["passable"] } },
  "rooms": { "floorPrefix": "Floor_" },
  "walk": { "maxStep": 0.35 },
```

- `materials`: the material names with each role (exact names). A list replaces its default. `screens` maps a name to
  the wire fraction of a wire-mesh screen (0 to under 1).
- `colliders.passable`: what is walked through, as a `match`. It replaces the default (`Win_`, `WinFrame_`,
  `WinMull_`, `Label_` and the `passable` extra), so restate them, as above.
- `rooms.floorPrefix`: the prefix of room floors (default `Floor_`).
- `walk`, in metres whatever `frame.units`: `eyeHeight` (default 1.68), `crouchEyeHeight` (0.91), `radius` (0.3),
  `maxStep` (0.35, the highest step walked up without a jump).

### Plugins

```json
  "plugins": {
    "home-assistant": { "url": "https://homeassistant.example.org", "controls": "ha_controls.json" },
    "lights": { "map": "ha_map.json" },
    "faults": { "devices": "ha_devices.json" },
    "pins": { "registry": "registry_pins.json", "sourceLink": "https://example.org/repo/blob/main/{file}" },
    "switches": {},
    "blueprints": { "index": "blueprints/index.json", "default": "A-1" },
    "energy": { "map": "energy.json" }
  }
}
```

A plugin starts only if its section is there (the sun always; the wall plates whenever the model has them; the lights
with Home Assistant even without their own section). Leave out what you don't have.

- `home-assistant`: `url` is the Home Assistant the browser logs in to; `controls` the Controls panel's actions and the
  switching policy. Without a URL only `?ha=mock` works. Read [SECURITY.md](../../SECURITY.md) and the README's Home
  Assistant section before pointing it at a real one.
- `lights.map`: fixture id → entity, e.g.
  `{ "hall.pendant": { "entity_id": "light.hall", "conf": "high", "group": "fixture.hall" } }`. `entity_id` may be a
  list (all switched together) or `null` (not known yet). Only `light.*` and `switch.*` entities count; a switch needs
  `"switch_is_light": true` here and `fixture_toggle.switch_marked_as_light` in the controls file to be switched.
  `lights.emitterHints` is a regular expression on the material names that glow when a fixture has no emissive
  material.
- `faults.devices`, `pins.registry` (with `sourceLink`, `stripPrefix`, `categories`), `switches.boxIdPattern` and
  `blueprints.index`: the demo's files show each format; the blueprint index is
  [model format §9](../model-format.md#9-blueprint-index). `source` in `faults` and `switches` is free text naming
  where the data came from.
- `energy.map`: the meters and what each one feeds, for the Energy panel and energy mode (J); the format is
  [plugins/energy.md](../plugins/energy.md).

To add your own plugin, follow [Writing a plugin](writing-a-plugin.md); the API reference is [docs/plugins.md](../plugins.md).

## 8. Check it

```sh
npm run validate-site -- sites/mine          # the folder, or the path of its site.json
```

It checks, in order:

1. the manifest against the schema (types, required fields, unknown fields with a "did you mean"); if that fails it
   stops there;
2. the rules a schema can't express: a known time zone, `startView` within the viewpoints, unique layer ids and keys,
   keys not the viewer's own, extra models' layers declared, storeys bottom up, regular expressions that compile, and
   warnings for plugins that can't do anything (lights or faults without Home Assistant, Home Assistant without a URL);
3. every file the manifest names: present and, for JSON, parseable (files on another origin are listed as not
   checked);
4. each model's glTF JSON against the model format: glTF 2.0, required extensions the viewer loads, unique
   `fixture_id`s, nameless top-level nodes, room floors, fixtures, layers that take no node, the wall-plate group if
   the switches plugin is on, and the model's size (a model thousands of metres across was probably exported in
   millimetres);
5. parts files' shape and that they cover the model's `merged` keys; viewpoints more than 30 m outside the model; the
   blueprint index and its images.

It exits 1 on errors; warnings alone pass. The demo:

```
/…/examples/demo-site/site.json: Demo house (demo-house)
  · main model: demo.glb: 151 top-level nodes, 26 fixtures, 14 rooms, 7 merged keys, 120.0 × 114.0 m
  · model furniture: furniture.glb: 17 top-level nodes, 3 fixtures, 0 rooms, 4 merged keys, 10.4 × 9.0 m
  · blueprints: 2 sheets
  · energy map: 27 meters (1 low confidence)
ok
```

(The 120 × 114 m is the lawn; the house is 12 × 9, 19 × 9.5 with the garage.) A copy with mistakes in the manifest:

```
/tmp/broken-site/site.json
  error site.json: geo.timeZone: is required
  error site.json: geo.timezone: unknown field (did you mean "timeZone"?)
  error site.json: frame.units: must be one of "ft", "m", got "feet"
  error site.json: viewpoints[0].at: expected 3 items, got 2
4 errors
```

Once the schema passes, the rules:

```
/tmp/broken-site/site.json
  error site.json: startView: there are only 8 viewpoints
  error site.json: layers[1].key: X is one of the viewer's own keys (A B C D E G H J L N P Q S T U V W X)
2 errors
```

And a first export of a model straight from a CAD tool, in millimetres, Draco-compressed, with no conventions yet:

```
/tmp/my-house/site.json: My house (my-house)
  · main model: model.gltf: 2 top-level nodes, 0 fixtures, 0 rooms, 0 merged keys, 12000.0 × 9000.0 m
  warning site.json: plugins["home-assistant"].url: no URL: only ?ha=mock will work
  warning main model: 1 top-level node has no name (the inspect panel shows names)
  warning main model: no room floors (top-level nodes named Floor_* with a `room` extra): the room list and "where am I" stay empty
  warning main model: no light fixtures (nodes with a `fixture_id` extra): Home Assistant has nothing to light
  warning main model: layer "door" takes no node: its key (O) will do nothing
  warning main model: the model is 12000 m across: glTF is in metres (was it exported in millimetres or feet?)
  error main model: requires KHR_draco_mesh_compression, which the viewer doesn't load (use meshopt: gltfpack -cc)
1 error
```

validate-site reads only the glTF JSON (nothing is decoded), so it is quick on a large model; it can't see holes in a
floor or a wall in the wrong place. For that, run it.

## 9. Run it

```sh
JARVIS_SITE=sites/mine npm run dev       # http://localhost:5173; JARVIS_SITE is relative to the checkout, or absolute
```

The dev server serves the site folder's files at the app's own URLs (`/site.json`, `/demo.glb`) and warns if the folder
doesn't exist. The viewer opens at `startView` in **ghost** mode (no collision); G walks with collision. A manifest that
doesn't validate is listed, field by field, on the loading screen.

Useful URL parameters:

| Parameter        | Does                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `?ha=mock`       | a made-up Home Assistant: seeded fake states, unmapped fixtures get made-up entities; nothing is sent |
| `&hamock=static` | with `?ha=mock`: states that don't change                                                             |
| `?ha=off`        | no Home Assistant connection                                                                          |
| `?site=<url>`    | the manifest to load instead of `site.json` next to the page (relative to the page, or absolute)      |
| `?view=3`        | open at viewpoint 3                                                                                   |
| `?at=X,Y,Z,yaw`  | open at a plan position (what Navigate's Copy link writes)                                            |
| `?walk`          | start walking with collision instead of in ghost mode                                                 |
| `?overview`      | start in the orbit overview                                                                           |
| `?noextra`       | don't load extra models until their layer's key is pressed                                            |

`?site=` on another origin needs CORS: the server holding the site folder must send `Access-Control-Allow-Origin` with
the viewer's origin for the manifest and **every** file it names (models, parts, maps, blueprint images).

`npm run build` then `JARVIS_SITE=sites/mine npm run preview` (port 4173) serves the built viewer with the site folder,
as deployed.

## 10. Deploy

Static files: the built viewer and the site folder, from one web server at the same base URL. The release container
is nginx set up for it:

```sh
docker run -d -p 8080:80 -v ./my-site:/usr/share/nginx/html/site:ro ghcr.io/edspencer/jarvis:latest
```

Or the release tarball (`jarvis-<version>.tgz`) with any static server, the site folder's files beside the viewer's.
[docs/deploy.md](../deploy.md) has the details: MIME types, caching, updating a model in place, Compose, and the
nginx configuration. A site folder is a floor plan of a building and its devices: keep it on your LAN or behind
authentication ([SECURITY.md](../../SECURITY.md)).

## 11. Troubleshooting

**validate-site errors.**

- `… is required`, `unknown field (did you mean …)`: a missing or misspelt field; field names are case-sensitive
  (`timeZone`, `northAzimuth`, `objectsFrom`, `maxStep`).
- Rule errors (keys, `startView`, storeys) appear only once the schema errors are fixed: run it again.
- `layers[i].key: K is one of the viewer's own keys (…)`: pick a letter not in the list. The list grows with the
  plugins you enable.
- `models.extra[i].layer: no layer "x" in layers`: declare the layer.
- `storeys[i].z: storeys go from the bottom up`: order them, lowest first, each `from` above the one below's.
- `requires KHR_draco_mesh_compression`: re-export without Draco and compress with meshopt.
- `blueprints index: 1 sheet image not found`: a `file` in the index is relative to the index, not the manifest.

**The model is sideways, upside down or mirrored.** It wasn't exported +Y up, or something on the way read a Z-up file
as Y-up (OBJ and FBX importers have axis settings). Mirrored or turned on the plan: plan north isn't along +Y (in
Blender, Y). Rotate the model, not the manifest; `frame.northAzimuth` only turns the sun.

**The model is huge, tiny, or nowhere to be seen.** glTF is metres. 1000× too big: millimetres; 39.37×: inches;
3.28×: feet. validate-site warns past 5 km or under 2 m. If the model is right but you start in empty space, the
viewpoints are in the wrong units: `frame.units` defaults to feet, so metre coordinates without `"units": "m"` land 3.28
times nearer the origin. validate-site warns of a viewpoint more than 30 m outside the model. The model floating or
sunk: its ground floor isn't at Z = 0.

**Walking falls through floors or through walls.** In ghost mode (the default) nothing collides; press G. Then the
walker collides only with the solid top-level nodes of the main model, so a floor or wall falls out of the collider
if:

- it is in an extra model, or in any layer (a broad `match.material` or `namePrefix` that also takes floors);
- its material is a glass or water material, or it matches `colliders.passable`, or it carries `fixture_id`;
- it has holes or gaps (scans, unjoined edges). Faces are tested from both sides, so normals don't matter.

Stuck at the foot of the stair: a step higher than `walk.maxStep` (0.35 m) needs a jump; model treads, or raise it.

**No lights.**

- validate-site's summary says `0 fixtures`: the `fixture_id` extras were lost. Check Blender's Custom Properties
  export tick, that the property is on the top-level node (the fixture's parent, not a child mesh), and gltfpack's
  `-ke`.
- Fixtures but nothing lights: the fixture map's keys must equal the `fixture_id`s exactly, and the entities must be
  `light.*` (or `switch.*` marked `switch_is_light`). Try `?ha=mock` first: it gives every fixture an entity, mapped or
  not (about 60 % on), and T switches it, so a fixture that never responds in the mock isn't a fixture in the model.
- Fine in the mock, dark live: the `home-assistant.url`, the login, and Home Assistant's `http: cors_allowed_origins`
  (it must list the viewer's origin).
- The whole fixture glows instead of its bulb: give the bulb or shade an emissive material, or a name the emitter
  hints match (`plugins.lights.emitterHints`).

**The inspect panel shows `Walls_ground` rather than the wall.** The node is merged; add a parts file, with the node's
`merged` key (§6).

**The loading screen says `got a web page: no site manifest here`.** Nothing serves `site.json` where the viewer looks:
check `JARVIS_SITE` (the dev server logs `site folder … not found`), the container's mount, or the `?site=` URL. A
manifest on another origin that fails with a network error: CORS (§9).
