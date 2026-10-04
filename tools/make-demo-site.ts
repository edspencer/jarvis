// npm run demo-site: generates examples/demo-site, a small synthetic four-bedroom house that exercises most of the viewer
// (docs/model-format.md): rooms with Floor_* nodes, walls with door and window openings, a stair, ceilings, a hip roof,
// glazing, light fixtures, wall plates, plants, a pond, a pergola the K key toggles, a furniture model, parts files,
// blueprint sheets and the plugins' data files (a mock Home Assistant map and controls, registry pins, a device map,
// an energy map).
// Deterministic: running it again writes the same bytes (CI checks that the committed copy is up to date).
//
// Plan frame: X east, Y north, Z up, metres (the manifest's frame.units is "m"); the origin is the house's south-west
// corner at finished ground-floor level. The two-storey block is 12 × 9 m; the single-storey garage wing adds 6.75 m
// on the east.
//
// The pieces live in tools/demo-site/: dims.ts (the dimensions), model.ts (materials, the glTF Model, merged nodes),
// layout.ts (rooms, walls and openings), panel.ts (the panel schedule), fixtures.ts (fixture shapes), area.ts and
// areas/ (what is in each part of the house: fixtures, wall plates, registry pins, devices, built-ins, furniture;
// areas/index.ts collects them), main-model.ts (demo.glb, built part by part), furniture.ts (furniture.glb), pins.ts
// (registry pins), ha.ts (the Home Assistant files), energy.ts, blueprints.ts and manifest.ts (site.json). This file
// writes them all out. docs/demo-house.md is the plan.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { buildMain, plaqueKtx2 } from './demo-site/main-model.ts';
import { buildFurniture } from './demo-site/furniture.ts';
import { registryPins } from './demo-site/pins.ts';
import { haControls, haDevices, haMap } from './demo-site/ha.ts';
import { energyFeeds, energyMap } from './demo-site/energy.ts';
import { FIXTURES, PINS, PLATES } from './demo-site/areas/index.ts';
import { ROOMS } from './demo-site/layout.ts';
import type { Model } from './demo-site/model.ts';
import { blueprint, blueprintIndex } from './demo-site/blueprints.ts';
import { manifest } from './demo-site/manifest.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'examples/demo-site');

/** every energy-map feed names something that exists: a room, fixture, wall plate, registry pin or top-level node */
function checkFeeds(models: Model[]): void {
  const names = new Set(models.flatMap((m) => m.scene.listChildren().map((n) => n.getName())));
  const known: Record<string, Set<string>> = {
    room: new Set(ROOMS.map((r) => r.id)),
    fixture: new Set(FIXTURES.map((f) => f.id)),
    plate: new Set(PLATES.map((p) => p.id)),
    registry: new Set(PINS.map((p) => p.id)),
    node: names,
  };
  for (const f of energyFeeds())
    for (const [k, v] of Object.entries(f))
      if (known[k] && !known[k].has(v as string)) throw new Error(`energy map: a feed names no ${k} ${v}`);
}

// ------------------------------------------------------------------ write it all
const json = (o: unknown) => JSON.stringify(o, null, 2) + '\n';
async function main(): Promise<void> {
  await mkdir(join(OUT, 'blueprints'), { recursive: true });
  const main = buildMain(await plaqueKtx2()),
    furn = buildFurniture();
  checkFeeds([main, furn]);
  const sizes: Record<string, number> = {};
  sizes['demo.glb'] = await main.write(join(OUT, 'demo.glb'));
  sizes['furniture.glb'] = await furn.write(join(OUT, 'furniture.glb'));
  const files: Record<string, string | Uint8Array> = {
    'site.json': json(manifest()),
    'demo.parts.json': json({
      about: 'tools/make-demo-site.ts: the objects merged into the main model',
      parts: main.parts,
    }),
    'furniture.parts.json': json({ about: 'tools/make-demo-site.ts: the furniture', parts: furn.parts }),
    'ha_map.json': json(haMap()),
    'ha_controls.json': json(haControls()),
    'ha_devices.json': json(haDevices()),
    'registry_pins.json': json(registryPins()),
    'energy.json': json(energyMap()),
    'blueprints/index.json': json(blueprintIndex()),
    'blueprints/A-1.png': blueprint(0),
    'blueprints/A-2.png': blueprint(1),
  };
  for (const [name, raw] of Object.entries(files)) {
    const file = join(OUT, name);
    // JSON as Prettier writes it, so the committed files pass format:check
    const data =
      typeof raw === 'string'
        ? await prettier.format(raw, { ...(await prettier.resolveConfig(file)), filepath: file })
        : raw;
    await writeFile(file, data);
    sizes[name] = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
  }
  const total = Object.values(sizes).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(sizes)) console.log(`${k.padEnd(24)} ${(v / 1024).toFixed(1).padStart(7)} KB`);
  console.log(`${'total'.padEnd(24)} ${(total / 1024).toFixed(1).padStart(7)} KB  -> ${OUT}`);
}
await main();
