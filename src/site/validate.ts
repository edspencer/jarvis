// Checks a site manifest: first against its JSON Schema (schema/site.schema.json, read by a small interpreter for the
// subset of JSON Schema it uses), then the rules a schema can't express (unique ids, free keys, a known start view, …).
// Pure: no DOM, no fetch, so the viewer and `npm run validate-site` share it. Issues carry a path into the manifest,
// e.g. `viewpoints[2].at`, so a message points at the line to fix.
import schema from '../../schema/site.schema.json' with { type: 'json' };
import { MANIFEST_VERSION, type SiteManifest } from './manifest.ts';
import { CORE_KEYS } from '../core/plugin/keys.ts';
import { BUILTIN_PLUGINS, pluginKeys } from '../plugins/registry.ts';
import { isExternalSection, PLUGIN_ID } from './external.ts';

export interface Issue {
  /** where in the manifest, e.g. 'layers[1].key' ('' = the whole manifest) */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

type SchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';

/** the JSON Schema subset the manifest (and the plugins' file) schemas use */
export interface Schema {
  $ref?: string;
  /** one type, or several (a string or an array of them) */
  type?: SchemaType | SchemaType[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  $defs?: Record<string, Schema>;
}

const ROOT = schema as Schema;

/** Keys a site layer can't take: the core's (movement, view, help) and those of the plugins the manifest enables
 * (each built-in plugin declares its letters in src/plugins/registry.ts; the key registry reports any it doesn't). */
export function reservedKeys(m: Pick<SiteManifest, 'plugins'>): Set<string> {
  const ids = Object.keys(m.plugins || {});
  if (m.plugins?.['home-assistant']) ids.push('lights'); // Home Assistant starts the lights plugin too
  return new Set([...CORE_KEYS, ...pluginKeys(ids), ...Object.values(externalKeys(m)).flat()]);
}

/** the keys external plugins' sections declare (`plugins.<id>.keys`), by id */
export function externalKeys(m: Pick<SiteManifest, 'plugins'>): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries((m.plugins || {}) as Record<string, unknown>)
      .filter(([id, s]) => isExternalSection(s) && !Object.hasOwn(BUILTIN_PLUGINS, id) && Array.isArray(s.keys))
      .map(([id, s]) => [id, (s as { keys: string[] }).keys]),
  );
}

/** the layers with built-in behaviour (X cutaway hides roof and ceiling, U hides roofs, O toggles doors) */
export const BUILTIN_LAYERS = ['roof', 'ceiling', 'door'] as const;

const join = (path: string, key: string | number): string =>
  typeof key === 'number'
    ? `${path}[${key}]`
    : /^[A-Za-z_$][\w$]*$/.test(key)
      ? path
        ? `${path}.${key}`
        : key
      : `${path}[${JSON.stringify(key)}]`;

const typeName = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? 'an object' : `a ${typeof v}`;

function resolveRef(ref: string, root: Schema): Schema {
  const m = /^#\/\$defs\/(.+)$/.exec(ref);
  const s = m && root.$defs?.[m[1]];
  if (!s) throw new Error(`schema: unknown $ref ${ref}`);
  return s;
}

const isType = (v: unknown, t: SchemaType): boolean =>
  t === 'object'
    ? typeof v === 'object' && v !== null && !Array.isArray(v)
    : t === 'array'
      ? Array.isArray(v)
      : t === 'number'
        ? typeof v === 'number' && Number.isFinite(v)
        : t === 'integer'
          ? typeof v === 'number' && Number.isInteger(v)
          : typeof v === t;
const TYPE_NAME: Record<SchemaType, string> = {
  object: 'an object',
  array: 'an array',
  string: 'a string',
  number: 'a number',
  integer: 'a whole number',
  boolean: 'true or false',
};

/** Validate `value` against a schema node, appending to `out`. `root` holds the $defs ($ref: '#/$defs/<name>'). */
export function checkSchema(
  value: unknown,
  node: Schema = ROOT,
  path = '',
  out: Issue[] = [],
  root: Schema = ROOT,
): Issue[] {
  const s = node.$ref ? { ...resolveRef(node.$ref, root), ...node, $ref: undefined } : node;
  const err = (message: string) => out.push({ path, message });
  if (Array.isArray(s.type)) {
    if (!s.type.some((t) => isType(value, t)))
      return (err(`expected ${s.type.map((t) => TYPE_NAME[t]).join(' or ')}, got ${typeName(value)}`), out);
  } else
    switch (s.type) {
      case 'object':
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          return (err(`expected an object, got ${typeName(value)}`), out);
        break;
      case 'array':
        if (!Array.isArray(value)) return (err(`expected an array, got ${typeName(value)}`), out);
        break;
      case 'string':
        if (typeof value !== 'string') return (err(`expected a string, got ${typeName(value)}`), out);
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value))
          return (err(`expected a number, got ${typeName(value)}`), out);
        break;
      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value))
          return (err(`expected a whole number, got ${JSON.stringify(value)}`), out);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') return (err(`expected true or false, got ${typeName(value)}`), out);
        break;
    }
  if (s.const !== undefined && value !== s.const)
    err(`must be ${JSON.stringify(s.const)}, got ${JSON.stringify(value)}`);
  if (s.enum && !s.enum.includes(value))
    err(`must be one of ${s.enum.map((x) => JSON.stringify(x)).join(', ')}, got ${JSON.stringify(value)}`);
  if (typeof value === 'string') {
    if (s.minLength !== undefined && value.length < s.minLength)
      err(s.minLength === 1 ? 'must not be empty' : `must be at least ${s.minLength} characters`);
    if (s.maxLength !== undefined && value.length > s.maxLength) err(`must be at most ${s.maxLength} characters`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(value))
      err(`${JSON.stringify(value)} doesn't match ${s.pattern}`);
  }
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) err(`must be ≥ ${s.minimum}, got ${value}`);
    if (s.maximum !== undefined && value > s.maximum) err(`must be ≤ ${s.maximum}, got ${value}`);
    if (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum)
      err(`must be > ${s.exclusiveMinimum}, got ${value}`);
    if (s.exclusiveMaximum !== undefined && value >= s.exclusiveMaximum)
      err(`must be < ${s.exclusiveMaximum}, got ${value}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems)
      err(
        s.minItems === s.maxItems
          ? `expected ${s.minItems} items, got ${value.length}`
          : `expected at least ${s.minItems} item${s.minItems > 1 ? 's' : ''}, got ${value.length}`,
      );
    else if (s.maxItems !== undefined && value.length > s.maxItems)
      err(
        s.minItems === s.maxItems
          ? `expected ${s.maxItems} items, got ${value.length}`
          : `expected at most ${s.maxItems} items, got ${value.length}`,
      );
    if (s.items) value.forEach((v, i) => checkSchema(v, s.items, join(path, i), out, root));
  }
  if (isType(value, 'object') && (s.type === 'object' || (Array.isArray(s.type) && s.type.includes('object')))) {
    const obj = value as Record<string, unknown>;
    for (const k of s.required || []) if (!(k in obj)) out.push({ path: join(path, k), message: 'is required' });
    for (const [k, v] of Object.entries(obj)) {
      const p = s.properties?.[k];
      if (p) checkSchema(v, p, join(path, k), out, root);
      else if (s.additionalProperties === false) {
        const known = Object.keys(s.properties || {});
        const near = known.find((x) => x.toLowerCase() === k.toLowerCase());
        out.push({
          path: join(path, k),
          message: `unknown field${near ? ` (did you mean "${near}"?)` : known.length ? ` (expected one of: ${known.join(', ')})` : ''}`,
        });
      } else if (typeof s.additionalProperties === 'object')
        checkSchema(v, s.additionalProperties, join(path, k), out, root);
    }
  }
  return out;
}

function compiles(re: string): string | null {
  try {
    new RegExp(re);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** The rules beyond the schema. Assumes the manifest passed the schema. */
export function checkRules(m: SiteManifest): ValidationResult {
  const errors: Issue[] = [],
    warnings: Issue[] = [];
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: m.geo.timeZone });
  } catch {
    errors.push({ path: 'geo.timeZone', message: `unknown time zone ${JSON.stringify(m.geo.timeZone)}` });
  }
  if (m.startView !== undefined && m.startView > m.viewpoints.length)
    errors.push({ path: 'startView', message: `there are only ${m.viewpoints.length} viewpoints` });

  // layers: unique ids and keys, keys free
  const layers = m.layers || [];
  const ids = new Map<string, number>(),
    keys = new Map<string, number>();
  const reserved = reservedKeys(m);
  layers.forEach((l, i) => {
    if (ids.has(l.id))
      errors.push({ path: `layers[${i}].id`, message: `"${l.id}" is already layers[${ids.get(l.id)}]` });
    ids.set(l.id, i);
    if (!l.key) return;
    if (reserved.has(l.key))
      errors.push({
        path: `layers[${i}].key`,
        message: `${l.key} is one of the viewer's own keys (${[...reserved].sort().join(' ')})`,
      });
    else if (keys.has(l.key))
      errors.push({ path: `layers[${i}].key`, message: `${l.key} is already layers[${keys.get(l.key)}]'s key` });
    keys.set(l.key, i);
    if ((l.id === 'roof' || l.id === 'ceiling') && l.key)
      warnings.push({
        path: `layers[${i}].key`,
        message: `the ${l.id} layer goes with X (cutaway); its own key is ignored`,
      });
  });
  layers.forEach((l, i) => {
    if (!(BUILTIN_LAYERS as readonly string[]).includes(l.id) && !l.label && !l.key)
      warnings.push({ path: `layers[${i}]`, message: `layer "${l.id}" has no key and no label: nothing toggles it` });
  });

  // extra models: unique ids, their layer declared
  const extraIds = new Set<string>();
  (m.models.extra || []).forEach((x, i) => {
    if (extraIds.has(x.id) || x.id === 'main')
      errors.push({ path: `models.extra[${i}].id`, message: `"${x.id}" is taken` });
    extraIds.add(x.id);
    if (x.layer && !ids.has(x.layer))
      errors.push({ path: `models.extra[${i}].layer`, message: `no layer "${x.layer}" in layers` });
  });

  // storeys: in order, the first at the bottom
  const st = m.storeys || [];
  for (let i = 1; i < st.length; i++) {
    if (st[i].z <= st[i - 1].z)
      errors.push({ path: `storeys[${i}].z`, message: 'storeys go from the bottom up: each z above the one before' });
    const from = st[i].from ?? st[i].z;
    if (from <= (st[i - 1].from ?? st[i - 1].z))
      errors.push({ path: `storeys[${i}].from`, message: "must be above the storey below's" });
  }

  const p = m.plugins || {};
  for (const [path, re] of [
    ['plugins.lights.emitterHints', p.lights?.emitterHints],
    ['plugins["home-assistant"].emitterHints', p['home-assistant']?.emitterHints],
    ['plugins.switches.boxIdPattern', p.switches?.boxIdPattern],
  ] as const) {
    const bad = re && compiles(re);
    if (bad) errors.push({ path, message: `not a regular expression: ${bad}` });
  }
  for (const k of ['map', 'emitterHints'] as const)
    if (p['home-assistant']?.[k])
      warnings.push({
        path: `plugins["home-assistant"].${k}`,
        message: p.lights
          ? `ignored: plugins.lights has its own`
          : `moved to plugins.lights.${k} (read from here for now)`,
      });
  // the features read the entity store, which a connector fills (Home Assistant is the one that ships)
  for (const f of ['faults', 'lights', 'energy'] as const)
    if (p[f] && !p['home-assistant'])
      warnings.push({
        path: `plugins.${f}`,
        message: `the ${f} plugin reads live states from a connector (home-assistant); without one it shows nothing live`,
      });
  if (p['home-assistant'] && !p['home-assistant'].url)
    warnings.push({
      path: 'plugins["home-assistant"].url',
      message: 'no URL: only ?ha=mock will work',
    });

  // external plugins' declared keys: free of the core's, the built-in plugins' and each other's (the site's layers are
  // checked against them above, through reservedKeys)
  const builtinIds = Object.keys(p);
  if (p['home-assistant']) builtinIds.push('lights');
  const taken = new Map<string, string>([
    ...CORE_KEYS.map((k) => [k, "the viewer's"] as [string, string]),
    ...pluginKeys(builtinIds).map((k) => [k, "a built-in plugin's"] as [string, string]),
  ]);
  for (const [id, ks] of Object.entries(externalKeys(m)))
    ks.forEach((k, i) => {
      const who = taken.get(k);
      if (who) errors.push({ path: `${join(join('plugins', id), 'keys')}[${i}]`, message: `${k} is already ${who}` });
      else taken.set(k, `plugins.${id}'s`);
    });

  // external plugins: an absolute module URL on an origin pluginOrigins doesn't list loads only from the viewer's own
  const origins = m.pluginOrigins || [];
  origins.forEach((o, i) => {
    if (new URL(o).origin !== o)
      errors.push({ path: `pluginOrigins[${i}]`, message: `not an origin (did you mean "${new URL(o).origin}"?)` });
  });
  // (resolved against a stand-in for the manifest's own URL, so '//host/x.js' and '\\host\x.js' count as elsewhere)
  const here = 'https://manifest.invalid/site.json';
  for (const [id, section] of Object.entries(p as Record<string, unknown>)) {
    if (!isExternalSection(section) || typeof section.module !== 'string') continue;
    let origin: string;
    try {
      origin = new URL(section.module, here).origin;
    } catch {
      errors.push({
        path: join(join('plugins', id), 'module'),
        message: `not a URL: ${JSON.stringify(section.module)}`,
      });
      continue;
    }
    if (origin === new URL(here).origin) continue; // the manifest's origin
    if (!/^https?:/.test(new URL(section.module, here).protocol)) {
      errors.push({ path: join(join('plugins', id), 'module'), message: 'only an http(s) URL loads' });
      continue;
    }
    if (!origins.includes(origin))
      warnings.push({
        path: join(join('plugins', id), 'module'),
        message: `${origin} isn't in pluginOrigins: the module loads only if the viewer is served from there`,
      });
  }
  return { ok: !errors.length, errors, warnings };
}

/** the built-in plugins' sections the schema describes */
const SECTIONS: readonly string[] = Object.keys(ROOT.properties?.plugins?.properties || {});
/** the plugin sections this build knows: the schema's, and the built-in plugins (sun has no section of its own) */
export const KNOWN_PLUGINS: readonly string[] = [...new Set([...SECTIONS, ...Object.keys(BUILTIN_PLUGINS)])];

/** edit distance, for "did you mean" (small strings only) */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * A plugins section this build doesn't know (written for a newer viewer, or a plugin that isn't built in) is a
 * warning, not an error: the plugin is skipped and the rest of the site loads. A typo inside a known plugin's section
 * is still an error (the schema). A section with a `module` is an external plugin's: it stays, for the schema to check
 * its `module` (the rest is the plugin's own), as long as its id is one a built-in plugin doesn't have. Returns the
 * manifest without the skipped sections, and the issues.
 */
function splitUnknownPlugins(value: unknown): { value: unknown; errors: Issue[]; warnings: Issue[] } {
  const v = value as { plugins?: unknown } | null;
  const p = v?.plugins;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { value, errors: [], warnings: [] };
  const errors: Issue[] = [],
    warnings: Issue[] = [];
  const drop = new Set<string>();
  for (const [k, section] of Object.entries(p)) {
    const known = KNOWN_PLUGINS.includes(k);
    if (isExternalSection(section)) {
      if (known) {
        // a warning, so a site keeps loading when a new release adds a built-in plugin of the same name
        warnings.push({
          path: join(join('plugins', k), 'module'),
          message: `"${k}" is a built-in plugin's id: this external plugin is skipped (give it an id of its own)`,
        });
        drop.add(k);
      } else if (!PLUGIN_ID.test(k)) {
        errors.push({
          path: join('plugins', k),
          message: `an external plugin's id is lower-case letters, digits and '-', starting with a letter`,
        });
        drop.add(k);
      }
      continue;
    }
    if (known && !SECTIONS.includes(k)) {
      // a built-in plugin with no section (sun starts on its own)
      errors.push({ path: join('plugins', k), message: `unknown field (the ${k} plugin takes no section)` });
      drop.add(k);
    }
    if (known) continue;
    drop.add(k);
    // a near miss of a known plugin ('Pins', 'light') is a typo: an error, as a typo in a known field is
    const near = KNOWN_PLUGINS.find(
      (x) => x.toLowerCase() === k.toLowerCase() || (k.length >= 4 && distance(x, k.toLowerCase()) <= 1),
    );
    if (near) errors.push({ path: join('plugins', k), message: `unknown plugin (did you mean "${near}"?)` });
    else
      warnings.push({
        path: join('plugins', k),
        message: `site config for plugin '${k}', which this build doesn't have: skipped`,
      });
  }
  if (!drop.size) return { value, errors, warnings };
  const kept = Object.fromEntries(Object.entries(p).filter(([k]) => !drop.has(k)));
  return { value: { ...v, plugins: kept }, errors, warnings };
}

/** Schema, then rules. `value` is the parsed JSON. A plugins section this build doesn't know is only a warning. */
export function validateManifest(value: unknown): ValidationResult {
  const split = splitUnknownPlugins(value);
  const errors = [...split.errors, ...checkSchema(split.value)];
  if (!errors.length && (value as { jarvis?: string }).jarvis !== MANIFEST_VERSION)
    errors.push({ path: 'jarvis', message: `this viewer reads ${MANIFEST_VERSION}` });
  if (errors.length) return { ok: false, errors, warnings: split.warnings };
  const r = checkRules(split.value as SiteManifest);
  return { ...r, warnings: [...split.warnings, ...r.warnings] };
}

/** one line per issue: "layers[1].key: K is …" */
export const formatIssues = (issues: Issue[]): string[] =>
  issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
