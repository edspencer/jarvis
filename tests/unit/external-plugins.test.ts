// External plugins (a plugins.<id> section with a `module`): where a module may come from, what it must export, the
// manifest rules, validate-site's checks, and which plugins' code the viewer downloads (only the enabled ones).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import measure from '../../docs/examples/measure';
import { createPluginHost } from '../../src/core/plugin/host';
import { loadPlugins } from '../../src/core/plugin/load';
import type { PluginContext, PluginDef } from '../../src/core/plugin/types';
import * as api from '../../src/plugin-api';
import { BUILTIN_PLUGINS, builtinsToLoad, pluginKeys, type BuiltinPlugin } from '../../src/plugins/registry';
import { resolveSite, validateManifest, type SiteManifest } from '../../src/site';
import { checkSite } from '../../src/site/check-site';
import { configProblems, moduleRefusal, pluginOf } from '../../src/site/external';
import { buildGlb, cottage } from './glb';

const FIXTURE = new URL('../fixtures/site/site.json', import.meta.url);
const cottageJson = (): SiteManifest => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const withPlugins = (plugins: Record<string, unknown>, extra: Partial<SiteManifest> = {}): SiteManifest => {
  const m = cottageJson();
  return { ...m, ...extra, plugins: { ...m.plugins, ...plugins } as SiteManifest['plugins'] };
};

describe('the plugin API at run time', () => {
  it('exports at run time only definePlugin, which returns its argument, and plain data (a bundled plugin needs only ctx)', () => {
    const def = { id: 'x', name: 'X', setup() {} };
    expect(api.definePlugin(def)).toBe(def);
    for (const [name, v] of Object.entries(api))
      if (name !== 'definePlugin') expect(JSON.parse(JSON.stringify(v)), name).toEqual(v); // constants only
    expect(Object.keys(api).sort()).toEqual(['MATERIAL_PRIORITY', 'definePlugin']);
  });
});

describe('moduleRefusal: where a module may come from', () => {
  const page = 'https://twin.example.org/';
  const here = { page, manifest: 'https://twin.example.org/site.json', origins: [] };
  it("allows the viewer's own origin", () => {
    expect(moduleRefusal('https://twin.example.org/plugins/m.js', here)).toBeNull();
  });
  it('refuses another origin unless the manifest lists it', () => {
    expect(moduleRefusal('https://cdn.example.com/m.js', here)).toMatch(/isn't the viewer's origin: list it/);
    expect(moduleRefusal('https://cdn.example.com/m.js', { ...here, origins: ['https://cdn.example.com'] })).toBeNull();
  });
  it('a cross-origin manifest loads no external module at all, whatever its pluginOrigins say', () => {
    const away = { page, manifest: 'https://evil.example.net/site.json', origins: ['https://evil.example.net'] };
    expect(moduleRefusal('https://evil.example.net/m.js', away)).toMatch(/a manifest from another origin can't/);
    // not even a file on the viewer's own origin: its top-level code would run before it could be rejected
    expect(moduleRefusal('https://twin.example.org/plugins/m.js', away)).toMatch(
      /a manifest from another origin can't/,
    );
  });
  it('only http(s)', () => {
    expect(moduleRefusal('data:text/javascript,export default 1', here)).toMatch(/^data: URLs aren't loaded/);
    expect(moduleRefusal('javascript:alert(1)', here)).toMatch(/^javascript: URLs/);
    expect(moduleRefusal('blob:https://twin.example.org/x', here)).toMatch(/^blob: URLs/);
  });
});

describe('pluginOf: what a module must export', () => {
  const good = { id: 'm', name: 'M', setup() {} };
  it('takes the default export', () => {
    expect(pluginOf({ default: good }, 'm')).toEqual({ def: good, problems: [] });
  });
  it('says what is wrong', () => {
    expect(pluginOf({}, 'm').problems).toEqual([
      'the module has no default export: export default definePlugin({ … })',
    ]);
    expect(pluginOf({ default: { ...good, id: 'other' } }, 'm').problems).toEqual([
      'it exports the plugin "other", but the section is plugins.m',
    ]);
    expect(pluginOf({ default: { id: 'm', keys: ['m'], requires: 'x', validate: 1 } }, 'm').problems).toEqual([
      'it has no name',
      'it has no setup(ctx) function',
      'requires: expected a list of plugin ids',
      "keys: expected a list of capital letters (['M'])",
      'validate: expected a function',
    ]);
  });
  it("runs a plugin's validate, and counts a throw as a problem", () => {
    expect(configProblems(measure, { decimals: 'two' })).toEqual(['decimals: expected a whole number']);
    expect(configProblems({}, {})).toEqual([]);
    expect(
      configProblems(
        {
          validate: () => {
            throw new Error('boom');
          },
        },
        {},
      ),
    ).toEqual(['its validate() threw: boom']);
  });
});

describe('the manifest', () => {
  it('accepts a section with a module, with any fields of its own', () => {
    const v = validateManifest(withPlugins({ measure: { module: 'plugins/measure.js', decimals: 2, anything: [1] } }));
    expect(v).toEqual({ ok: true, errors: [], warnings: [] });
  });
  it("skips (with a warning) an external plugin whose id is a built-in's: a new release may add one", () => {
    const v = validateManifest(withPlugins({ energy: { module: 'e.js' }, sun: { module: 's.js' } }));
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => `${w.path}: ${w.message}`)).toEqual([
      'plugins.energy.module: "energy" is a built-in plugin\'s id: this external plugin is skipped (give it an id of its own)',
      'plugins.sun.module: "sun" is a built-in plugin\'s id: this external plugin is skipped (give it an id of its own)',
    ]);
    const site = resolveSite(withPlugins({ energy: { module: 'e.js' } }), 'https://example.org/site.json');
    expect(site.external).toEqual({});
  });
  it('needs a module to be a string and a lower-case id', () => {
    const msgs = (p: Record<string, unknown>) =>
      validateManifest(withPlugins(p)).errors.map((e) => `${e.path}: ${e.message}`);
    expect(msgs({ measure: { module: 3 } })).toEqual(['plugins.measure.module: expected a string, got a number']);
    expect(msgs({ My_Plugin: { module: 'p.js' } })).toEqual([
      "plugins.My_Plugin: an external plugin's id is lower-case letters, digits and '-', starting with a letter",
    ]);
  });
  it('a section without a module is still skipped with a warning', () => {
    const v = validateManifest(withPlugins({ measure: { decimals: 2 } }));
    expect(v.ok).toBe(true);
    expect(v.warnings.map((w) => w.path)).toEqual(['plugins.measure']);
  });
  it('warns about an absolute module URL on an origin pluginOrigins lacks; pluginOrigins are origins', () => {
    const v = validateManifest(withPlugins({ m: { module: 'https://cdn.example.com/m.js' } }));
    expect(v.warnings.map((w) => `${w.path}: ${w.message}`)).toEqual([
      "plugins.m.module: https://cdn.example.com isn't in pluginOrigins: the module loads only if the viewer is served from there",
    ]);
    const listed = withPlugins(
      { m: { module: 'https://cdn.example.com/m.js' } },
      { pluginOrigins: ['https://cdn.example.com'] },
    );
    expect(validateManifest(listed)).toEqual({ ok: true, errors: [], warnings: [] });
    const bad = validateManifest(
      withPlugins({}, { pluginOrigins: ['https://cdn.example.com/x', 'https://Cdn.example.com'] }),
    );
    expect(bad.errors.map((e) => `${e.path}: ${e.message}`)).toEqual([
      'pluginOrigins[0]: "https://cdn.example.com/x" doesn\'t match ^https?://[^/?#]+$',
    ]);
    const upper = validateManifest(withPlugins({}, { pluginOrigins: ['https://Cdn.example.com'] }));
    expect(upper.errors.map((e) => e.message)).toEqual(['not an origin (did you mean "https://cdn.example.com"?)']);
  });
  it('a protocol-relative or backslashed module URL is another origin too; only http(s)', () => {
    const w = (module: string) =>
      validateManifest(withPlugins({ m: { module } })).warnings.map((x) => x.message.split(' ')[0]);
    expect(w('//evil.example/x.js')).toEqual(['https://evil.example']);
    expect(w('\\\\evil.example\\x.js')).toEqual(['https://evil.example']);
    expect(w('plugins/x.js')).toEqual([]);
    expect(validateManifest(withPlugins({ m: { module: 'data:text/javascript,1' } })).errors[0].message).toBe(
      'only an http(s) URL loads',
    );
  });
  it('resolves the module against the manifest; ctx.config is the section without it', () => {
    const m = withPlugins({ measure: { module: 'plugins/measure.js', decimals: 2 } });
    const site = resolveSite(m, 'https://example.org/sites/cottage/site.json');
    expect(site.external).toEqual({ measure: { module: 'https://example.org/sites/cottage/plugins/measure.js' } });
    expect(site.plugins.measure).toEqual({ decimals: 2 });
    expect(site.pluginOrigins).toEqual([]);
  });
});

describe("a section's keys win over the plugin's", () => {
  it('are checked with the manifest: against the core, the built-ins, other plugins and the layers', () => {
    const msgs = (p: Record<string, unknown>, layers?: SiteManifest['layers']) =>
      validateManifest(withPlugins(p, layers ? { layers } : {})).errors.map((e) => `${e.path}: ${e.message}`);
    expect(msgs({ measure: { module: 'm.js', keys: ['M'] } })).toEqual([]);
    expect(msgs({ measure: { module: 'm.js', keys: ['W'] } })).toEqual([
      "plugins.measure.keys[0]: W is already the viewer's",
    ]);
    expect(msgs({ measure: { module: 'm.js', keys: ['m'] } })[0]).toMatch(
      /^plugins.measure.keys\[0\]: "m" doesn't match/,
    );
    expect(msgs({ a: { module: 'a.js', keys: ['Y'] }, b: { module: 'b.js', keys: ['Y'] } })).toEqual([
      "plugins.b.keys[0]: Y is already plugins.a's",
    ]);
    expect(msgs({ measure: { module: 'm.js', keys: ['M'] } }, [{ id: 'mezz', label: 'Mezz', key: 'M' }])[0]).toMatch(
      /^layers\[0\].key: M is one of the viewer's own keys/,
    );
  });
  it("aren't ctx.config, and are what the runtime declares for the plugin", async () => {
    const site = resolveSite(
      withPlugins({ measure: { module: 'm.js', keys: ['Y'], decimals: 1 } }),
      'https://t.example/site.json',
    );
    expect(site.plugins.measure).toEqual({ decimals: 1 });
    expect(site.external.measure).toEqual({ module: 'https://t.example/m.js', keys: ['Y'] });
    const r = await loadPlugins(
      { ...site, url: 'https://t.example/site.json' },
      {
        enabled: () => true,
        page: 'https://t.example/',
        failed: () => {},
        importModule: async () => ({ default: measure }),
        fetch: ok,
        builtins: {},
      },
    );
    expect(r.keys).toEqual({ measure: ['Y'] }); // not the plugin's own ['M']
  });
});

describe('validate-site', () => {
  const files = (extra: Record<string, string | undefined> = {}) => {
    const enc = (v: Uint8Array | string) => (typeof v === 'string' ? new TextEncoder().encode(v) : v);
    const all: Record<string, Uint8Array | string | undefined> = {
      'cottage.glb': buildGlb(cottage()),
      'cottage.parts.json': JSON.stringify({
        parts: { walls: [['Wall_south', [0, 0, -0.2, 8, 2.6, 0], ['plaster'], {}]] },
      }),
      'plans/index.json': JSON.stringify({ sheets: [{ id: 'P1', file: 'p1.webp', corners: {} }] }),
      'plans/p1.webp': 'img',
      'plugins/measure.js': '// the module',
      ...extra,
    };
    return async (url: string) => {
      const v = all[url.replace('file:///site/', '')];
      return v != null ? enc(v) : null;
    };
  };
  const site = (m: SiteManifest) => JSON.stringify(m);

  it('checks the module is there, exports the plugin, its keys are free and its section passes validate()', async () => {
    const importModule = vi.fn(async () => ({ default: measure }));
    const m = withPlugins({ measure: { module: 'plugins/measure.js', decimals: 2 } });
    const r = await checkSite('file:///site/site.json', files({ 'site.json': site(m) }), { importModule });
    expect(importModule).toHaveBeenCalledWith('file:///site/plugins/measure.js');
    expect(r.errors).toEqual([]);
    expect(r.notes).toContain('plugin measure: plugins/measure.js: Measure, keys M');
  });

  it("knows a section's keys without running the plugin's code", async () => {
    const m = withPlugins({ measure: { module: 'plugins/measure.js', keys: ['M'] } });
    const r = await checkSite('file:///site/site.json', files({ 'site.json': site(m) }));
    expect(r.errors).toEqual([]);
    expect(r.notes).toContain(
      "plugin measure: plugins/measure.js is there, keys M (the site's); its exports and section weren't checked (--run-plugin-code runs it to check them)",
    );
  });

  it('reports a missing module, a key taken by a layer, and the problems validate() finds', async () => {
    const importModule = async () => ({ default: measure });
    const missing = await checkSite(
      'file:///site/site.json',
      files({ 'site.json': site(withPlugins({ measure: { module: 'plugins/nope.js' } })) }),
      { importModule },
    );
    expect(missing.errors).toEqual(['plugin measure module: plugins/nope.js not found']);

    const m = withPlugins({ measure: { module: 'plugins/measure.js', decimals: -1 } });
    m.layers = [...(m.layers || []), { id: 'mezz', label: 'Mezzanine', key: 'M' }];
    const r = await checkSite('file:///site/site.json', files({ 'site.json': site(m) }), { importModule });
    expect(r.errors).toEqual([
      "plugin measure: its key M is already layer mezz's",
      'plugins.measure: decimals: expected a whole number',
    ]);
  });

  it("reports a module that isn't a plugin, and one that doesn't run in Node (a warning)", async () => {
    const m = site(withPlugins({ measure: { module: 'plugins/measure.js' } }));
    const notPlugin = await checkSite('file:///site/site.json', files({ 'site.json': m }), {
      importModule: async () => ({ default: { id: 'measure' } }),
    });
    expect(notPlugin.errors).toEqual([
      'plugin measure: plugins/measure.js: it has no name',
      'plugin measure: plugins/measure.js: it has no setup(ctx) function',
    ]);
    const browserOnly = await checkSite('file:///site/site.json', files({ 'site.json': m }), {
      importModule: async () => {
        throw new ReferenceError('document is not defined');
      },
    });
    expect(browserOnly.ok).toBe(true);
    expect(browserOnly.warnings).toEqual([
      "plugin measure: plugins/measure.js doesn't run outside a browser (document is not defined): its exports, keys and section are checked in the viewer only",
    ]);
    const noRun = await checkSite('file:///site/site.json', files({ 'site.json': m }));
    expect(noRun.notes).toContain(
      "plugin measure: plugins/measure.js is there; its exports, keys and section weren't checked (--run-plugin-code runs it to check them)",
    );
  });
});

const ok = (async () => new Response('export default {}')) as unknown as typeof fetch;

describe('loading the plugins: only the code a site needs', () => {
  const fake = (id: string, autoStart = false): BuiltinPlugin & { loads: number } => {
    const p = {
      keys: [],
      autoStart,
      loads: 0,
      load: async () => (p.loads++, { default: { id, name: id, autoStart, setup() {} } as PluginDef<never> }),
    };
    return p;
  };

  it("the registry's autoStart matches each plugin's own, and only enabled or autoStart plugins load", async () => {
    for (const [id, p] of Object.entries(BUILTIN_PLUGINS))
      expect(!!(await p.load()).default.autoStart, id).toBe(!!p.autoStart);
    expect(builtinsToLoad(() => false)).toEqual(['sun', 'switches']);
    expect(builtinsToLoad((id) => id === 'pins')).toEqual(['sun', 'pins', 'switches']);
    expect(pluginKeys([]).sort()).toEqual(['L']);
    expect(pluginKeys(['energy']).sort()).toEqual(['J', 'L']);
  });

  it('downloads the enabled built-ins and the external modules, never the rest', async () => {
    const builtins = { sun: fake('sun', true), pins: fake('pins'), energy: fake('energy') };
    const importModule = vi.fn(async () => ({ default: { ...measure, autoStart: true } }));
    const failed: string[] = [];
    const site = {
      url: 'https://twin.example.org/site.json',
      external: { measure: { module: 'https://twin.example.org/plugins/measure.js' } },
      pluginOrigins: [],
    };
    const r = await loadPlugins(site, {
      enabled: (id) => id === 'pins' || id === 'measure',
      page: 'https://twin.example.org/',
      failed: (id, why) => failed.push(`${id}: ${why}`),
      importModule,
      fetch: ok,
      builtins,
    });
    expect(r.defs.map((d) => d.id)).toEqual(['sun', 'pins', 'measure']);
    expect(builtins.energy.loads).toBe(0);
    expect(r.defs[2].autoStart).toBe(false); // an external plugin starts from its section only
    expect(r.keys).toEqual({ measure: ['M'] });
    expect(failed).toEqual([]);
  });

  it("refuses a module from another origin without importing it, and reports one that isn't a plugin", async () => {
    const importModule = vi.fn(async (url: string) => (url.endsWith('bad.js') ? { default: 42 } : {}));
    const failed: string[] = [];
    const r = await loadPlugins(
      {
        url: 'https://twin.example.org/site.json',
        external: {
          far: { module: 'https://cdn.example.com/far.js' },
          bad: { module: 'https://twin.example.org/bad.js' },
        },
        pluginOrigins: [],
      },
      {
        enabled: () => true,
        page: 'https://twin.example.org/',
        failed: (id, why) => failed.push(`${id}: ${why}`),
        importModule,
        fetch: ok,
        builtins: {},
      },
    );
    expect(r.defs).toEqual([]);
    expect(importModule).toHaveBeenCalledTimes(1);
    expect(failed).toEqual([
      "far: https://cdn.example.com isn't the viewer's origin: list it in the manifest's pluginOrigins to allow it",
      'bad: the module has no default export: export default definePlugin({ … })',
    ]);
  });
});

describe('a module URL that redirects is never imported', () => {
  const load = (f: typeof fetch) => {
    const importModule = vi.fn(async () => ({ default: measure }));
    const failed: string[] = [];
    return loadPlugins(
      {
        url: 'https://twin.example.org/site.json',
        external: { measure: { module: 'https://twin.example.org/go?u=https://evil.example/pwn.js' } },
        pluginOrigins: [],
      },
      {
        enabled: () => true,
        page: 'https://twin.example.org/',
        failed: (_, why) => failed.push(why),
        importModule,
        fetch: f,
        builtins: {},
      },
    ).then((r) => ({ r, failed, importModule }));
  };
  it('a manual-redirect probe that sees a redirect (opaque, or a 3xx) refuses it', async () => {
    const seen: RequestInit[] = [];
    const opaque = (async (_: string, init: RequestInit) => (
      seen.push(init),
      { type: 'opaqueredirect', status: 0, ok: false, redirected: false }
    )) as unknown as typeof fetch;
    const a = await load(opaque);
    expect(seen[0].redirect).toBe('manual');
    expect(a.importModule).not.toHaveBeenCalled();
    expect(a.failed[0]).toMatch(/redirects: a plugin module is loaded only from its own URL/);
    const status = (async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
    expect((await load(status)).failed[0]).toMatch(/redirects/);
    const missing = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect((await load(missing)).failed[0]).toMatch(/HTTP 404$/);
  });
});

describe('the host runs validate() before setup', () => {
  it('a problem keeps the plugin off, with the problems in the report; setup never runs', async () => {
    const reports: string[] = [];
    const host = createPluginHost({
      enabled: () => true,
      context: (def) => ({ id: def.id, config: { decimals: 'x' } }) as unknown as PluginContext,
      report: (def, m) => reports.push(`${def.name}: ${m}`),
    });
    const setup = vi.fn();
    await host.start([{ ...measure, setup } as PluginDef]);
    expect(setup).not.toHaveBeenCalled();
    expect(host.running('measure')).toBe(false);
    expect(reports).toEqual(['Measure: plugins.measure: decimals: expected a whole number']);
  });
});
