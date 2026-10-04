import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import schema from '../../schema/site.schema.json' with { type: 'json' };
import {
  loadSite,
  manifestUrl,
  matches,
  resolveSite,
  SiteError,
  storeyAt,
  storeyOfObject,
  reservedKeys,
  upperFromY,
  validateManifest,
  type SiteManifest,
} from '../../src/site';
import { checkSite } from '../../src/site/check-site';
import { checkModel, readGltfJson } from '../../src/site/model-check';
import { buildGlb, cottage } from './glb';

const FIXTURE = new URL('../fixtures/site/site.json', import.meta.url);
const cottageJson = (): SiteManifest => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const BASE = 'https://example.org/sites/cottage/site.json';

/** every field the schema knows, filled in (and typed: the compiler checks it against the TS types) */
const FULL: SiteManifest = {
  $schema: '../../schema/site.schema.json',
  jarvis: 'jarvis-site/1',
  id: 'full',
  name: 'Every field',
  description: 'All of them.',
  geo: { lat: 10, lon: 20, timeZone: 'UTC' },
  frame: { units: 'ft', northAzimuth: 12.5 },
  centre: [1, 2],
  overview: { camera: [1, 2, 3] },
  ground: { z: -1, colour: '#336633' },
  sun: { shadowRadius: 100 },
  models: {
    main: { url: 'a.glb', parts: 'a.parts.json' },
    extra: [{ id: 'furn', url: 'f.glb', parts: 'f.parts.json', layer: 'furn' }],
  },
  storeys: [
    { name: 'ground', z: 0 },
    { name: 'first', short: 'up', z: 10, from: 5, objectsFrom: 8 },
  ],
  viewpoints: [{ name: 'Here', at: [0, 0, 0], yaw: 0 }],
  startView: 1,
  layers: [
    { id: 'furn', label: 'Furniture', key: 'F', help: 'the furniture', hidden: false, match: { layer: ['furn'] } },
    { id: 'door', match: { namePrefix: ['Door_'], layer: ['door'], material: ['door'], extra: ['door_leaf'] } },
  ],
  materials: { glass: ['glass'], water: ['water'], screens: { mesh: { wire: 0.2 } } },
  colliders: { passable: { namePrefix: ['Win_'], layer: ['glazing'], material: ['net'], extra: ['passable'] } },
  rooms: { floorPrefix: 'Floor_' },
  walk: { eyeHeight: 1.6, crouchEyeHeight: 0.9, radius: 0.3, maxStep: 0.4 },
  plugins: {
    'home-assistant': { url: 'https://ha.example.org', controls: 'c.json' },
    lights: { map: 'm.json', emitterHints: 'bulb' },
    faults: { devices: 'd.json', source: 'devices.yaml' },
    pins: {
      registry: 'r.json',
      sourceLink: 'https://example.org/{file}',
      stripPrefix: 'x/',
      categories: { elec: { letter: 'E', colour: '#ffcc00', name: 'Electrical' } },
    },
    switches: { boxIdPattern: '\\b([A-Z]+-\\d+)\\b', source: 'plates/{file}.yaml' },
    blueprints: { index: 'bp/index.json', default: 'A-1' },
  },
};

describe('the schema and the types agree', () => {
  /** every property path the schema declares (through $refs, into arrays) */
  function schemaPaths(node: Record<string, unknown>, path: string, out: Set<string>): Set<string> {
    const defs = (schema as { $defs: Record<string, Record<string, unknown>> }).$defs;
    const s = node.$ref ? defs[(node.$ref as string).split('/').pop()!] : node;
    const props = s.properties as Record<string, Record<string, unknown>> | undefined;
    if (props)
      for (const [k, v] of Object.entries(props)) {
        if (String(v.description || '').startsWith('Deprecated')) continue; // an old field still read (tested below)
        out.add(`${path}${k}`);
        schemaPaths(v, `${path}${k}.`, out);
      }
    if (s.items) schemaPaths(s.items as Record<string, unknown>, path, out);
    return out;
  }
  /** every property path a value uses (records with free keys excluded) */
  function valuePaths(v: unknown, path: string, out: Set<string>, free: string[]): Set<string> {
    if (Array.isArray(v)) for (const x of v) valuePaths(x, path, out, free);
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (free.includes(path.slice(0, -1))) {
          valuePaths(x, path, out, free);
          continue;
        }
        out.add(`${path}${k}`);
        valuePaths(x, `${path}${k}.`, out, free);
      }
    return out;
  }

  it('a manifest with every field validates', () => {
    expect(validateManifest(FULL)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('the full example uses every field the schema declares, and no other', () => {
    const declared = schemaPaths(schema as Record<string, unknown>, '', new Set());
    const used = valuePaths(FULL, '', new Set(), ['materials.screens', 'plugins.pins.categories']);
    expect([...declared].filter((p) => !used.has(p))).toEqual([]);
    expect([...used].filter((p) => !declared.has(p))).toEqual([]);
  });

  it('reads the old home-assistant.map / emitterHints as a lights section, with a warning', () => {
    const old = {
      ...FULL,
      plugins: { 'home-assistant': { url: 'https://ha.example.org', map: 'm.json', emitterHints: 'bulb' } },
    };
    const v = validateManifest(old);
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.path)).toEqual([
      'plugins["home-assistant"].map',
      'plugins["home-assistant"].emitterHints',
    ]);
    const site = resolveSite(old as SiteManifest, 'https://example.org/s/site.json');
    expect(site.plugins.lights).toEqual({ map: 'https://example.org/s/m.json', emitterHints: 'bulb' });
    expect(reservedKeys(old).has('T')).toBe(true); // the lights plugin will start, so its key is taken
  });

  it('the test site validates', () => {
    expect(validateManifest(cottageJson()).ok).toBe(true);
  });
});

describe('validateManifest: clear messages', () => {
  const bad = (patch: (m: SiteManifest) => void) => {
    const m = cottageJson();
    patch(m);
    return validateManifest(m);
  };
  const msgs = (patch: (m: SiteManifest) => void) => bad(patch).errors.map((e) => `${e.path}: ${e.message}`);

  it('names a missing required field', () => {
    expect(msgs((m) => delete (m as Partial<SiteManifest>).geo)).toEqual(['geo: is required']);
  });
  it('points into arrays', () => {
    expect(msgs((m) => (m.viewpoints[1].at = [1, 2] as never))).toEqual(['viewpoints[1].at: expected 3 items, got 2']);
  });
  it('suggests the field meant', () => {
    expect(msgs((m) => ((m as unknown as Record<string, unknown>).Centre = [0, 0]))).toEqual([
      'Centre: unknown field (did you mean "centre"?)',
    ]);
  });
  it('checks types, ranges, enums and patterns', () => {
    expect(msgs((m) => (m.geo.lat = 95))).toEqual(['geo.lat: must be ≤ 90, got 95']);
    expect(msgs((m) => (m.frame = { units: 'yd' as never }))).toEqual([
      'frame.units: must be one of "ft", "m", got "yd"',
    ]);
    expect(msgs((m) => (m.id = 'has space'))).toEqual(['id: "has space" doesn\'t match ^[A-Za-z0-9][A-Za-z0-9_-]*$']);
    expect(msgs((m) => (m.name = 3 as never))).toEqual(['name: expected a string, got a number']);
  });
  it('rejects another format version', () => {
    expect(msgs((m) => (m.jarvis = 'jarvis-site/2'))).toEqual(['jarvis: must be "jarvis-site/1", got "jarvis-site/2"']);
  });
  it('rejects a key the viewer uses, a duplicate key and a duplicate layer', () => {
    expect(msgs((m) => (m.layers![0].key = 'W'))[0]).toMatch(/^layers\[0\]\.key: W is one of the viewer's own keys/);
    expect(msgs((m) => m.layers!.push({ id: 'pond', key: 'K' }, { id: 'pond', label: 'Pond' }))).toEqual([
      "layers[1].key: K is already layers[0]'s key",
      'layers[2].id: "pond" is already layers[1]',
    ]);
  });
  it('checks the time zone, the start view, extra models and regular expressions', () => {
    expect(msgs((m) => (m.geo.timeZone = 'Mars/Olympus'))).toEqual(['geo.timeZone: unknown time zone "Mars/Olympus"']);
    expect(msgs((m) => (m.startView = 3))).toEqual(['startView: there are only 2 viewpoints']);
    expect(msgs((m) => (m.models.extra = [{ id: 'f', url: 'f.glb', layer: 'nope' }]))).toEqual([
      'models.extra[0].layer: no layer "nope" in layers',
    ]);
    expect(msgs((m) => (m.plugins!.switches = { boxIdPattern: '([' }))[0]).toMatch(
      /^plugins.switches.boxIdPattern: not a regular expression/,
    );
  });
  it('wants storeys from the bottom up', () => {
    expect(
      msgs(
        (m) =>
          (m.storeys = [
            { name: 'a', z: 3 },
            { name: 'b', z: 1 },
          ]),
      ),
    ).toContain('storeys[1].z: storeys go from the bottom up: each z above the one before');
  });
  it('warns about a faults layer without Home Assistant', () => {
    const v = bad((m) => (m.plugins!.faults = { devices: 'd.json' }));
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.path)).toEqual(['plugins.faults']);
  });
});

describe('resolveSite: defaults and paths', () => {
  const site = resolveSite(cottageJson(), BASE);

  it('resolves paths against the manifest', () => {
    expect(site.models.main.url).toBe('https://example.org/sites/cottage/cottage.glb');
    expect(site.plugins.blueprints!.index).toBe('https://example.org/sites/cottage/plans/index.json');
    expect(
      resolveSite({ ...cottageJson(), models: { main: { url: 'https://cdn.example.net/m.glb' } } }, BASE).models.main
        .url,
    ).toBe('https://cdn.example.net/m.glb');
  });

  it('fills in the defaults', () => {
    expect(site.unit).toBe(1);
    expect(site.startView).toBe(0);
    expect(site.storeys).toEqual([{ name: 'ground floor', short: 'ground floor', z: 0, from: 0, objectsFrom: 0 }]);
    expect(site.walk.maxStep).toBe(0.35);
    expect(site.materials.glass).toEqual(['glass']);
    expect(site.floorPrefix).toBe('Floor_');
    expect(site.plugins['home-assistant']).toBeNull();
    expect(upperFromY(site)).toBe(Infinity);
  });

  it("has the built-in layers first, then the site's own", () => {
    expect(site.layers.map((l) => [l.id, l.key, l.hidden, l.builtin])).toEqual([
      ['roof', null, false, true],
      ['ceiling', null, false, true],
      ['door', 'O', true, true],
      ['shed', 'K', false, false],
    ]);
    expect(site.layers[3].match.layer).toEqual(['shed']);
    expect(site.layers[3].code).toBe('KeyK');
  });

  it('lets the site override a built-in layer', () => {
    const s = resolveSite(
      { ...cottageJson(), layers: [{ id: 'door', key: 'J', match: { material: ['door'] } }] },
      BASE,
    );
    const door = s.layers.find((l) => l.id === 'door')!;
    expect([door.key, door.hidden, door.match.material, door.match.extra]).toEqual(['J', true, ['door'], []]);
  });

  it('places positions and objects on storeys', () => {
    const s = resolveSite(FULL, BASE);
    expect(storeyAt(s, 4).index).toBe(0);
    expect(storeyAt(s, 6).storey.name).toBe('first');
    expect(storeyOfObject(s, 6).index).toBe(0);
    expect(storeyOfObject(s, 9).storey.short).toBe('up');
    expect(upperFromY(s)).toBeCloseTo(8 * 0.3048);
  });

  it('matches nodes by name prefix, layer extra, material or a truthy extra', () => {
    const door = resolveSite(cottageJson(), BASE).layers.find((l) => l.id === 'door')!.match;
    const n = (name: string, extras = {}, materials: string[] = []) => ({ name, extras, materials });
    expect(matches(door, n('Door_front', { door_leaf: true }))).toBe(true);
    expect(matches(door, n('Door_front', { door_leaf: false }))).toBe(false);
    expect(matches(door, n('X', { layer: 'door' }))).toBe(true);
    expect(matches({ ...door, material: ['oak_door'] }, n('X', {}, ['paint', 'oak_door']))).toBe(true);
  });
});

describe('finding and loading the manifest', () => {
  it('reads ?site=, else site.json next to the page', () => {
    expect(manifestUrl({ href: 'https://v.example.org/app/?x=1', search: '?x=1' })).toBe(
      'https://v.example.org/app/site.json',
    );
    expect(manifestUrl({ href: 'https://v.example.org/app/?site=../s/a.json', search: '?site=../s/a.json' })).toBe(
      'https://v.example.org/s/a.json',
    );
    expect(
      manifestUrl({
        href: 'https://v.example.org/?site=https://b.example.net/s.json',
        search: '?site=https://b.example.net/s.json',
      }),
    ).toBe('https://b.example.net/s.json');
  });

  const fakeFetch = (body: string, init: ResponseInit = {}) => (async () => new Response(body, init)) as typeof fetch;

  it('loads and resolves a good manifest', async () => {
    const { site, warnings } = await loadSite(BASE, fakeFetch(JSON.stringify(cottageJson())));
    expect(site.name).toBe('Example cottage');
    expect(warnings).toEqual([]);
  });

  it('turns every failure into readable lines', async () => {
    const fail = async (f: typeof fetch) => {
      try {
        await loadSite(BASE, f);
      } catch (e) {
        expect(e).toBeInstanceOf(SiteError);
        return (e as SiteError).lines;
      }
      throw new Error('loaded');
    };
    expect((await fail(fakeFetch('', { status: 404 })))[0]).toMatch(/^HTTP 404: no site manifest here/);
    expect((await fail(fakeFetch('<!doctype html>', { headers: { 'content-type': 'text/html' } })))[0]).toMatch(
      /^got a web page/,
    );
    expect((await fail(fakeFetch('{nope')))[0]).toMatch(/^not valid JSON/);
    expect(await fail(fakeFetch(JSON.stringify({ ...cottageJson(), viewpoints: [] })))).toEqual([
      'viewpoints: expected at least 1 item, got 0',
    ]);
  });
});

describe('model check', () => {
  const site = resolveSite(cottageJson(), BASE);

  it('reads a glb and finds rooms, fixtures, layers and the size', () => {
    const r = checkModel(readGltfJson(buildGlb(cottage())), site, true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.stats).toMatchObject({ topLevel: 8, fixtures: 1, rooms: 1, merged: 1 });
    expect(r.stats.layers).toEqual({ roof: 1, ceiling: 1, door: 1, shed: 1 });
    expect(r.stats.box!.min[0]).toBeCloseTo(-0.5);
    expect(r.stats.box!.max[0]).toBeCloseTo(12);
  });

  it('flags required extensions the viewer lacks, duplicate fixtures and a model in millimetres', () => {
    const nodes = cottage();
    nodes.push({ name: 'Fixture_again', extras: { fixture_id: 'main.pendant' } });
    for (const n of nodes) if (n.box) n.box = n.box.map((c) => c.map((x) => x * 1000)) as typeof n.box;
    const r = checkModel(readGltfJson(buildGlb(nodes, { required: ['KHR_draco_mesh_compression'] })), site, true);
    expect(r.errors).toEqual([
      "requires KHR_draco_mesh_compression, which the viewer doesn't load (use meshopt: gltfpack -cc)",
      'fixture_id main.pendant is on both Fixture_main.pendant and Fixture_again',
    ]);
    expect(r.warnings.join('\n')).toMatch(/12500 m across: glTF is in metres/);
  });

  it('accepts meshopt compression under either extension name (gltfpack -cc, and -cc -ce khr)', () => {
    for (const ext of ['EXT_meshopt_compression', 'KHR_meshopt_compression']) {
      const r = checkModel(readGltfJson(buildGlb(cottage(), { required: [ext, 'KHR_mesh_quantization'] })), site, true);
      expect(r.errors, ext).toEqual([]);
    }
  });

  it('warns when a keyed layer takes nothing and there are no rooms', () => {
    const r = checkModel(
      readGltfJson(buildGlb(cottage().filter((n) => n.name !== 'Shed' && !n.name!.startsWith('Floor_')))),
      site,
      true,
    );
    expect(r.warnings).toEqual([
      'no room floors (top-level nodes named Floor_* with a `room` extra): the room list and "where am I" stay empty',
      'layer "shed" takes no node: its key (K) will do nothing',
    ]);
  });
});

describe('checkSite (validate-site)', () => {
  const files = (extra: Record<string, Uint8Array | string> = {}) => {
    const enc = (v: Uint8Array | string) => (typeof v === 'string' ? new TextEncoder().encode(v) : v);
    const all: Record<string, Uint8Array | string> = {
      'site.json': JSON.stringify(cottageJson()),
      'cottage.glb': buildGlb(cottage()),
      'cottage.parts.json': JSON.stringify({
        parts: { walls: [['Wall_south', [0, 0, -0.2, 8, 2.6, 0], ['plaster'], {}]] },
      }),
      'plans/index.json': JSON.stringify({
        sheets: [{ id: 'P1', title: 'Plan', kind: 'plan', file: 'p1.webp', corners: {} }],
      }),
      'plans/p1.webp': 'img',
      ...extra,
    };
    return async (url: string) => {
      const k = url.replace('file:///site/', '');
      return all[k] != null ? enc(all[k]) : null;
    };
  };

  it('passes the test site', async () => {
    const r = await checkSite('file:///site/site.json', files());
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.notes[0]).toMatch(
      /^main model: cottage.glb: 8 top-level nodes, 1 fixtures, 1 rooms, 1 merged keys, 12.5 × 7.0 m$/,
    );
  });

  it('reports missing files, bad JSON, bad parts and missing sheet images', async () => {
    const r = await checkSite(
      'file:///site/site.json',
      files({
        'cottage.parts.json': JSON.stringify({ parts: { other: [['x', [1, 2], [], {}]] } }),
        'plans/p1.webp': undefined as never,
      }),
    );
    expect(r.errors).toEqual([
      'main model parts: parts.other[0]: expected [name, [min x, y, z, max x, y, z], [materials], {extras}]',
      'blueprints index: 1 sheet image not found',
    ]);
    expect(r.warnings).toEqual(['main model parts: 1 merged keys not in cottage.parts.json (e.g. walls)']);
  });

  it('stops at the manifest when it is invalid', async () => {
    const r = await checkSite('file:///site/site.json', files({ 'site.json': '{"jarvis": "jarvis-site/1"}' }));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toBe('site.json: id: is required');
    expect(r.notes).toEqual([]);
  });

  it('needs the main model', async () => {
    const r = await checkSite('file:///site/site.json', files({ 'cottage.glb': undefined as never }));
    expect(r.errors).toEqual(['main model: cottage.glb not found']);
  });

  it('warns about a viewpoint far outside the model', async () => {
    const m = cottageJson();
    m.viewpoints[1].at = [400, 3, 0];
    const r = await checkSite('file:///site/site.json', files({ 'site.json': JSON.stringify(m) }));
    expect(r.warnings).toEqual(['site.json: viewpoints[1] (Room) is more than 30 m outside the model']);
  });
});
