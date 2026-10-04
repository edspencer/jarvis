# The Energy plugin

Where the power goes. The energy plugin reads power and energy readings from the store, arranges them in the site's
hierarchy of meters (the feed, the panels, the circuits, the plugs on them) and shows them on the model: a panel with
the house's load and the biggest consumers, an energy mode that tints rooms and objects by their load, and an Energy
section on everything a meter feeds. It is a feature plugin like any other ([`plugins.md`](../plugins.md)); the code
is in [`src/plugins/energy/`](../../src/plugins/energy/) and the map's schema is
[`schema/energy.schema.json`](../../schema/energy.schema.json). The demo house has a complete map
([`examples/demo-site/energy.json`](../../examples/demo-site/energy.json)).

## What it shows

**The Energy panel** (the rail's ⚡ button, or Shift-J). At the top, the house's load as a big number with a 24-hour
sparkline; below it, each source (solar) and storage (a battery: charging or discharging) on its own line. If any
meter has an `energy.today` entity, a _Now / Today_ switch changes the lists from watts now to kilowatt-hours since
midnight. Then two lists: **Panels** (the feeds and panels: meters with children and no breaker) and **Top consumers**
(the eight biggest, from the consumers below). Each row has its share of the house's load as a bar, where it is
("Panel A · breaker 17+19 · 240 V"), and flies to what it feeds when clicked. Without data and without a live
connector, the panel says so instead.

**Energy mode** (the status strip's _Energy_ chip, or **J**). The house is ghosted; the floors of metered rooms, and
the metered model nodes and light fixtures, are tinted by their load; a disc at every metered registry item, wall plate,
fixture and node grows with the load and is drawn over everything, and clicking one opens what it marks. A legend
explains the scale ([below](#the-colour-scale)). The key is J rather than the E the design proposed: Q and E are the
core's turn keys, and Shift-E belongs to the core's movement too, so J (and Shift-J for the panel) was the nearest free
letter.

**The inspector's Energy section** appears on a meter's own subject (`energy:<meter id>`) and on anything a meter
feeds: a registry item, a wall plate, a light fixture, a room, a model node (or a part or child of it). For one meter
it shows the live power with a 24-hour sparkline, the legs of a multi-leg circuit, the panel, breaker and voltage,
today's and this month's energy, its share of its parent, how sure the mapping is and where it comes from, any open
question, and links up to its parent, down to its children (and its _Other_), and out to the objects it feeds. When
several meters feed the subject (a room on two circuits), it shows their sum and a row for each.

**Elsewhere.** A status item shows the house's load and opens the panel. Hovering a metered object adds its load to
the hover label ("· 1,210 W", or "no data"). Global search (`/`) finds meters by label, id, panel, breaker number
("breaker 17") or entity id.

**URL parameters.** `?energy` starts in energy mode. With `?ha=mock` the plugin makes up plausible loads for every
meter in the map (a fridge cycles, a dryer runs in the evening, the solar follows the sun; `&hamock=<seed>` varies
them and `&hamock=static` holds them still), and the history behind the sparklines matches. `?energymock=off` turns
that off and leaves the entities to whoever sets them, such as a test with `twin.ha.mock.load([...])`. The console
hook is `twin.energy` (the tree, the readings, the totals, `setOn`).

## Where the numbers come from

The plugin is vendor-neutral: it reads ordinary store entities and never asks which connector supplied them. Home
Assistant is one connector (with circuit monitors, smart plugs, an inverter and a battery behind it); an MQTT feed or
a CSV replay would do as well. A **power** entity's state is read in W or kW, an **energy** entity's in kWh or Wh, the
unit taken from its `unit_of_measurement` (W and kWh when there is none). A state that is `unavailable`, `unknown`,
empty or not a number, or whose unit is neither, is no data.

The 24-hour sparklines come from `store.history`: the connector's recorder if it has one (Home Assistant's history),
else what the page has seen. A sensor's history is a step function, so each of the 96 quarter-hour points is the
time-weighted mean of what held during it; a short spike still shows, scaled by how long it lasted. A meter's history
is fetched when something shows it and kept for five minutes. A meter with no `energy.today` entity gets today's
kilowatt-hours by integrating its power history from local midnight, marked "from power" in the inspector; only if
that history reaches back to midnight (a recorder's does; what a page opened at noon has seen doesn't), else it shows
no figure rather than part of the day's.

## The manifest

The plugin starts when the manifest has its section, which names the map, relative to the manifest:

```jsonc
// site.json
"plugins": { "energy": { "map": "energy.json" } }
```

## The map: `jarvis-energy/1`

A JSON file with three fields:

| Field     | What                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `jarvis`  | `"jarvis-energy/1"`, the format                                                                                                                 |
| `scale`   | optional: `idle` (W at or below which a load is idle, default 5) and `max` (W that gets the full red, default 5000); `idle` must be below `max` |
| `meters`  | the top-level meters (at least one), each with its `children` below it                                                                          |
| `$schema` | optional, an editor hint (ignored)                                                                                                              |

A **meter**:

| Field       | What                                                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | required, unique in the file (letters, digits, `_ . : -`); `energy:<id>` is its subject                                                                  |
| `label`     | its name (default: the id)                                                                                                                               |
| `kind`      | `load` (summed into the house's load), `source` (solar) or `storage` (a battery: positive is charging); default: its parent's kind, or `load` at the top |
| `power`     | an entity id, or several that are summed (the two legs of a 240 V circuit). Without it, the meter's power is its children's sum                          |
| `legs`      | a label per power entity (`["L1", "L2"]`), shown in the inspector; there must be as many as there are power entities                                     |
| `energy`    | `today` (since midnight) and `month` (this month): an entity id or several summed, kWh or Wh                                                             |
| `remainder` | an entity that reports the meter's unmetered remainder (a circuit monitor's _Balance_): used for its _Other_ instead of the computed one                 |
| `panel`     | the panel it is on, as people say it ("Panel A"); shown with the breaker                                                                                 |
| `breaker`   | breaker position(s): `12`, `[17, 19]` or `"17+19"`. A meter with a breaker is a circuit, not a panel                                                     |
| `volts`     | 120, 240…                                                                                                                                                |
| `feeds`     | what it feeds in the model (below)                                                                                                                       |
| `conf`      | how sure the mapping is: `high`, `medium` or `low` (shown as a pill)                                                                                     |
| `src`       | where the mapping comes from                                                                                                                             |
| `question`  | an open question about the meter, shown with it                                                                                                          |
| `note`      | free text, shown in the inspector                                                                                                                        |
| `children`  | the meters downstream of this one                                                                                                                        |

Entity ids are `domain.object_id` (`sensor.kitchen_power`).

A **feed** names exactly one of `registry` (a registry item's id, as the pins plugin knows it), `plate` (a wall
plate's box id), `fixture` (a light fixture's id), `node` (a node's name in the main or an extra model) or `room` (a
room id), with an optional `conf` and `src` of its own. The first feed the viewer can resolve is where the meter's rows
and links fly to.

### An example

A house with solar and a battery, a whole-house feed, a panel whose monitor clamps both mains legs and reports its own
balance, a 240 V dryer circuit, a kitchen circuit with a smart plug on it, and a lighting circuit nobody is sure of:

```json
{
  "jarvis": "jarvis-energy/1",
  "scale": { "idle": 5, "max": 5000 },
  "meters": [
    {
      "id": "pv",
      "label": "Solar",
      "kind": "source",
      "power": "sensor.solar_power",
      "energy": { "today": "sensor.solar_energy_today" },
      "feeds": [{ "registry": "elec.inverter" }]
    },
    {
      "id": "battery",
      "label": "Battery",
      "kind": "storage",
      "power": "sensor.battery_power",
      "feeds": [{ "registry": "elec.battery" }]
    },
    {
      "id": "grid",
      "label": "Grid",
      "power": "sensor.grid_power",
      "children": [
        {
          "id": "panel.a",
          "label": "Panel A",
          "power": ["sensor.panel_a_l1_power", "sensor.panel_a_l2_power"],
          "legs": ["L1", "L2"],
          "volts": 240,
          "remainder": "sensor.panel_a_balance_power",
          "energy": { "today": "sensor.panel_a_energy_today", "month": "sensor.panel_a_energy_month" },
          "feeds": [{ "registry": "elec.panel.a" }],
          "conf": "high",
          "src": "monitor's mains clamps",
          "children": [
            {
              "id": "circuit.a.17",
              "label": "Dryer",
              "power": ["sensor.dryer_l1_power", "sensor.dryer_l2_power"],
              "legs": ["L1", "L2"],
              "panel": "Panel A",
              "breaker": [17, 19],
              "volts": 240,
              "energy": { "today": "sensor.dryer_energy_today", "month": "sensor.dryer_energy_month" },
              "feeds": [{ "node": "Furn_dryer" }, { "room": "laundry" }],
              "conf": "high",
              "src": "panel schedule"
            },
            {
              "id": "circuit.a.12",
              "label": "Kitchen counter outlets",
              "power": "sensor.circuit_12_power",
              "panel": "Panel A",
              "breaker": 12,
              "feeds": [{ "plate": "KIT-O-H" }, { "room": "kitchen" }],
              "conf": "medium",
              "src": "breaker trip test",
              "question": "Does it also feed the island outlets?",
              "children": [
                {
                  "id": "plug.coffee",
                  "label": "Coffee machine",
                  "power": "sensor.coffee_plug_power",
                  "feeds": [{ "registry": "appl.coffee" }, { "room": "kitchen" }],
                  "conf": "high"
                }
              ]
            },
            {
              "id": "circuit.a.5",
              "label": "Hall lights",
              "power": "sensor.circuit_5_power",
              "panel": "Panel A",
              "breaker": 5,
              "feeds": [{ "fixture": "hall.pendant" }],
              "conf": "low",
              "src": "a guess from the panel label"
            }
          ]
        }
      ]
    }
  ]
}
```

Here the house's load is the grid meter's. The consumers are the dryer, the coffee machine, the hall lights and three
_Others_: the grid's (its power less Panel A's), Panel A's (its balance sensor) and the kitchen circuit's (its power
less the plug's). They add up to the grid's power. The kitchen is fed by both the kitchen circuit and the plug on it,
so it gets the circuit's power once, not the circuit's plus the plug's.

The top meter should measure what the house uses. A net grid meter, which falls as the solar exports, would make the
house's load read low (the plugin doesn't add the solar back); give the feed a consumption sensor instead, or leave
out its `power` so that it is the sum of its children.

## The maths

**A meter's power** is the sum of its power entities. If any of them has no data, the meter has none: an unavailable
leg makes a 240 V circuit unknown rather than half its load. A meter without power entities is the sum of its children
of the same kind, and is marked partial (a note in the inspector) when some of them have no data.

**Other.** A meter with children and its own power (or a `remainder` entity) gets an _Other_ child: its unmetered
remainder. A reported remainder is used when it has data; otherwise it is the meter's power less its children's, and
is no data if any of them is missing or partial. A remainder slightly below zero is the meters disagreeing, not a
negative load, so it is clamped at 0.

**The house's load** is the sum of the top-level load meters. When some of them have no data it is partial: the panel
says "some meters have no data" and its header adds a "+".

**Consumers** are the load meters without children: the leaves, and every _Other_. A parent is never listed with its
children, so the consumers add up to the house's load without counting anything twice. Top consumers is the eight
biggest of them.

**Several meters on one thing.** When several meters feed the same object or room, a meter counts only if none of its
ancestors also feeds it (a circuit and the plug on it both feed the kitchen: the kitchen gets the circuit's power).
The inspector lists the others as "counted in its parent".

**Sources and storage** are signed (storage positive while charging), never summed into the load, and shown on their
own lines in the panel. A source or storage meter under a load is not summed into it either (the validator warns).

## The colour scale

Loads span four orders of magnitude, from a 3 W charger to a 5 kW dryer, so the scale is logarithmic. Grey is no data;
blue is idle, at or below `scale.idle` (5 W unless the map says otherwise); above it, pale amber through amber and
orange to red at `scale.max` (5000 W) and beyond. The legend shows no data, idle and four steps in between, rounded to
1, 2 or 5 times a power of ten. Markers grow with the load on the same scale.

## Bindings and subjects

Each meter's entities (power, energy, remainder) are bound with `store.bind` to its own reference, `energy:<id>`, and
to every reference it feeds (`pins:<id>`, `plates:<box>`, `fixture:<id>`, `room:<id>`; a node has no store
reference), with the meter's `conf` and `src`. So the Home Assistant section, or any connector's, shows the sensors on
the panel, plate, fixture or room they measure. A meter's subject is `energy:<meter id>` (an _Other_ is
`energy:<parent id>.other`); its rows and links fly to the first thing it feeds that the viewer knows, else to its own
subject.

## Validation

`npm run validate-site -- <site folder>` checks the map named in the manifest against the schema, then the rules a
schema can't say. Errors: an id used twice; a feed that names no target or more than one; `legs` that don't match the
number of power entities; a meter with neither power nor children; `scale.idle` not below `scale.max`. Warnings: an
entity used as power by two meters (it would be counted twice); a `remainder` on a meter without children (there is no
_Other_ to show); a source or storage meter under a load. It also reports how many meters there are and how many are
low confidence. The viewer runs the same check when it loads the map: errors stop the plugin (a toast says why), and
warnings go to the console.

## When data is missing

A sensor that is unavailable shows as "No data" in the inspector (naming the entities) and grey in the scene; a parent
summed from children that are partly missing says so rather than showing a smaller number as if it were whole. History
that can't be fetched leaves the sparkline out. Updates are coalesced: however fast the readings arrive, the plugin
recomputes at most once a second, and the HUD re-renders only what changed.

## Not done yet

- No sparkline per row in the lists: the `list` block has bars but no sparklines.
- Sources and storage aren't drawn in the scene unless they feed something; _Others_ are never drawn.
- A meter without its own power entities (a panel summed from its circuits) has no today's figure unless it has an
  `energy.today` entity: today's kilowatt-hours are integrated only from a meter's own power history, and only when
  that history reaches back to midnight.
- No net metering (grid import and export) and no costs or tariffs.
