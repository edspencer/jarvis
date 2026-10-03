// Checks a site manifest: first against its JSON Schema (schema/site.schema.json, read by a small interpreter for the
// subset of JSON Schema it uses), then the rules a schema can't express (unique ids, free keys, a known start view, …).
// Pure: no DOM, no fetch, so the viewer and `npm run validate-site` share it. Issues carry a path into the manifest,
// e.g. `viewpoints[2].at`, so a message points at the line to fix.
import schema from '../../schema/site.schema.json' with { type: 'json' };
import { MANIFEST_VERSION, type SiteManifest } from './manifest.ts';

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

/** the JSON Schema subset the manifest schema uses */
interface Schema {
  $ref?: string;
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
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

/** keys the viewer and its built-in plugins use; a site layer can't take them */
export const RESERVED_KEYS = new Set([...'WASDQECXUBGHVTLP']);

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

function resolveRef(ref: string): Schema {
  const m = /^#\/\$defs\/(.+)$/.exec(ref);
  const s = m && ROOT.$defs?.[m[1]];
  if (!s) throw new Error(`schema: unknown $ref ${ref}`);
  return s;
}

/** Validate `value` against a schema node, appending to `out`. */
export function checkSchema(value: unknown, node: Schema = ROOT, path = '', out: Issue[] = []): Issue[] {
  const s = node.$ref ? { ...resolveRef(node.$ref), ...node, $ref: undefined } : node;
  const err = (message: string) => out.push({ path, message });
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
    if (s.items) value.forEach((v, i) => checkSchema(v, s.items, join(path, i), out));
  }
  if (s.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const k of s.required || []) if (!(k in obj)) out.push({ path: join(path, k), message: 'is required' });
    for (const [k, v] of Object.entries(obj)) {
      const p = s.properties?.[k];
      if (p) checkSchema(v, p, join(path, k), out);
      else if (s.additionalProperties === false) {
        const known = Object.keys(s.properties || {});
        const near = known.find((x) => x.toLowerCase() === k.toLowerCase());
        out.push({
          path: join(path, k),
          message: `unknown field${near ? ` (did you mean "${near}"?)` : known.length ? ` (expected one of: ${known.join(', ')})` : ''}`,
        });
      } else if (typeof s.additionalProperties === 'object') checkSchema(v, s.additionalProperties, join(path, k), out);
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
  layers.forEach((l, i) => {
    if (ids.has(l.id))
      errors.push({ path: `layers[${i}].id`, message: `"${l.id}" is already layers[${ids.get(l.id)}]` });
    ids.set(l.id, i);
    if (!l.key) return;
    if (RESERVED_KEYS.has(l.key))
      errors.push({
        path: `layers[${i}].key`,
        message: `${l.key} is one of the viewer's own keys (${[...RESERVED_KEYS].join(' ')})`,
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
    ['plugins["home-assistant"].emitterHints', p['home-assistant']?.emitterHints],
    ['plugins.switches.boxIdPattern', p.switches?.boxIdPattern],
  ] as const) {
    const bad = re && compiles(re);
    if (bad) errors.push({ path, message: `not a regular expression: ${bad}` });
  }
  if (p.faults && !p['home-assistant'])
    warnings.push({
      path: 'plugins.faults',
      message: 'the faults layer needs the home-assistant plugin; it will stay off',
    });
  if (p['home-assistant'] && !p['home-assistant'].url)
    warnings.push({
      path: 'plugins["home-assistant"].url',
      message: 'no URL: only ?ha=mock will work',
    });
  return { ok: !errors.length, errors, warnings };
}

/** Schema, then rules. `value` is the parsed JSON. */
export function validateManifest(value: unknown): ValidationResult {
  const errors = checkSchema(value);
  if (!errors.length && (value as { jarvis?: string }).jarvis !== MANIFEST_VERSION)
    errors.push({ path: 'jarvis', message: `this viewer reads ${MANIFEST_VERSION}` });
  if (errors.length) return { ok: false, errors, warnings: [] };
  return checkRules(value as SiteManifest);
}

/** one line per issue: "layers[1].key: K is …" */
export const formatIssues = (issues: Issue[]): string[] =>
  issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));
