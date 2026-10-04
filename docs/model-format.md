# Model format (`jarvis-model/1`)

What JARVIS expects of a building's model and its data files, so that a model exported from Blender, SketchUp, Revit,
a photogrammetry or scan pipeline, or anything else that writes glTF, walks, toggles and inspects properly. Read it
with the site manifest (`site.json`, [schema](../schema/site.schema.json), described in the [README](../README.md)):
the manifest says which names mean what, and this document says what the viewer does with them.

Most of it is optional. A single glTF file with walls and floors is a valid model: you can walk it, orbit it, cut it
away and inspect it. Each convention below adds something (room names, light fixtures, toggles, the parts inspector).

`npm run validate-site -- <site folder>` checks a site against this document and the manifest schema.

Versioning: this is `jarvis-model/1`. A later version will say what changed; the viewer reads `jarvis-model/1` models
for as long as it reads `jarvis-site/1` manifests.

## 1. Files

| What                                  | Format                                      | Named in the manifest                                     |
| ------------------------------------- | ------------------------------------------- | --------------------------------------------------------- |
| the main model                        | glTF 2.0, binary (`.glb`) or JSON (`.gltf`) | `models.main.url`                                         |
| extra models (optional)               | the same                                    | `models.extra[].url` (furniture, landscaping, a proposal) |
| parts files (optional)                | JSON, [§7](#7-merged-nodes-and-parts-files) | `models.main.parts`, `models.extra[].parts`               |
| blueprint index and images (optional) | JSON + images, [§9](#9-blueprint-index)     | `plugins.blueprints.index`                                |

The main model loads first; the viewer can walk as soon as it is in. Extra models load in the background afterwards
(or, with `?noextra`, when their layer's key is pressed). Keep the main model as small as you can: put furniture and
other detail that isn't needed to move around into an extra model.

### Compression

The viewer loads, without any further set-up:

- **meshopt** geometry (`EXT_meshopt_compression`, or `KHR_meshopt_compression` from `gltfpack -ce khr`) and quantised
  attributes (`KHR_mesh_quantization`): what `gltfpack -cc` writes. Recommended: much smaller files and quick to
  decode.
- **KTX2 / Basis Universal** textures (`KHR_texture_basisu`), e.g. `gltfpack -tc`; also WebP (`EXT_texture_webp`), PNG
  and JPEG.
- `KHR_texture_transform`, `KHR_materials_emissive_strength`, `KHR_materials_ior`, `KHR_materials_specular`,
  `KHR_materials_unlit`, `KHR_lights_punctual`, `EXT_mesh_gpu_instancing`.

**Draco** (`KHR_draco_mesh_compression`) is not loaded: use meshopt instead. `KHR_materials_transmission` loads but is
turned into plain alpha blending (§6): real transmission makes three.js redraw the whole scene once more every frame.

The decoders ship with the viewer (no CDN), so it works offline.

## 2. Coordinate frame and units

- **The model is in metres, +Y up**, as glTF requires. Exporters usually handle this (Blender's glTF exporter converts
  Z-up to Y-up by default).
- **The plan frame** is how the manifest and every data file give positions: **X east, Y north, Z up**, in the
  manifest's `frame.units` (`ft`, the default, or `m`), with Z = 0 at the finished ground floor. A plan point
  (X, Y, Z) is the glTF point (X, Z, −Y) × the unit (0.3048 for feet). So glTF −Z is plan north.
- **True north**: `frame.northAzimuth` is the compass bearing (degrees clockwise from true north) of plan +Y. Square the
  plan to the building, then measure this; the sun uses it.
- The origin is yours: a corner of the building or a survey point. Keep the building within a few hundred metres of
  it (single-precision floats).

## 3. Top-level nodes

The viewer works with the **top-level nodes** of the default scene (the scene root's children): each is one thing it
can show, hide, collide with and inspect. What a node is comes from its **name**, its **extras** (glTF `extras`, which
Blender writes from custom properties) and its **materials**. Nested nodes are fine (a light fixture's bulb, shade and
canopy as children); the top-level node is what gets classified.

Name your nodes: the inspect panel shows the name when there is no parts entry.

### Name prefixes the viewer uses (defaults; each can be changed in the manifest)

| Prefix                                    | Means                                       | Manifest                        |
| ----------------------------------------- | ------------------------------------------- | ------------------------------- |
| `Roof_`                                   | a roof: hidden by X (cutaway) and U         | `layers[id=roof].match`         |
| `Ceil_`                                   | a ceiling: hidden by X                      | `layers[id=ceiling].match`      |
| `Floor_` (with a `room` extra)            | a room's floor: the room list, "where am I" | `rooms.floorPrefix`             |
| `Win_`, `WinFrame_`, `WinMull_`, `Label_` | walked through (not in the collider)        | `colliders.passable.namePrefix` |

A manifest layer's `match` replaces the default rules for that layer, so restate any default you still want.

### Extras the viewer reads on top-level nodes

| Extra           | Type   | Effect                                                                                                                                                                    |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layer`         | string | puts the node in a layer: `roof`, `ceiling`, `door`, or any layer the manifest declares (`match.layer` lists the values); `plants` and `switches` are special groups (§8) |
| `room`          | string | on a floor node: the room's id (underscores show as spaces: `living_room` → "living room"); on anything else: shown in the inspect panel                                  |
| `door_leaf`     | true   | a door leaf: in the door layer (O; hidden at start: doors are shown open)                                                                                                 |
| `passable`      | true   | walked through                                                                                                                                                            |
| `fixture_id`    | string | a light fixture, one node per fixture (§5); unique in the site                                                                                                            |
| `fixture_kind`  | string | shown in the inspect panel (e.g. `pendant`, `can`, `cove`)                                                                                                                |
| `fixture_group` | string | the switched group the fixture belongs to (lights on one switch); a leading `fixture.` is dropped                                                                         |
| `merged`        | string | the node merges several source objects: the key of its entry in the parts file (§7)                                                                                       |
| anything else   | any    | shown in the inspect panel as it is (e.g. `src`, `kind`, `conf`, `tag`, `product`)                                                                                        |

### Which node is which layer

Each layer in the manifest has `match` rules; a top-level node joins a layer if **any one** rule matches:

```json
{ "namePrefix": ["Roof_"], "layer": ["roof"], "material": ["roof_tile"], "extra": ["is_roof"] }
```

- `namePrefix`: the node's name starts with one of these;
- `layer`: its `layer` extra is one of these;
- `material`: one of its meshes uses a material with one of these names;
- `extra`: it has one of these extras, truthy.

Without `match`, a layer takes the nodes whose `layer` extra is its id. Every node of an extra model joins the layer
the manifest gives that model (`models.extra[].layer`), whatever its extras say. A node can be in several layers; it
is shown only if none of them hides it.

The **upper storeys** are not a layer: U hides every node whose bounding box starts above the second storey's
`objectsFrom` level (manifest `storeys`), and the roofs.

## 4. What is solid (the collider)

Walking uses one collision mesh built from the solid top-level nodes of the main model. **Solid** is everything except:

- every layer (roofs, ceilings, doors, and the site's own): a layer can be hidden, and a hidden wall that still
  blocks you would be confusing; doors are open;
- nodes whose meshes use a glass or water material (§6);
- light fixtures (`fixture_id`), plants and wall plates;
- what `colliders.passable` matches (by default the `Win_`… prefixes and the `passable` extra).

Extra models are never solid. So:

- **Floors, stairs and walls must be real geometry** in the main model. Stairs need treads (or a ramp) to be climbed:
  a step higher than `walk.maxStep` (default 0.35 m) needs a jump. Raise `maxStep` if the model has steps without
  treads.
- Faces are tested from both sides; normals don't matter for walking.
- Thin walls are fine (the walker sub-steps), but **close gaps**: a walker falls through a missing floor and walks
  through a missing wall. Ghost mode (G, on at start) ignores the collider.
- Big decorative meshes that aren't obstacles (a tree canopy, a far-off backdrop) should be passable: put them in a
  layer, mark them `passable`, or put them in an extra model.

## 5. Light fixtures

A light fixture is **one top-level node** with a `fixture_id` extra (its parts as children), e.g. `Fixture_<id>`. The
Home Assistant plugin maps fixture ids to entities (the fixture map) and makes a fixture glow when its light is on:

- the parts that glow are those whose material is **emissive**; failing that, those whose material name matches the
  emitter hints (`plugins.home-assistant.emitterHints`, default: glass, bulb, lens, shade, LED, light, globe, …);
  failing both, the whole fixture;
- a fixture longer than 1.2 m (a cove, a strip) is treated as a line of lights.

Fixtures are not solid and cast no shadows. Fixtures may also live in an extra model (a lamp on a table).

## 6. Materials

Colours and textures come from the glTF materials as they are (PBR metallic-roughness). The viewer changes only:

| Role             | How it is named                                                                   | What the viewer does                                                                   |
| ---------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| glass            | `materials.glass` (default `["glass"]`), or material extra `role: "glass"`        | faint and see-through; clicks go through it; walked through                            |
| water            | `materials.water` (default `["water"]`), or `role: "water"`                       | translucent; walked through                                                            |
| wire screen      | `materials.screens: { "<name>": { "wire": 0.19 } }`, or `role: "screen"` + `wire` | alpha that closes up at grazing angles, as a wire mesh does; faces must point outwards |
| any transmissive | `KHR_materials_transmission`                                                      | becomes plain alpha                                                                    |

Give materials stable, meaningful names: layers and roles can select by material name, and the inspect panel shows it.

## 7. Merged nodes and parts files

A model build often merges many source objects into a few big meshes (by material, by storey, by tile), which is much
faster to draw. The inspect panel can still name the original object under the cursor if the merged node carries a
`merged` extra and the model has a **parts file**:

```json
{
  "about": "free text",
  "parts": {
    "<merged key>": [
      ["<object name>", [minX, minY, minZ, maxX, maxY, maxZ], ["<material>", "…"], { "<extra>": "…" }]
    ]
  }
}
```

- the box is the object's bounding box in **glTF world metres** (Y up);
- the materials are those the object used; the extras are shown in the inspect panel;
- several top-level nodes may share one key (the same bucket split into tiles).

On a hit, the viewer picks the smallest part whose box (grown by 2 cm) contains the hit point, preferring parts that
use the material hit. Without a parts file, merged nodes show their own name and extras.

## 8. Special groups

**Plants.** A top-level group with the extra `layer: "plants"` holds one node per plant (with a `plant_id` extra, and
any other extras for the inspect panel); plants of a kind should share one glTF mesh. The viewer draws each
(mesh, material) pair as one instanced mesh, so a hundred plants of forty kinds cost about forty draw calls. Plants
are passable, cast shadows and are never hidden by a toggle.

**Wall plates.** A top-level group with `layer: "switches"` holds one node per switch or outlet plate, with extras:
`plate_id` (unique), `box_id` (the wiring sheet's id, optional), `room`, `kind` (`switch` | `outlet`), `gangs`,
`devices`, `notes`, `file` (where it is recorded, for the panel's source row), and `positions`:
`[{ pos, role, breaker, fixture_ids: [<fixture_id>…], ha_entity, link: { box, pos, dir } }]`. A child node per device
(paddle, rocker, receptacle); identical parts should share a mesh. A plate node's local +Z axis (glTF) points out of the
wall. Box ids written in notes and roles become links: by default any `box_id` the plates carry, or the site's
`plugins.switches.boxIdPattern`.

## 9. Blueprint index

A JSON file listing scanned drawings placed in the plan frame (made by fitting each scan to the model):

```json
{
  "sheets": [
    {
      "id": "A-1",
      "title": "A-1 ground floor plan",
      "kind": "plan",
      "file": "A-1.webp",
      "z_floor": 0,
      "corners": { "tl": [x, y, z], "tr": [x, y, z], "bl": [x, y, z], "br": [x, y, z] },
      "rms": 0.3
    },
    { "id": "A-6", "title": "Front elevation", "kind": "elevation", "face": "south", "file": "A-6.webp", "corners": { … } }
  ]
}
```

- `corners`: where the image's corners lie, plan frame and units. A plan lies at its corners' height (a ceiling or
  roof plan at its ceiling); `z_floor` is the floor of its storey (for "hide above" and "on floor"). An elevation
  stands where its corners put it, just outside the `face` it shows (north, south, east or west).
- `rms`: the fit's error, shown in the list (optional).
- `file`: relative to the index. Line art on a transparent background reads best (dark ink, clear paper).
- `corners_ft`, `z_floor_ft` and `rms_ft` are accepted as older names for the same fields (in plan units).

## 10. Exporting

**Blender.** Custom properties on objects are exported as extras (glTF exporter: Include → Custom Properties). Apply
transforms you don't need; keep the scene's top level flat (one object or one empty per thing). Then
`gltfpack -i in.glb -o out.glb -cc -tc -kn -ke -km` for meshopt geometry and KTX2 textures: `-kn` keeps named nodes
and `-ke` extras (without them gltfpack may merge nodes and drops the extras), `-km` keeps named materials (without it
gltfpack merges materials with the same values, whatever their names, which breaks the roles of §6). `-tc` needs a
native gltfpack build: the npm package has no BasisU. With `gltf-transform`, use `meshopt` (and `etc1s` or `uastc`)
rather than `optimize`, which flattens, joins and renames nodes by default.

**SketchUp, Revit, CAD.** Export glTF (natively or via a plug-in), or go through Blender. Name groups and components as
in §3 or write `match` rules in the manifest for the names you have.

**Scans and photogrammetry.** A single mesh works (you can walk on it if it is closed enough); split out floors and
walls if you can, mark furniture and vegetation passable or move them to an extra model, and decimate before export.

Then check: `npm run validate-site -- <site folder>`.
