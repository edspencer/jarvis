// The assistant's Home Assistant policy: which service calls it may make on its own, which need the person to say yes
// first, and which it never makes (docs/design/voice-assistant.md §5.3). The model's only way to change anything is
// ha_act, and ha_act goes through the gate (gate.ts), which asks evaluatePolicy() before anything reaches HA. So this
// file is the safety boundary, and it is written to fail closed:
//   - the policy is data (the site's YAML, parsed outside core into a plain object) and parsePolicy() is strict:
//     unknown keys, bad values or a `default` other than deny are errors, never warnings, so a typo can't widen it;
//   - every entity of a call is matched against the rules on its own (first matching rule wins); no rule → deny;
//   - a call's tier is the strictest of its entities' (deny > confirm > allow), and one deny refuses the whole call;
//   - an allow or confirm rule must name its services (never '*') and a domain or entity;
//   - data keys must be named by the matching rule: numbers inside `bounds` (out of range → refused, never clamped)
//     or strings/booleans in `data`; anything else (including `entity_id`, or a `confirmed: true` a model might try)
//     is refused;
//   - each entity's domain is its own id's: a service is always called within that domain, so the generic
//     `homeassistant.*` services (which act on any domain) can't be expressed at all;
//   - an entity HA doesn't know is refused (its device_class, which rules may match on, would be unknown).
// Pure functions: the gate supplies the states, the clock and the side effects.
//
// TODO (design §11, not decided): per-person rules (`who: admin`, needs the HA user from hello), area matching (needs
// HA's area registry; attributes.area is only the mock's), and what the actual default policy says (§11.2) — see
// server/policy.example.yaml for an example only.
import type { ActRequest, HaState, Tier } from './types.ts';
import type { Surface } from './protocol.ts';

// ------------------------------------------------------------------------------------------------ the model

/** what a rule matches; every present key must match (AND), a list matches any of its items */
export interface Matcher {
  domain?: string[];
  /** entity ids, `*` globs allowed ('switch.*network*') */
  entity?: string[];
  /** service names, or '*' for any (deny rules only); required on allow and confirm rules */
  service?: string[];
  /** the entity's attributes.device_class */
  device_class?: string[];
  surface?: Surface[];
}

export interface Rule {
  tier: Tier;
  match: Matcher;
  /** shown when the rule refuses (or asks) */
  reason?: string;
  /** numeric data keys and their inclusive [min, max] */
  bounds: Readonly<Record<string, readonly [number, number]>>;
  /** data keys allowed without bounds (string or boolean values) */
  data: readonly string[];
  /** a timed run: the request may carry data.minutes (0 < m ≤ max_minutes, default max_minutes) and the gate turns it
   * off afterwards */
  max_minutes?: number;
  risk: 'normal' | 'high';
  /** 'rules[3]', for messages and the audit log */
  at: string;
}

export interface Policy {
  version: 1;
  default: 'deny';
  /** a call on more than this many entities needs confirmation even when each is allowed */
  bulk: { confirm_over: number } | null;
  rules: readonly Rule[];
  /** where it came from (a file name), for messages */
  source?: string;
}

/** the policy when there is no policy file: everything is refused */
export const EMPTY_POLICY: Policy = Object.freeze({
  version: 1,
  default: 'deny',
  bulk: null,
  rules: Object.freeze([]) as readonly Rule[],
  source: '(no policy)',
}) as Policy;

/** a timed service and the one that ends it: the gate calls the second when max_minutes runs out */
export const OFF_SERVICE: Readonly<Record<string, string>> = Object.freeze({
  turn_on: 'turn_off',
  open_valve: 'close_valve',
  open_cover: 'close_cover',
  start: 'stop', // vacuum, lawn_mower
  start_mowing: 'dock',
});

const OFF_SERVICES: ReadonlySet<string> = new Set(Object.values(OFF_SERVICE));

/** most entities one call may name */
export const MAX_ENTITIES = 50;

export const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;
export const SERVICE = /^[a-z_]+$/;
const DOMAIN = /^[a-z_]+$/;
const ENTITY_GLOB = /^[a-z_*]+\.[a-z0-9_*]+$/;
const DATA_KEY = /^[a-z_][a-z0-9_]*$/;
/** keys a rule may not name in bounds/data: the target is never data, and minutes belongs to max_minutes */
const RESERVED_DATA = new Set(['entity_id', 'device_id', 'area_id', 'floor_id', 'label_id', 'minutes']);

export const domainOf = (entityId: string): string => entityId.split('.')[0];

// ------------------------------------------------------------------------------------------------ parsing

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const TOP_KEYS = new Set(['version', 'default', 'bulk', 'rules']);
const TIERS: readonly Tier[] = ['allow', 'confirm', 'deny'];
const RULE_KEYS = new Set([...TIERS, 'reason', 'bounds', 'data', 'max_minutes', 'risk']);
const MATCH_KEYS = new Set(['domain', 'entity', 'service', 'device_class', 'surface']);

/** Validate an already-parsed policy (the YAML file's object) and build the Policy. Throws one Error listing every
 * problem with its path (`rules[3].confirm.servce: unknown key`). `null`/`undefined` (an empty file) is EMPTY_POLICY. */
export function parsePolicy(obj: unknown, source?: string): Policy {
  const errs: string[] = [];
  const err = (path: string, msg: string) => errs.push(`${path}: ${msg}`);
  if (obj === null || obj === undefined) return { ...EMPTY_POLICY, source: source ?? EMPTY_POLICY.source };
  if (!isObj(obj)) throw new Error(`${source ?? 'policy'}: the policy must be a mapping`);

  for (const k of Object.keys(obj)) if (!TOP_KEYS.has(k)) err(k, 'unknown key');
  if (obj.version !== 1) err('version', `must be 1 (got ${JSON.stringify(obj.version)})`);
  if (obj.default !== undefined && obj.default !== 'deny')
    err('default', `must be deny, the only accepted default (got ${JSON.stringify(obj.default)})`);

  let bulk: Policy['bulk'] = null;
  if (obj.bulk !== undefined) {
    if (!isObj(obj.bulk)) err('bulk', 'must be a mapping { confirm_over: N }');
    else {
      for (const k of Object.keys(obj.bulk)) if (k !== 'confirm_over') err(`bulk.${k}`, 'unknown key');
      const n = obj.bulk.confirm_over;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) err('bulk.confirm_over', 'must be an integer ≥ 1');
      else bulk = { confirm_over: n };
    }
  }

  const rules: Rule[] = [];
  if (obj.rules !== undefined && !Array.isArray(obj.rules)) err('rules', 'must be a list');
  const list = Array.isArray(obj.rules) ? obj.rules : [];
  list.forEach((r, i) => {
    const rule = parseRule(r, `rules[${i}]`, err);
    if (rule) rules.push(rule);
  });

  if (errs.length) throw new Error(`invalid policy${source ? ` ${source}` : ''}:\n  ${errs.join('\n  ')}`);
  return { version: 1, default: 'deny', bulk, rules, source };
}

function parseRule(r: unknown, at: string, err: (path: string, msg: string) => void): Rule | null {
  if (!isObj(r)) {
    err(at, 'must be a mapping with one of allow / confirm / deny');
    return null;
  }
  let ok = true;
  const bad = (path: string, msg: string) => {
    ok = false;
    err(path, msg);
  };
  for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) bad(`${at}.${k}`, 'unknown key');
  const tiers = TIERS.filter((t) => Object.hasOwn(r, t));
  if (tiers.length !== 1) {
    bad(
      at,
      tiers.length ? `has ${tiers.join(' and ')}: exactly one tier per rule` : 'needs one of allow / confirm / deny',
    );
    if (!tiers.length) return null;
  }
  const tier = tiers[0];
  const match = parseMatcher(r[tier], `${at}.${tier}`, tier, bad);

  if (r.reason !== undefined && (typeof r.reason !== 'string' || !r.reason.trim()))
    bad(`${at}.reason`, 'must be a non-empty string');
  if (r.risk !== undefined && r.risk !== 'high' && r.risk !== 'normal') bad(`${at}.risk`, 'must be high or normal');

  const bounds: Record<string, [number, number]> = {};
  if (r.bounds !== undefined) {
    if (!isObj(r.bounds)) bad(`${at}.bounds`, 'must be a mapping of data key → [min, max]');
    else
      for (const [k, v] of Object.entries(r.bounds)) {
        const p = `${at}.bounds.${k}`;
        if (!DATA_KEY.test(k)) bad(p, 'not a data key');
        else if (RESERVED_DATA.has(k)) bad(p, `${k} can't be service data here`);
        if (
          !Array.isArray(v) ||
          v.length !== 2 ||
          !v.every((x) => typeof x === 'number' && Number.isFinite(x)) ||
          (v[0] as number) > (v[1] as number)
        )
          bad(p, 'must be [min, max], two numbers with min ≤ max');
        else bounds[k] = [v[0], v[1]];
      }
  }
  const data: string[] = [];
  if (r.data !== undefined) {
    if (!Array.isArray(r.data)) bad(`${at}.data`, 'must be a list of data keys');
    else
      r.data.forEach((k, j) => {
        const p = `${at}.data[${j}]`;
        if (typeof k !== 'string' || !DATA_KEY.test(k)) bad(p, 'not a data key');
        else if (RESERVED_DATA.has(k)) bad(p, `${k} can't be service data here`);
        else if (Object.hasOwn(bounds, k)) bad(p, `${k} is already in bounds`);
        else data.push(k);
      });
  }
  if (r.max_minutes !== undefined) {
    const m = r.max_minutes;
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) bad(`${at}.max_minutes`, 'must be a number > 0');
    if (tier === 'deny') bad(`${at}.max_minutes`, 'means nothing on a deny rule');
    const timed = (match?.service ?? []).filter((s) => s !== '*' && !OFF_SERVICE[s] && !OFF_SERVICES.has(s));
    if (timed.length) bad(`${at}.max_minutes`, `${timed.join(', ')} can't be timed (no matching off service)`);
  }
  if (tier === 'deny' && (r.bounds !== undefined || r.data !== undefined))
    bad(at, 'bounds and data mean nothing on a deny rule');
  if (!ok || !match) return null;
  return {
    tier,
    match,
    reason: typeof r.reason === 'string' ? r.reason.trim() : undefined,
    bounds,
    data,
    max_minutes: typeof r.max_minutes === 'number' ? r.max_minutes : undefined,
    risk: r.risk === 'high' ? 'high' : 'normal',
    at,
  };
}

function parseMatcher(m: unknown, at: string, tier: Tier, bad: (path: string, msg: string) => void): Matcher | null {
  if (!isObj(m)) {
    bad(at, 'must be a mapping of domain / entity / service / device_class / surface');
    return null;
  }
  const out: Matcher = {};
  const strings = (k: string, test: (s: string) => boolean, what: string): string[] | undefined => {
    const v = m[k];
    if (v === undefined) return undefined;
    const items = Array.isArray(v) ? v : [v];
    if (!items.length) bad(`${at}.${k}`, 'empty list');
    const good: string[] = [];
    items.forEach((x, j) => {
      const p = Array.isArray(v) ? `${at}.${k}[${j}]` : `${at}.${k}`;
      if (typeof x !== 'string' || !test(x)) bad(p, `${JSON.stringify(x)} is not ${what}`);
      else good.push(x);
    });
    return good;
  };
  for (const k of Object.keys(m)) if (!MATCH_KEYS.has(k)) bad(`${at}.${k}`, 'unknown key');
  out.domain = strings('domain', (s) => DOMAIN.test(s), 'a domain');
  out.entity = strings('entity', (s) => ENTITY_GLOB.test(s), 'an entity id or glob');
  out.service = strings('service', (s) => s === '*' || SERVICE.test(s), "a service name or '*'");
  out.device_class = strings('device_class', (s) => DOMAIN.test(s), 'a device class');
  out.surface = strings('surface', (s) => s === 'screen' || s === 'speaker', 'screen or speaker') as
    Surface[] | undefined;
  for (const k of Object.keys(out) as (keyof Matcher)[]) if (out[k] === undefined) delete out[k];
  // a rule that lets something happen must say which entities: `allow: { service: turn_on }` would reach every domain;
  // and which services: `allow: { domain: script }` would run any script with any service, so `service` is required
  // and names services (`'*'` is for deny rules only)
  if (tier !== 'deny') {
    const a = `${tier === 'allow' ? 'an' : 'a'} ${tier} rule`;
    if (!out.domain && !out.entity) bad(at, `${a} needs a domain or an entity`);
    if (!out.service) bad(at, `${a} needs a service (name the services it lets through)`);
    else if (out.service.includes('*')) bad(`${at}.service`, `'*' is only allowed on a deny rule; name the services`);
  } else if (!Object.keys(m).length) bad(at, 'empty matcher (it would match everything)');
  return out;
}

// ------------------------------------------------------------------------------------------------ matching

const globCache = new Map<string, RegExp>();
/** `*` matches any run of characters (including none); nothing else is special */
export function globMatch(glob: string, s: string): boolean {
  let re = globCache.get(glob);
  if (!re) {
    re = new RegExp(`^${glob.split('*').map(escapeRe).join('.*')}$`);
    globCache.set(glob, re);
  }
  return re.test(s);
}
const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** does rule matcher `m` match this entity, service and surface? */
export function matches(m: Matcher, entityId: string, service: string, surface: Surface, state?: HaState): boolean {
  if (m.domain && !m.domain.includes(domainOf(entityId))) return false;
  if (m.entity && !m.entity.some((g) => globMatch(g, entityId))) return false;
  if (m.service && !m.service.some((s) => s === '*' || s === service)) return false;
  if (m.surface && !m.surface.includes(surface)) return false;
  if (m.device_class) {
    const dc = state?.attributes?.device_class;
    if (typeof dc !== 'string' || !m.device_class.includes(dc)) return false;
  }
  return true;
}

/** the first rule matching this entity (or undefined: default deny) */
export function firstRule(
  policy: Policy,
  entityId: string,
  service: string,
  surface: Surface,
  state?: HaState,
): Rule | undefined {
  return policy.rules.find((r) => matches(r.match, entityId, service, surface, state));
}

// ------------------------------------------------------------------------------------------------ evaluation

/** one entity's decision */
export interface EntityDecision {
  entity_id: string;
  tier: Tier;
  /** why (for deny: the refusal) */
  reason: string;
  rule?: Rule;
  /** minutes until the gate turns it off again (max_minutes rules) */
  minutes?: number;
}

/** one call to Home Assistant */
export interface PlannedCall {
  domain: string;
  service: string;
  data: { entity_id: string[] } & Record<string, unknown>;
}

/** an off call the gate schedules after a timed run */
export interface PlannedTimer {
  minutes: number;
  domain: string;
  service: string;
  entity_ids: string[];
}

export interface Evaluation {
  tier: Tier;
  /** for deny: the refusal; for confirm: why it asks; for allow: which rules allowed it */
  reason: string;
  risk: 'normal' | 'high';
  entities: EntityDecision[];
  /** the calls to make (empty when denied): one per domain, data without `minutes` */
  calls: PlannedCall[];
  timers: PlannedTimer[];
}

/** what the evaluation needs to know besides the policy */
export interface EvalContext {
  surface: Surface;
  /** current states of (at least) the request's entities */
  states: ReadonlyMap<string, HaState> | Readonly<Record<string, HaState | undefined>>;
}

const deny = (reason: string, entities: EntityDecision[] = []): Evaluation => ({
  tier: 'deny',
  reason,
  risk: 'normal',
  entities,
  calls: [],
  timers: [],
});

/** null if the request is well formed, else why not (checked before any rule) */
export function requestProblem(req: unknown): string | null {
  if (!isObj(req)) return 'the request must be an object';
  const ids = req.entity_ids;
  if (!Array.isArray(ids) || !ids.length) return 'no entity_ids';
  if (ids.length > MAX_ENTITIES) return `too many entities in one call (${ids.length} > ${MAX_ENTITIES})`;
  const badId = ids.find((e) => typeof e !== 'string' || !ENTITY_ID.test(e));
  if (badId !== undefined) return `${JSON.stringify(badId)} is not an entity id`;
  const dup = ids.find((e, i) => ids.indexOf(e) !== i);
  if (dup !== undefined) return `${dup} is named twice`;
  if (typeof req.service !== 'string' || !SERVICE.test(req.service))
    return `${JSON.stringify(req.service)} is not a service name`;
  if (req.data !== undefined && !isObj(req.data)) return 'data must be an object';
  const data = (req.data ?? {}) as Record<string, unknown>;
  for (const k of ['entity_id', 'device_id', 'area_id', 'floor_id', 'label_id'])
    if (Object.hasOwn(data, k)) return `${k} in data is not allowed (name entities in entity_ids)`;
  for (const k of Object.keys(req)) if (!['entity_ids', 'service', 'data'].includes(k)) return `unknown field ${k}`;
  return null;
}

const getState = (states: EvalContext['states'], id: string): HaState | undefined =>
  states instanceof Map ? states.get(id) : (states as Record<string, HaState | undefined>)[id];

/** Decide a request. Pure: the same policy, request, surface and states give the same answer. */
export function evaluatePolicy(policy: Policy, req: ActRequest, ctx: EvalContext): Evaluation {
  const problem = requestProblem(req);
  if (problem) return deny(problem);
  const { service } = req;
  const data: Record<string, unknown> = { ...(req.data ?? {}) };
  const hasMinutes = Object.hasOwn(data, 'minutes');
  const minutesAsked = data.minutes;
  delete data.minutes;

  const entities: EntityDecision[] = req.entity_ids.map((id) => {
    const state = getState(ctx.states, id);
    if (!state) return { entity_id: id, tier: 'deny', reason: `${id} is not a known entity` };
    const rule = firstRule(policy, id, service, ctx.surface, state);
    if (!rule) return { entity_id: id, tier: 'deny', reason: `no rule allows ${id} ${service}` };
    if (rule.tier === 'deny')
      return { entity_id: id, tier: 'deny', reason: rule.reason ?? `${id} ${service} is refused (${rule.at})`, rule };
    const refusal = dataProblem(rule, id, service, data);
    if (refusal) return { entity_id: id, tier: 'deny', reason: refusal, rule };
    const timed = timing(rule, id, service, hasMinutes, minutesAsked);
    if ('refused' in timed) return { entity_id: id, tier: 'deny', reason: timed.refused, rule };
    const why = rule.reason ?? (rule.tier === 'confirm' ? `${id} ${service} needs confirmation (${rule.at})` : rule.at);
    return { entity_id: id, tier: rule.tier, reason: why, rule, minutes: timed.minutes };
  });

  const denied = entities.filter((e) => e.tier === 'deny');
  if (denied.length) return deny(unique(denied.map((e) => e.reason)).join('; '), entities);

  const risk = entities.some((e) => e.rule?.risk === 'high') ? 'high' : 'normal';
  const confirming = entities.filter((e) => e.tier === 'confirm');
  let tier: Tier = confirming.length ? 'confirm' : 'allow';
  const reasons = unique(confirming.map((e) => e.reason));
  if (policy.bulk && entities.length > policy.bulk.confirm_over) {
    tier = 'confirm';
    reasons.push(`more than ${policy.bulk.confirm_over} entities in one call`);
  }
  const reason =
    tier === 'confirm' ? reasons.join('; ') : `allowed by ${unique(entities.map((e) => e.reason)).join(', ')}`;

  // one call per domain (each entity's service runs in its own domain), in the request's order
  const byDomain = new Map<string, string[]>();
  for (const e of req.entity_ids) {
    const d = domainOf(e);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d)!.push(e);
  }
  const calls: PlannedCall[] = [...byDomain].map(([domain, ids]) => ({
    domain,
    service,
    data: { ...data, entity_id: ids },
  }));

  // the off calls for timed entities, grouped by domain and minutes
  const timers: PlannedTimer[] = [];
  for (const e of entities) {
    if (e.minutes === undefined) continue;
    const domain = domainOf(e.entity_id);
    const t = timers.find((x) => x.domain === domain && x.minutes === e.minutes);
    if (t) t.entity_ids.push(e.entity_id);
    else timers.push({ minutes: e.minutes, domain, service: OFF_SERVICE[service], entity_ids: [e.entity_id] });
  }
  return { tier, reason, risk, entities, calls, timers };
}

/** null if every data key is named by the rule with a value it accepts, else the refusal */
function dataProblem(rule: Rule, id: string, service: string, data: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(data)) {
    if (Object.hasOwn(rule.bounds, k)) {
      const [lo, hi] = rule.bounds[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${k} must be a number for ${id} (got ${show(v)})`;
      if (v < lo || v > hi) return `${k} ${v} is outside ${lo}–${hi} for ${id}`;
    } else if (rule.data.includes(k)) {
      if (typeof v !== 'string' && typeof v !== 'boolean')
        return `${k} must be a string or true/false for ${id} (got ${show(v)})`;
    } else return `${k} is not allowed in the data for ${id} ${service}`;
  }
  return null;
}

/** a max_minutes rule's run time for this call, or the refusal; no timer otherwise */
function timing(
  rule: Rule,
  id: string,
  service: string,
  hasMinutes: boolean,
  asked: unknown,
): { minutes?: number } | { refused: string } {
  const max = rule.max_minutes;
  if (max === undefined)
    return hasMinutes ? { refused: `minutes is not allowed in the data for ${id} ${service}` } : {};
  if (OFF_SERVICES.has(service)) return hasMinutes ? { refused: `minutes means nothing for ${id} ${service}` } : {};
  if (!OFF_SERVICE[service])
    return { refused: `${id} runs for at most ${max} minutes: use a service that can be timed` };
  if (!hasMinutes) return { minutes: max };
  if (typeof asked !== 'number' || !Number.isFinite(asked))
    return { refused: `minutes must be a number (got ${show(asked)})` };
  if (asked <= 0 || asked > max) return { refused: `minutes ${asked} is outside 0–${max} for ${id}` };
  return { minutes: asked };
}

const unique = (xs: string[]) => [...new Set(xs)];
const show = (v: unknown) => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

// ------------------------------------------------------------------------------------------------ words

const VERBS: Readonly<Record<string, string>> = {
  turn_on: 'Turn on',
  turn_off: 'Turn off',
  toggle: 'Toggle',
  open_cover: 'Open',
  close_cover: 'Close',
  stop_cover: 'Stop',
  open_valve: 'Open',
  close_valve: 'Close',
  lock: 'Lock',
  unlock: 'Unlock',
  open: 'Open',
};

/** "A", "A and B", "A, B and C" */
export function andList(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** The request in plain words, with friendly names: "Turn off Kitchen pendant 1 and Kitchen pendant 2",
 * "Set Hall thermostat to 72 (temperature)", "Turn on Pond pump for 30 minutes". */
export function describeRequest(req: ActRequest, states: EvalContext['states'], minutes?: number): string {
  const names = andList(
    (req.entity_ids ?? []).map((id) => {
      const n = getState(states, id)?.attributes?.friendly_name;
      return typeof n === 'string' && n.trim() ? n.trim() : id;
    }),
  );
  const data = Object.entries(req.data ?? {}).filter(([k]) => k !== 'minutes');
  const values = data.map(([k, v]) => `${typeof v === 'string' ? v : show(v)} (${k})`).join(', ');
  const s = String(req.service ?? '');
  let out: string;
  if (VERBS[s]) out = `${VERBS[s]} ${names}${values ? ` with ${values}` : ''}`;
  else if (s.startsWith('set_')) out = `Set ${names}${values ? ` to ${values}` : ''}`;
  else {
    const words = s.replace(/_/g, ' ');
    out = `${words.charAt(0).toUpperCase()}${words.slice(1)} ${names}${values ? ` with ${values}` : ''}`;
  }
  return minutes !== undefined ? `${out} for ${minutes} minute${minutes === 1 ? '' : 's'}` : out;
}

/** the exact calls: "climate.set_temperature on climate.hall_thermostat {"temperature":72}" */
export function describeCalls(calls: readonly PlannedCall[], timers: readonly PlannedTimer[] = []): string {
  const parts = calls.map(({ domain, service, data }) => {
    const { entity_id, ...rest } = data;
    return `${domain}.${service} on ${entity_id.join(', ')}${Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''}`;
  });
  for (const t of timers)
    parts.push(`then ${t.domain}.${t.service} on ${t.entity_ids.join(', ')} after ${t.minutes} min`);
  return parts.join('; ');
}
