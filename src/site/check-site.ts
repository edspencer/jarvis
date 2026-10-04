// Checks a whole site: the manifest against its schema and rules, every file it names (present, parseable), each
// model against the model format, and the parts and blueprint files. The caller supplies `read` (bytes for a URL, or
// null if there is no such file), so the CLI reads the disk and the tests read memory. Files on another origin than
// the manifest's are listed as not checked. An external plugin's module is imported to check what it exports only if
// the caller passes opts.importModule (the CLI's --run-plugin-code).
import { checkModel, checkParts, readGltfJson, type ModelReport } from './model-check.ts';
import { resolveSite, type Site } from './resolve.ts';
import { formatIssues, reservedKeys, validateManifest } from './validate.ts';
import { configProblems, pluginOf } from './external.ts';
import { CORE_KEYS } from '../core/plugin/keys.ts';
import type { SiteManifest } from './manifest.ts';
import { PLUGIN_FILE_CHECKS } from '../plugins/checks.ts';

export type Reader = (url: string) => Promise<Uint8Array | null>;

export interface SiteReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** one line per thing checked */
  notes: string[];
  site: Site | null;
  models: Record<string, ModelReport>;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

export interface CheckOptions {
  /** import an external plugin's module (a local file) to check what it exports, its keys and its section; without
   * it, only the file's presence is checked */
  importModule?: (url: string) => Promise<unknown>;
}

export async function checkSite(manifestUrl: string, read: Reader, opts: CheckOptions = {}): Promise<SiteReport> {
  const errors: string[] = [],
    warnings: string[] = [],
    notes: string[] = [];
  const report: SiteReport = { ok: false, errors, warnings, notes, site: null, models: {} };
  const raw = await read(manifestUrl);
  if (!raw) return (errors.push(`no manifest at ${manifestUrl}`), report);
  let json: unknown;
  try {
    json = JSON.parse(text(raw));
  } catch (e) {
    return (errors.push(`site.json: not valid JSON (${(e as Error).message})`), report);
  }
  const v = validateManifest(json);
  errors.push(...formatIssues(v.errors).map((l) => `site.json: ${l}`));
  warnings.push(...formatIssues(v.warnings).map((l) => `site.json: ${l}`));
  if (!v.ok) return report;
  const site = resolveSite(json as SiteManifest, manifestUrl);
  report.site = site;
  const origin = new URL(manifestUrl).origin;
  const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
  const short = (u: string) => (u.startsWith(base) ? u.slice(base.length) : u);

  /** the file's bytes; null (with an error or warning) if it is missing; undefined if it is remote */
  async function file(url: string, what: string, required: boolean): Promise<Uint8Array | null | undefined> {
    if (new URL(url).origin !== origin) {
      notes.push(`${what}: ${url} (remote, not checked)`);
      return undefined;
    }
    const b = await read(url);
    if (!b) (required ? errors : warnings).push(`${what}: ${short(url)} not found`);
    return b;
  }
  async function jsonFile(url: string, what: string, required = true): Promise<unknown> {
    const b = await file(url, what, required);
    if (!b) return undefined;
    try {
      return JSON.parse(text(b));
    } catch (e) {
      errors.push(`${what}: ${short(url)} is not valid JSON (${(e as Error).message})`);
      return undefined;
    }
  }

  // the models and their parts files
  for (const m of [site.models.main, ...site.models.extra]) {
    const isMain = m.id === 'main';
    const what = isMain ? 'main model' : `model ${m.id}`;
    const b = await file(m.url, what, isMain);
    let rep: ModelReport | null = null;
    if (b) {
      try {
        rep = checkModel(readGltfJson(b), site, isMain);
      } catch (e) {
        errors.push(`${what}: ${short(m.url)} can't be read (${(e as Error).message})`);
      }
    }
    if (rep) {
      report.models[m.id] = rep;
      errors.push(...rep.errors.map((l) => `${what}: ${l}`));
      warnings.push(...rep.warnings.map((l) => `${what}: ${l}`));
      const s = rep.stats;
      notes.push(
        `${what}: ${short(m.url)}: ${s.topLevel} top-level nodes, ${s.fixtures} fixtures, ${s.rooms} rooms, ${s.merged} merged keys` +
          (s.box
            ? `, ${(s.box.max[0] - s.box.min[0]).toFixed(1)} × ${(s.box.max[2] - s.box.min[2]).toFixed(1)} m`
            : ''),
      );
    }
    if (!m.parts) {
      if (rep?.stats.merged)
        warnings.push(
          `${what}: ${rep.stats.merged} merged nodes but no parts file: the inspect panel shows the merged names`,
        );
      continue;
    }
    const pj = await jsonFile(m.parts, `${what} parts`, false);
    if (pj === undefined) continue;
    const p = checkParts(pj);
    errors.push(...p.errors.map((l) => `${what} parts: ${l}`));
    if (rep) {
      const missing = rep.mergedKeys.filter((k) => !p.keys.has(k));
      if (missing.length)
        warnings.push(
          `${what} parts: ${missing.length} merged keys not in ${short(m.parts)} (e.g. ${missing.slice(0, 3).join(', ')})`,
        );
    }
  }

  // viewpoints inside the main model's box (a viewpoint far outside it is likely in the wrong units or frame)
  const box = report.models.main?.stats.box;
  if (box) {
    const pad = 30; // m
    site.viewpoints.forEach((vp, i) => {
      const [x, y, z] = vp.at.map((c) => c * site.unit);
      const w = [x, z, -y]; // plan -> three.js
      if (w.some((c, k) => c < box.min[k] - pad || c > box.max[k] + pad))
        warnings.push(`site.json: viewpoints[${i}] (${vp.name}) is more than ${pad} m outside the model`);
    });
  }

  // the plugins' files
  const p = site.plugins;
  const ha = p['home-assistant'];
  if (p.lights?.map) await jsonFile(p.lights.map, 'lights fixture map', false);
  if (ha?.controls) await jsonFile(ha.controls, 'home-assistant controls', false);
  if (p.faults) {
    const d = (await jsonFile(p.faults.devices, 'faults devices')) as { devices?: unknown } | undefined;
    if (d && !Array.isArray(d.devices)) errors.push('faults devices: expected { "devices": [ … ] }');
  }
  if (p.pins) {
    const d = (await jsonFile(p.pins.registry, 'pins registry')) as { pins?: unknown } | undefined;
    if (d && !Array.isArray(d.pins)) errors.push('pins registry: expected { "pins": [ … ] }');
  }
  if (p.blueprints) {
    const idx = (await jsonFile(p.blueprints.index, 'blueprints index')) as
      { sheets?: { id?: string; file?: string; corners?: unknown; corners_ft?: unknown }[] } | undefined;
    if (idx) {
      if (!Array.isArray(idx.sheets)) errors.push('blueprints index: expected { "sheets": [ … ] }');
      else {
        let missing = 0;
        for (const s of idx.sheets) {
          if (!s.id || !s.file || !(s.corners || s.corners_ft)) {
            errors.push(`blueprints index: sheet ${s.id || '?'} needs id, file and corners`);
            continue;
          }
          const u = new URL(s.file, p.blueprints.index).href;
          if (new URL(u).origin === origin && !(await read(u))) missing++;
        }
        if (missing) errors.push(`blueprints index: ${missing} sheet image${missing > 1 ? 's' : ''} not found`);
        if (p.blueprints.default && !idx.sheets.some((s) => s.id === p.blueprints!.default))
          warnings.push(`plugins.blueprints.default: no sheet "${p.blueprints.default}" in the index`);
        notes.push(`blueprints: ${idx.sheets.length} sheets`);
      }
    }
  }
  // the plugins' own mapping files (src/plugins/checks.ts)
  for (const [id, checks] of Object.entries(PLUGIN_FILE_CHECKS)) {
    const section = (p as Record<string, unknown>)[id] as Record<string, unknown> | null | undefined;
    if (!section) continue;
    for (const c of checks) {
      const url = c.file(section);
      if (!url) continue;
      const d = await jsonFile(url, c.what, c.required ?? true);
      if (d === undefined) continue;
      const v = c.check(d);
      errors.push(...formatIssues(v.errors).map((l) => `${c.what}: ${l}`));
      warnings.push(...formatIssues(v.warnings).map((l) => `${c.what}: ${l}`));
      for (const n of v.notes || []) notes.push(`${c.what}: ${n}`);
    }
  }

  // external plugins (src/site/external.ts): the module is there and exports a plugin, its keys are free, and its
  // section passes the plugin's own validate()
  const taken = new Map<string, string>();
  for (const k of reservedKeys(site.manifest))
    taken.set(k, (CORE_KEYS as readonly string[]).includes(k) ? "the viewer's" : "a built-in plugin's");
  for (const l of site.layers) if (l.key) taken.set(l.key, `layer ${l.id}'s`);
  for (const [id, { module }] of Object.entries(site.external)) {
    const what = `plugin ${id}`;
    const b = await file(module, `${what} module`, true);
    if (!b) continue;
    if (!opts.importModule) {
      notes.push(
        `${what}: ${short(module)} is there; its exports, keys and section weren't checked (--run-plugin-code runs it to check them)`,
      );
      continue;
    }
    let mod: unknown;
    try {
      mod = await opts.importModule(module);
    } catch (e) {
      warnings.push(
        `${what}: ${short(module)} doesn't run outside a browser (${(e as Error).message}): its exports, keys and section are checked in the viewer only`,
      );
      continue;
    }
    const { def, problems } = pluginOf(mod, id);
    errors.push(...problems.map((l) => `${what}: ${short(module)}: ${l}`));
    if (!def) continue;
    for (const k of def.keys ?? []) {
      const who = taken.get(k);
      if (who) errors.push(`${what}: its key ${k} is already ${who}`);
      else taken.set(k, `plugin ${id}'s`);
    }
    errors.push(...configProblems(def, p[id]).map((l) => `plugins.${id}: ${l}`));
    notes.push(`${what}: ${short(module)}: ${def.name}${def.keys?.length ? `, keys ${def.keys.join(' ')}` : ''}`);
  }
  report.ok = !errors.length;
  return report;
}
