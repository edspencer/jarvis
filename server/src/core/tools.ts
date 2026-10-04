// The house tools the agent sees (as mcp__house__<name>): Home Assistant reads, the one action tool (ha_act, which goes
// through the policy gate and nowhere else), the site and registry, the 3D viewer, and a small house-wide memory.
// Pure handlers over their dependencies, so the same specs serve the SDK agent, the scripted agent and the tests.
// There is deliberately no raw service-call tool. Design §5.2, §6.2-6.4.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ActContext,
  ActOutcome,
  ActRequest,
  HaBackend,
  HaState,
  ParamSpec,
  Tier,
  ToolEnv,
  ToolSpec,
} from './types.ts';
import { human, roomName, scoreFields, searchSite, tokens, type SiteKnowledge } from './knowledge.ts';

/** the part of the gate (core/gate.ts) the tools use */
export interface ToolGate {
  act(req: ActRequest, ctx: ActContext): Promise<ActOutcome>;
  evaluate(req: ActRequest, ctx: ActContext): Promise<{ tier: Tier; reason: string; summary: string }>;
}

export interface ToolDeps {
  gate: ToolGate;
  ha: HaBackend;
  site: SiteKnowledge;
  /** the assistant's data folder; memories live in <dataDir>/memory/house only */
  dataDir: string;
  /** the confirmation TTL, for the words the model gets back (default 30 s) */
  confirmTtlMs?: number;
  now?: () => Date;
}

/** a bad argument: the runner turns it into an error result the model can correct */
export class ToolInputError extends Error {}

const MAX_ENTITIES = 20;
const MAX_FIND = 10;
export const MEMORY_MAX_CHARS = 4000;
export const MEMORY_MAX_FILES = 200;
const ENTITY_RE = /^[a-z_]+\.[a-z0-9_]+$/;

// ------------------------------------------------------------------------------------------------ argument helpers

function str(args: Record<string, unknown>, k: string, max = 500): string {
  const v = args[k];
  if (typeof v !== 'string' || !v.trim()) throw new ToolInputError(`${k}: a non-empty string is required`);
  if (v.length > max) throw new ToolInputError(`${k}: at most ${max} characters`);
  return v.trim();
}
function optStr(args: Record<string, unknown>, k: string, max = 200): string | undefined {
  return args[k] === undefined || args[k] === null || args[k] === '' ? undefined : str(args, k, max);
}
function num(args: Record<string, unknown>, k: string, dflt: number, min: number, max: number): number {
  const v = args[k] === undefined || args[k] === null ? dflt : Number(args[k]);
  if (!Number.isFinite(v)) throw new ToolInputError(`${k}: a number is required`);
  return Math.min(max, Math.max(min, v));
}
function list(args: Record<string, unknown>, k: string, max: number, re?: RegExp): string[] {
  let v = args[k];
  if (typeof v === 'string') v = [v];
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'string'))
    throw new ToolInputError(`${k}: a non-empty list of strings is required`);
  if (v.length > max) throw new ToolInputError(`${k}: at most ${max} at a time`);
  const bad = re ? (v as string[]).filter((x) => !re.test(x)) : [];
  if (bad.length) throw new ToolInputError(`${k}: not valid ids: ${bad.join(', ')}`);
  return [...new Set(v as string[])];
}

const domainOf = (id: string) => id.split('.')[0];
const nameOf = (s: HaState | undefined, id: string) => s?.attributes.friendly_name ?? human(id.split('.')[1] ?? id);

/** words people use for a domain ('lamp' finds lights, 'thermostat' finds climate) */
const DOMAIN_WORDS: Record<string, string> = {
  light: 'light lamp lighting',
  switch: 'switch plug socket power',
  climate: 'climate thermostat heating cooling hvac temperature air conditioning',
  fan: 'fan',
  cover: 'cover blind shade shutter curtain garage door',
  lock: 'lock door',
  script: 'script routine',
  scene: 'scene mood',
  media_player: 'media player speaker tv music',
  sensor: 'sensor',
  binary_sensor: 'sensor',
  valve: 'valve water',
  weather: 'weather forecast',
};

/** the services worth a dry run for each domain, so ha_find can say what's allowed */
const PROBE: Record<string, string[]> = {
  light: ['turn_on', 'turn_off'],
  switch: ['turn_on', 'turn_off'],
  fan: ['turn_on', 'turn_off'],
  input_boolean: ['turn_on', 'turn_off'],
  media_player: ['media_pause', 'media_play'],
  script: ['turn_on'],
  scene: ['turn_on'],
  cover: ['open_cover', 'close_cover'],
  lock: ['lock', 'unlock'],
  climate: ['set_temperature'],
  valve: ['open_valve', 'close_valve'],
};

/** the attributes worth showing the model (the rest is noise: icons, supported_features, color tables…) */
const ATTRS = [
  'friendly_name',
  'device_class',
  'unit_of_measurement',
  'area',
  'brightness',
  'color_temp_kelvin',
  'temperature',
  'target_temp_high',
  'target_temp_low',
  'current_temperature',
  'current_humidity',
  'hvac_action',
  'hvac_modes',
  'preset_mode',
  'percentage',
  'current_position',
  'media_title',
  'volume_level',
  'battery_level',
  'forecast',
];

function pickAttrs(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ATTRS) if (a[k] !== undefined && a[k] !== null) out[k] = a[k];
  if (typeof out.brightness === 'number') out.brightness_pct = Math.round(((out.brightness as number) / 255) * 100);
  return out;
}

function memoryName(raw: string): string {
  const n = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  if (!n) throw new ToolInputError('name: use letters or digits');
  if (n === 'memory') throw new ToolInputError('name: "memory" is reserved');
  return n;
}

const p = (type: ParamSpec['type'], description: string, extra: Partial<ParamSpec> = {}): ParamSpec =>
  ({ type, description, ...extra }) as ParamSpec;

// ------------------------------------------------------------------------------------------------ the tools

export function createTools(deps: ToolDeps): ToolSpec[] {
  const { gate, ha, site } = deps;
  const now = deps.now ?? (() => new Date());
  const ttlS = Math.round((deps.confirmTtlMs ?? 30_000) / 1000);
  const memDir = join(deps.dataDir, 'memory', 'house');
  const ctx = (env: ToolEnv): ActContext => ({
    surface: env.turn.surface,
    clientId: env.turn.clientId,
    user: env.turn.user,
    utterance: env.turn.text,
  });

  // what the site knows about each entity: fixtures, registry items, devices, controls
  const siteIndex = new Map<string, { fixtures: string[]; rooms: string[]; names: string[]; subject: string | null }>();
  const note = (id: string, f: { fixture?: string; room?: string | null; name?: string; subject?: string | null }) => {
    const e = siteIndex.get(id) ?? { fixtures: [], rooms: [], names: [], subject: null };
    if (f.fixture) e.fixtures.push(f.fixture);
    if (f.room && !e.rooms.includes(f.room)) e.rooms.push(f.room);
    if (f.name && !e.names.includes(f.name)) e.names.push(f.name);
    e.subject ??= f.subject ?? null;
    siteIndex.set(id, e);
  };
  for (const f of site.fixtures)
    for (const id of f.entities)
      note(id, {
        fixture: f.id,
        room: f.room,
        name: `${roomName(site, f.room)} ${f.kind ?? ''} ${f.group ?? ''}`,
        subject: `fixture:${f.id}`,
      });
  for (const r of site.registry)
    for (const id of r.entities)
      note(id, { room: r.room, name: [r.name, ...r.aliases].join(' '), subject: r.placed ? `pins:${r.id}` : null });
  for (const d of site.devices)
    for (const id of d.entities) note(id, { room: d.room, name: d.name, subject: d.subject });
  for (const c of site.controls) note(c.entity_id, { name: c.label });

  const areaOf = (s: HaState | undefined, id: string) => {
    const a = s?.attributes.area;
    if (typeof a === 'string' && a) return a;
    const r = siteIndex.get(id)?.rooms[0];
    return r ? roomName(site, r) : null;
  };
  const subjectOf = (id: string) => siteIndex.get(id)?.subject ?? null;

  const statesById = async (ids: string[]) => {
    const states = await ha.states(ids);
    return new Map(states.map((s) => [s.entity_id, s]));
  };

  const listMemories = (): string[] => {
    try {
      return readdirSync(memDir)
        .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
        .map((f) => f.slice(0, -3))
        .sort();
    } catch {
      return [];
    }
  };
  const readMemory = (name: string) => {
    const raw = readFileSync(join(memDir, `${name}.md`), 'utf8');
    return raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  };
  const writeIndex = () => {
    const lines = listMemories().map((n) => `- [${n}](${n}.md): ${readMemory(n).split('\n')[0].slice(0, 100)}`);
    writeFileSync(join(memDir, 'MEMORY.md'), `# House memory\n\n${lines.join('\n')}\n`);
  };

  const tools: ToolSpec[] = [
    // -------------------------------------------------------------------------------------------- Home Assistant
    {
      name: 'ha_find',
      description:
        "Resolve a person's words ('the kitchen lights', 'thermostat', 'pond pump') to Home Assistant entities: id, name, area, state, and what the house policy allows (tier per service: allow / confirm / deny). Always use before ha_act; never guess ids.",
      readOnly: true,
      params: {
        query: p('string', 'what the person called it, e.g. "kitchen pendants"'),
        domain: p('string', 'only this domain, e.g. "light", "climate"', { optional: true }),
      },
      async run(args, env) {
        const query = str(args, 'query', 200);
        const domain = optStr(args, 'domain', 40);
        env.activity(`Looking for ${query}`, 'running');
        const states = await ha.states();
        const byId = new Map<string, HaState | undefined>(states.map((s) => [s.entity_id, s]));
        for (const id of siteIndex.keys()) if (!byId.has(id)) byId.set(id, undefined);
        const q = tokens(query);
        const scored: { id: string; score: number }[] = [];
        for (const [id, s] of byId) {
          if (domain && domainOf(id) !== domain) continue;
          const si = siteIndex.get(id);
          const score = scoreFields(q, [
            [nameOf(s, id), 3],
            [id.split('.')[1] ?? '', 2.5],
            [DOMAIN_WORDS[domainOf(id)] ?? domainOf(id), 1.5],
            [areaOf(s, id) ?? '', 1.5],
            [(si?.rooms ?? []).map((r) => roomName(site, r)).join(' '), 1.5],
            [(si?.names ?? []).join(' '), 2.5],
            [String(s?.attributes.device_class ?? ''), 1],
          ]);
          // an id only the site's files know (not in Home Assistant) ranks below the real ones
          if (score > 0) scored.push({ id, score: s ? score : score / 2 });
        }
        scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        const top = scored[0]?.score ?? 0;
        const picked = scored.filter((x) => x.score >= top * 0.6).slice(0, MAX_FIND);
        const out = await Promise.all(
          picked.map(async ({ id }) => {
            const s = byId.get(id);
            const tiers: Record<string, string> = {};
            for (const service of PROBE[domainOf(id)] ?? []) {
              try {
                const r = await gate.evaluate({ entity_ids: [id], service }, ctx(env));
                tiers[service] = r.tier === 'allow' ? 'allow' : `${r.tier}${r.reason ? ` (${r.reason})` : ''}`;
              } catch {}
            }
            return {
              entity_id: id,
              name: nameOf(s, id),
              area: areaOf(s, id),
              state: s ? s.state : 'not in Home Assistant',
              ...(subjectOf(id) ? { subject: subjectOf(id) } : {}),
              ...(Object.keys(tiers).length ? { policy: tiers } : {}),
            };
          }),
        );
        env.activity(
          `Found ${out.length} for ${query}`,
          'done',
          out.length === 1 ? (out[0].subject ?? undefined) : undefined,
        );
        if (!out.length) return { query, matches: [], hint: 'nothing matched; try other words or site_search' };
        return { query, matches: out, ...(scored.length > out.length ? { more: scored.length - out.length } : {}) };
      },
    },
    {
      name: 'ha_state',
      description: `Current state and the useful attributes of up to ${MAX_ENTITIES} Home Assistant entities.`,
      readOnly: true,
      params: { entity_ids: p('string[]', 'entity ids from ha_find') },
      async run(args, env) {
        const ids = list(args, 'entity_ids', MAX_ENTITIES, ENTITY_RE);
        const byId = await statesById(ids);
        env.activity(
          `Reading ${ids.length === 1 ? nameOf(byId.get(ids[0]), ids[0]) : `${ids.length} entities`}`,
          'done',
        );
        return ids.map((id) => {
          const s = byId.get(id);
          if (!s) return { entity_id: id, error: 'no such entity' };
          return { entity_id: id, state: s.state, ...pickAttrs(s.attributes), last_changed: s.last_changed };
        });
      },
    },
    {
      name: 'ha_history',
      description:
        'A summary of one entity\'s history over the last N hours (default 24, max 168): changes, and min/max/mean for numbers. For questions like "when did the freezer last go above 10 °F?".',
      readOnly: true,
      params: {
        entity_id: p('string', 'one entity id'),
        hours: p('number', 'how far back (hours)', { optional: true, min: 1, max: 168 }),
      },
      async run(args, env) {
        const id = str(args, 'entity_id', 120);
        if (!ENTITY_RE.test(id)) throw new ToolInputError(`entity_id: not a valid id: ${id}`);
        const hours = num(args, 'hours', 24, 1, 168);
        const to = now();
        const from = new Date(to.getTime() - hours * 3600_000);
        const pts = await ha.history(id, from, to);
        env.activity(`History of ${id} (${hours} h)`, 'done', subjectOf(id) ?? undefined);
        const nums = pts.map((x) => Number(x.state)).filter((n) => Number.isFinite(n));
        const out: Record<string, unknown> = { entity_id: id, hours, points: pts.length };
        if (!pts.length) return { ...out, note: 'no history in this window' };
        if (nums.length >= pts.length / 2 && nums.length) {
          let iMin = 0;
          let iMax = 0;
          pts.forEach((x, i) => {
            const n = Number(x.state);
            if (n < Number(pts[iMin].state) || !Number.isFinite(Number(pts[iMin].state))) iMin = i;
            if (n > Number(pts[iMax].state) || !Number.isFinite(Number(pts[iMax].state))) iMax = i;
          });
          out.min = { value: Number(pts[iMin].state), at: pts[iMin].at };
          out.max = { value: Number(pts[iMax].state), at: pts[iMax].at };
          out.mean = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
          out.first = pts[0];
          out.last = pts[pts.length - 1];
        } else {
          const changes = pts.filter((x, i) => i === 0 || x.state !== pts[i - 1].state);
          out.changes = changes.length;
          out.recent = changes.slice(-20);
        }
        return out;
      },
    },
    {
      name: 'ha_act',
      description:
        'Change something in the house: call one Home Assistant service on entities from ha_find (all in the same domain), e.g. { entity_ids: ["light.kitchen"], service: "turn_off" } or { entity_ids: ["climate.hall"], service: "set_temperature", data: { temperature: 21 } }. The house policy decides: done, refused (with the reason), or it asks the person to confirm and returns once they answer. This is the only way to act.',
      params: {
        entity_ids: p('string[]', 'entity ids from ha_find, one domain'),
        service: p('string', 'the service without the domain: turn_on, turn_off, toggle, set_temperature, …'),
        data: p('object', 'service data (brightness_pct, temperature, …), without entity_id', { optional: true }),
      },
      async run(args, env) {
        const ids = list(args, 'entity_ids', 50, ENTITY_RE);
        const service = str(args, 'service', 60);
        if (!/^[a-z_]+$/.test(service)) throw new ToolInputError(`service: not a service name: ${service}`);
        const data = args.data;
        if (data !== undefined && data !== null && (typeof data !== 'object' || Array.isArray(data)))
          throw new ToolInputError('data: an object is required');
        const req: ActRequest = {
          entity_ids: ids,
          service,
          ...(data ? { data: data as Record<string, unknown> } : {}),
        };
        const byId = await statesById(ids).catch(() => new Map<string, HaState>());
        const names = ids.map((id) => nameOf(byId.get(id), id));
        const what = `${human(service)} ${names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ')}`;
        const subject = subjectOf(ids[0]) ?? undefined;
        env.activity(what, 'running', subject);
        const o = await gate.act(req, ctx(env));
        switch (o.status) {
          case 'done':
            env.activity(o.summary || what, 'done', subject);
            return `done: ${o.summary || what}`;
          case 'refused':
            env.activity(`Refused: ${what}`, 'refused', subject);
            return `refused: ${o.reason}`;
          case 'denied':
            env.activity(`Declined: ${o.summary || what}`, 'refused', subject);
            return `the person declined: ${o.summary || what}. Nothing was changed.`;
          case 'expired':
            env.activity(`Not confirmed: ${o.summary || what}`, 'refused', subject);
            return `nobody confirmed within ${ttlS} s: ${o.summary || what}. Nothing was changed.`;
          case 'failed':
            env.activity(`Failed: ${o.summary || what}`, 'error', subject);
            return `Home Assistant failed: ${o.error}`;
          default:
            env.activity(`Failed: ${what}`, 'error', subject);
            return 'Home Assistant failed: unknown outcome';
        }
      },
    },

    // -------------------------------------------------------------------------------------------- the site
    {
      name: 'site_search',
      description:
        "Search the building's own data: rooms, light fixtures, the equipment registry (make, model, location), Home Assistant devices placed in the model, and controls. Results carry a subject the viewer can fly to.",
      readOnly: true,
      params: { query: p('string', 'words, e.g. "water heater", "router", "kitchen"') },
      async run(args, env) {
        const query = str(args, 'query', 200);
        const hits = searchSite(site, query, 8);
        env.activity(`Searching for ${query}`, 'done', hits[0]?.subject ?? undefined);
        return hits.length
          ? hits.map(({ score: _s, ...h }) => ({ ...h, room: h.room ? roomName(site, h.room) : null }))
          : { query, hits: [], hint: 'nothing matched' };
      },
    },
    {
      name: 'site_rooms',
      description: 'The rooms, by storey, with their light fixtures and the registry items in each.',
      readOnly: true,
      params: {},
      async run(_args, env) {
        env.activity('Listing the rooms', 'done');
        return site.rooms.map((r) => ({
          id: r.id,
          name: r.name,
          storey: r.storey,
          subject: `room:${r.id}`,
          fixtures: r.fixtures.length,
          items: site.registry.filter((i) => i.room === r.id).map((i) => i.name),
        }));
      },
    },
    {
      name: 'registry_get',
      description:
        'One equipment registry item by id (from site_search): make, model, location, specs, documents, Home Assistant entities.',
      readOnly: true,
      params: { id: p('string', 'the registry id, e.g. "plumb.water-heater" (or "pins:plumb.water-heater")') },
      async run(args, env) {
        const id = str(args, 'id', 120).replace(/^pins:/, '');
        const it = site.registry.find((r) => r.id === id);
        if (!it) {
          env.activity(`No registry item ${id}`, 'error');
          const near = searchSite(site, id.replace(/[.-]/g, ' '), 3).filter((h) => h.kind === 'registry');
          return { error: `no registry item ${id}`, ...(near.length ? { did_you_mean: near.map((h) => h.id) } : {}) };
        }
        const subject = it.placed ? `pins:${it.id}` : undefined;
        env.activity(it.name, 'done', subject);
        return { ...it, room: roomName(site, it.room) || null, subject: subject ?? null };
      },
    },

    // -------------------------------------------------------------------------------------------- the viewer
    {
      name: 'view_fly',
      description:
        "Fly the person's 3D view to a subject and open it: 'pins:<registry id>', 'fixture:<fixture id>', 'room:<room id>' (from site_search / ha_find). Answers 'no viewer attached' on a speaker.",
      params: { subject: p('string', "e.g. 'pins:plumb.water-heater'") },
      async run(args, env) {
        const subject = str(args, 'subject', 200);
        if (!/^[a-z]+:\S+$/.test(subject)) throw new ToolInputError(`subject: expected kind:id, got ${subject}`);
        env.activity(`Showing ${subject}`, 'running', subject);
        const r = await env.view('fly', { subject });
        env.activity(`Showing ${subject}`, r.ok ? 'done' : 'error', subject);
        return r.ok ? `showing ${subject}` : `could not show it: ${r.detail ?? 'the viewer said no'}`;
      },
    },
    {
      name: 'view_highlight',
      description: 'Pulse one or more subjects in the 3D view for a few seconds (e.g. the lights that are on).',
      params: {
        subjects: p('string[]', 'subjects as for view_fly'),
        seconds: p('number', 'how long (default 6)', { optional: true, min: 1, max: 60 }),
      },
      async run(args, env) {
        const subjects = list(args, 'subjects', 50, /^[a-z]+:\S+$/);
        const seconds = num(args, 'seconds', 6, 1, 60);
        env.activity(`Highlighting ${subjects.length}`, 'running');
        const r = await env.view('highlight', { subjects, seconds });
        env.activity(`Highlighting ${subjects.length}`, r.ok ? 'done' : 'error');
        return r.ok ? `highlighted ${subjects.length}` : `could not highlight: ${r.detail ?? 'the viewer said no'}`;
      },
    },
    {
      name: 'view_layer',
      // the viewer refuses anything that isn't a view layer or one of its view toggles (plugin chips can act on the house)
      description: `Show or hide a layer in the 3D view: ${[...new Set(['roof', 'ceiling', 'door', ...site.layers.map((l) => l.id)])].join(', ')}; or the view toggles cutaway and upper (the upper storey). Nothing else is a layer.`,
      params: {
        layer: p('string', 'the layer id'),
        on: p('boolean', 'true: show, false: hide (default: toggle)', { optional: true }),
      },
      async run(args, env) {
        const layer = str(args, 'layer', 60);
        if (!/^[a-z0-9_.-]+$/i.test(layer)) throw new ToolInputError(`layer: not a layer id: ${layer}`);
        const on = typeof args.on === 'boolean' ? args.on : undefined;
        const label = `${on === false ? 'Hiding' : on ? 'Showing' : 'Toggling'} ${layer}`;
        env.activity(label, 'running');
        const r = await env.view('layer', on === undefined ? { layer } : { layer, on });
        env.activity(label, r.ok ? 'done' : 'error');
        return r.ok ? `${label.toLowerCase()}: ok` : `could not: ${r.detail ?? 'the viewer said no'}`;
      },
    },
    {
      name: 'view_where',
      description: 'Where the person is in the 3D view and what is selected (also given at the top of each turn).',
      readOnly: true,
      params: {},
      async run(_args, env) {
        const v = env.turn.view ?? {};
        return {
          viewer: env.turn.viewer,
          surface: env.turn.surface,
          room: v.room ? { id: v.room, name: roomName(site, v.room), subject: `room:${v.room}` } : null,
          storey: v.storey ?? null,
          selected: v.selected ?? null,
        };
      },
    },

    // -------------------------------------------------------------------------------------------- memory
    // TODO(open question: per-person memory needs the speaker's identity, design §2.3): only house-wide memory for now.
    {
      name: 'memory_save',
      description:
        'Remember a lasting fact for the household (a preference, the name people use for something). One short note per name; saving the same name replaces it.',
      params: {
        name: p('string', 'a short slug, e.g. "lounge-evening-brightness"'),
        text: p('string', `the fact, in a sentence or two (max ${MEMORY_MAX_CHARS} characters)`),
      },
      async run(args, env) {
        const name = memoryName(str(args, 'name', 200));
        const text = str(args, 'text', MEMORY_MAX_CHARS);
        mkdirSync(memDir, { recursive: true });
        const exists = listMemories().includes(name);
        if (!exists && listMemories().length >= MEMORY_MAX_FILES)
          throw new ToolInputError(`memory is full (${MEMORY_MAX_FILES} notes): forget something first`);
        const body = `---\nname: ${name}\ndescription: ${text.split('\n')[0].slice(0, 120)}\ntype: house\nupdated: ${now().toISOString()}\n---\n${text}\n`;
        writeFileSync(join(memDir, `${name}.md`), body, { mode: 0o600 });
        writeIndex();
        env.activity(`Remembered ${name}`, 'done');
        return `${exists ? 'updated' : 'saved'} ${name}`;
      },
    },
    {
      name: 'memory_search',
      description: 'Search the household memory (empty query: list every note).',
      readOnly: true,
      params: { query: p('string', 'words to look for', { optional: true }) },
      async run(args) {
        const q = tokens(optStr(args, 'query', 200) ?? '');
        const all = listMemories().map((n) => ({ name: n, text: readMemory(n) }));
        if (!q.length)
          return all.length ? all.map((m) => ({ name: m.name, text: m.text.slice(0, 300) })) : 'no memories';
        const hits = all
          .map((m) => ({
            ...m,
            score: scoreFields(q, [
              [m.name.replace(/-/g, ' '), 2],
              [m.text, 1],
            ]),
          }))
          .filter((m) => m.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 10);
        return hits.length
          ? hits.map((m) => ({ name: m.name, text: m.text.slice(0, 500) }))
          : 'nothing remembered about that';
      },
    },
    {
      name: 'memory_forget',
      description: 'Forget one household memory by name.',
      params: { name: p('string', 'the note name') },
      async run(args, env) {
        const name = memoryName(str(args, 'name', 200));
        const file = join(memDir, `${name}.md`);
        try {
          statSync(file);
        } catch {
          return `there is no memory called ${name}`;
        }
        rmSync(file);
        writeIndex();
        env.activity(`Forgot ${name}`, 'done');
        return `forgot ${name}`;
      },
    },
  ];
  return tools;
}
