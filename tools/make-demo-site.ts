// npm run demo-site: generates examples/demo-site, a small synthetic two-storey house that exercises most of the viewer
// (docs/model-format.md): rooms with Floor_* nodes, walls with door and window openings, a stair, ceilings, a hip roof,
// glazing, light fixtures, wall plates, plants, a pond, a pergola the K key toggles, a furniture model, parts files,
// blueprint sheets and the plugins' data files (a mock Home Assistant map and controls, registry pins, a device map,
// an energy map).
// Deterministic: running it again writes the same bytes (CI checks that the committed copy is up to date).
//
// Plan frame: X east, Y north, Z up, metres (the manifest's frame.units is "m"); the origin is the house's south-west
// corner at finished ground-floor level. The footprint is 12 × 9 m.
//
// The pieces live in tools/demo-site/: dims.ts (the dimensions), model.ts (materials, the glTF Model, merged nodes),
// layout.ts (rooms, walls and openings), fixtures.ts, plates.ts (wall plates), main-model.ts (demo.glb, built part by
// part), furniture.ts (furniture.glb), pins.ts (registry pins), ha.ts (the Home Assistant files), energy.ts,
// blueprints.ts and manifest.ts (site.json). This file writes them all out.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { buildMain, plaqueKtx2 } from './demo-site/main-model.ts';
import { buildFurniture } from './demo-site/furniture.ts';
import { registryPins } from './demo-site/pins.ts';
import { haControls, haDevices, haMap } from './demo-site/ha.ts';
import { energyMap } from './demo-site/energy.ts';
import { blueprint, blueprintIndex } from './demo-site/blueprints.ts';
import { manifest } from './demo-site/manifest.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'examples/demo-site');

// ------------------------------------------------------------------ write it all
const json = (o: unknown) => JSON.stringify(o, null, 2) + '\n';
async function main(): Promise<void> {
  await mkdir(join(OUT, 'blueprints'), { recursive: true });
  const main = buildMain(await plaqueKtx2()),
    furn = buildFurniture();
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
