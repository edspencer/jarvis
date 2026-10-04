// docs/guide/your-own-building.md quotes the demo's generator, assembles a manifest snippet by snippet and shows what
// validate-site prints. This test checks the excerpts are the files' own lines, that the snippets together are a valid
// manifest, and runs the real `validate-site` command on the demo and on the guide's broken sites, comparing its
// output with the guide's, so the guide can't rot.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { validateManifest } from '../../src/site';
import { checkSite } from '../../src/site/check-site';
import { buildGlb } from './glb';

const ROOT = new URL('../../', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, ROOT), 'utf8');
const page = read('docs/guide/your-own-building.md');

/** the text of one `## n.` section */
function section(n: number): string {
  const at = page.indexOf(`\n## ${n}. `);
  expect(at, `section ${n}`).toBeGreaterThan(0);
  const end = page.indexOf('\n## ', at + 1);
  return page.slice(at, end < 0 ? undefined : end);
}
/** the fenced blocks of a language ('' for none) in some text, unindented (some sit in list items) */
function blocks(text: string, lang: string): string[] {
  const out: string[] = [];
  let open: { lang: string; indent: number; lines: string[] } | null = null;
  for (const line of text.split('\n')) {
    const fence = /^(\s*)```(\w*)\s*$/.exec(line);
    if (open && fence) {
      if (open.lang === lang) out.push(open.lines.join('\n'));
      open = null;
    } else if (fence) open = { lang: fence[2], indent: fence[1].length, lines: [] };
    else if (open) open.lines.push(line.slice(open.indent));
  }
  return out;
}

const trimLines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();

describe('§6: the excerpts of the demo generator', () => {
  // an excerpt may gather lines from several places (the naming conventions), so each line is checked, not the block
  it("each ts line is one of the generator's (tools/make-demo-site.ts and its helpers), indentation aside", () => {
    const lines = new Set(
      ['tools/make-demo-site.ts', 'tools/demo-site/geometry.ts'].flatMap((f) => trimLines(read(f)).split('\n')),
    );
    const ts = blocks(section(6), 'ts');
    expect(ts.length).toBeGreaterThan(4);
    for (const l of ts.flatMap((b) => trimLines(b).split('\n'))) expect(lines.has(l), l).toBe(true);
  });

  it("the parts-file line is the demo's first ground-floor wall", () => {
    const [b] = blocks(section(6), 'json');
    const [key, value] = Object.entries(JSON.parse(`{${b.trim().replace(/,$/, '')}]}`))[0] as [string, unknown[]];
    const parts = JSON.parse(read('examples/demo-site/demo.parts.json')).parts;
    expect(parts[key][0]).toEqual(value[0]);
  });
});

describe('§3 and §7: the manifest snippets', () => {
  /** §7's json blocks, in order, are one manifest */
  const assembled = () => JSON.parse(blocks(section(7), 'json').join('\n'));

  it('together are a valid manifest, with no warnings', () => {
    const m = assembled();
    expect(Object.keys(m)).toEqual(expect.arrayContaining(['jarvis', 'id', 'geo', 'models', 'viewpoints', 'plugins']));
    const v = validateManifest(m);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it("agree with the demo's own manifest where they overlap", () => {
    const m = assembled();
    const demo = JSON.parse(read('examples/demo-site/site.json'));
    for (const k of ['jarvis', 'id', 'name', 'description', 'geo', 'frame', 'centre', 'overview', 'models', 'storeys'])
      expect(m[k], k).toEqual(demo[k]);
    expect(m.ground.z).toBeCloseTo(demo.ground.z, 6);
    // the guide shows some of the viewpoints, and every plugin section the demo has
    for (const v of m.viewpoints) expect(demo.viewpoints).toContainEqual(v);
    expect(Object.keys(m.plugins).sort()).toEqual(Object.keys(demo.plugins).sort());
  });

  it('the whole guide manifest, put in the demo folder, checks clean against its files', async () => {
    const at = new URL('examples/demo-site/site.json', ROOT).href;
    const r = await checkSite(at, async (url) => {
      if (url === at) return new TextEncoder().encode(JSON.stringify(assembled()));
      try {
        return new Uint8Array(readFileSync(fileURLToPath(url)));
      } catch {
        return null;
      }
    });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("§3's materials line is valid in a manifest", () => {
    const [b] = blocks(section(3), 'json');
    const v = validateManifest({ ...assembled(), ...JSON.parse(`{${b}}`) });
    expect(v.errors).toEqual([]);
  });
});

describe('§8: validate-site prints what the guide shows', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  /** a scratch site folder with these files */
  function site(files: Record<string, string | Uint8Array>): string {
    const d = mkdtempSync(join(tmpdir(), 'jarvis-guide-'));
    dirs.push(d);
    for (const [name, data] of Object.entries(files)) writeFileSync(join(d, name), data);
    return d;
  }
  /** runs `npm run validate-site -- <dir>` (the command itself, not the library), with the folder as the guide writes it */
  function validate(dir: string, as: string) {
    const r = spawnSync(process.execPath, ['tools/validate-site.ts', dir], {
      cwd: fileURLToPath(ROOT),
      encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout.trimEnd().split(dir).join(as) };
  }
  const shown = () => blocks(section(8), '');
  const demo = () => JSON.parse(read('examples/demo-site/site.json'));

  it('the demo', () => {
    const r = validate(fileURLToPath(new URL('examples/demo-site', ROOT)), '/…/examples/demo-site');
    expect(r.status).toBe(0);
    expect(r.out).toBe(shown()[0]);
  });

  it('a copy with mistakes in the manifest', () => {
    const m = demo();
    m.geo.timezone = m.geo.timeZone;
    delete m.geo.timeZone;
    m.frame.units = 'feet';
    m.viewpoints[0].at = m.viewpoints[0].at.slice(0, 2);
    const r = validate(site({ 'site.json': JSON.stringify(m) }), '/tmp/broken-site');
    expect(r.status).toBe(1);
    expect(r.out).toBe(shown()[1]);
  });

  it('once the schema passes, the rules', () => {
    const m = demo();
    m.startView = 8;
    m.layers[1].key = 'X';
    const r = validate(site({ 'site.json': JSON.stringify(m) }), '/tmp/broken-site');
    expect(r.status).toBe(1);
    expect(r.out).toBe(shown()[2]);
  });

  it('a first CAD export: millimetres, Draco, no conventions', () => {
    const m = {
      jarvis: 'jarvis-site/1',
      id: 'my-house',
      name: 'My house',
      geo: { lat: 51.5, lon: 0, timeZone: 'Europe/London' },
      frame: { units: 'm' },
      models: { main: { url: 'model.gltf' } },
      viewpoints: [{ name: 'Front', at: [0, 0, 0], yaw: 0 }],
      plugins: { 'home-assistant': {} },
    };
    const glb = buildGlb(
      [
        {
          name: 'House',
          box: [
            [0, 0, -9000],
            [12000, 3000, 0],
          ],
        },
        {
          box: [
            [0, 0, -1],
            [1, 1, 0],
          ],
        },
      ],
      { required: ['KHR_draco_mesh_compression'] },
    );
    const r = validate(site({ 'site.json': JSON.stringify(m), 'model.gltf': glb }), '/tmp/my-house');
    expect(r.status).toBe(1);
    expect(r.out).toBe(shown()[3]);
  });
});
