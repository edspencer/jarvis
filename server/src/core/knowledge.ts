// What the assistant knows about the building, loaded from the same site folder the viewer uses, so both agree on
// ids: the manifest (name, storeys, viewpoints, layers, time zone), the main model's room floors and light fixtures
// (read from the GLB's JSON chunk: no three.js), the equipment registry, the Home Assistant fixture map, controls and
// device map. Also a small scored text search over all of it, and the system prompt (stable: no times, so the prompt
// cache holds) and the per-turn preamble (time, surface, view). Design §6.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Surface, ViewContext } from './protocol.ts';
import type { TurnInfo } from './types.ts';

export interface Room {
  id: string;
  name: string;
  /** the manifest's storey name ('ground floor'), if known */
  storey: string | null;
  /** light fixture ids in the room */
  fixtures: string[];
}

export interface Fixture {
  id: string;
  /** 'pendant', 'can', … */
  kind: string | null;
  group: string | null;
  room: string | null;
  /** Home Assistant entities from ha_map.json ([] when unmapped) */
  entities: string[];
}

export interface RegistryItem {
  id: string;
  name: string;
  category: string | null;
  room: string | null;
  make: string | null;
  model: string | null;
  aliases: string[];
  entities: string[];
  fixtures: string[];
  note: string | null;
  /** placed in the model (a pin the viewer can fly to) */
  placed: boolean;
  specs: [string, string][];
  documents: string[];
}

export interface Device {
  id: string;
  name: string;
  area: string | null;
  /** room id, if the device's area or place names one */
  room: string | null;
  /** the device's own entities (its health map's `avail`) */
  entities: string[];
  /** its other health entities: battery, signal, firmware update, … */
  related: string[];
  /** the subject the viewer can fly to, if placed */
  subject: string | null;
}

export interface Control {
  id: string;
  label: string;
  entity_id: string;
  action: string;
  confirm?: string;
}

export interface SiteKnowledge {
  dir: string;
  id: string;
  name: string;
  description: string;
  timeZone: string | null;
  units: 'ft' | 'm';
  storeys: { name: string; short?: string }[];
  viewpoints: string[];
  layers: { id: string; label: string; help?: string }[];
  rooms: Room[];
  fixtures: Fixture[];
  registry: RegistryItem[];
  devices: Device[];
  controls: Control[];
  /** load problems, for the log (a missing optional file is not one) */
  warnings: string[];
}

// ------------------------------------------------------------------------------------------------ loading

/** 'living_room' -> 'Living room' (as the viewer's HUD shows ids) */
export const human = (s: unknown): string => {
  const t = String(s ?? '').replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strs = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).filter((x): x is string => typeof x === 'string');
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** a GLB's JSON chunk (the node names and extras; the binary chunk is ignored) */
export function readGlbJson(file: string): Record<string, unknown> {
  const b = readFileSync(file);
  if (b.length < 20 || b.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const len = b.readUInt32LE(12);
  if (b.readUInt32LE(16) !== 0x4e4f534a) throw new Error('the first GLB chunk is not JSON');
  return JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
}

function readJson(dir: string, rel: string | null, warnings: string[]): unknown {
  if (!rel || /^[a-z]+:/i.test(rel)) return null;
  const file = join(dir, rel);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    warnings.push(`${rel}: ${(e as Error).message}`);
    return null;
  }
}

/** Load a site folder. Only site.json is required; every other file is optional. */
export function loadSite(dir: string): SiteKnowledge {
  const warnings: string[] = [];
  const manifest = obj(JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8')));
  const plugins = obj(manifest.plugins);
  const storeys = (Array.isArray(manifest.storeys) ? manifest.storeys : []).map((s) => {
    const o = obj(s);
    return { name: String(o.name ?? ''), short: str(o.short) ?? undefined };
  });

  // rooms and fixtures from the models' node extras (Floor_<room> with { room, storey }; Fixture_<id>)
  const floorPrefix = str(obj(manifest.rooms).floorPrefix) ?? 'Floor_';
  const models = obj(manifest.models);
  const urls = [
    str(obj(models.main).url),
    ...(Array.isArray(models.extra) ? models.extra : []).map((m) => str(obj(m).url)),
  ];
  const rooms = new Map<string, Room>();
  const fixtures = new Map<string, Fixture>();
  const storeyOf = (s: string | null) =>
    !s ? null : (storeys.find((x) => x.name === s || x.name.startsWith(s + ' ') || x.short === s)?.name ?? s);
  urls.forEach((url, i) => {
    if (!url || !url.endsWith('.glb') || /^[a-z]+:/i.test(url)) return;
    let gltf: Record<string, unknown>;
    try {
      gltf = readGlbJson(join(dir, url));
    } catch (e) {
      warnings.push(`${url}: ${(e as Error).message}`);
      return;
    }
    for (const n of Array.isArray(gltf.nodes) ? gltf.nodes : []) {
      const node = obj(n);
      const name = String(node.name ?? '');
      const x = obj(node.extras);
      if (i === 0 && name.startsWith(floorPrefix) && str(x.room)) {
        const id = String(x.room);
        rooms.set(id, { id, name: human(id), storey: storeyOf(str(x.storey)), fixtures: [] });
      }
      const fid = str(x.fixture_id);
      if (fid)
        fixtures.set(fid, {
          id: fid,
          kind: str(x.fixture_kind),
          group: str(x.fixture_group),
          room: str(x.room),
          entities: [],
        });
    }
  });

  // the fixture map: fixture -> entity (or several)
  const lights = obj(plugins.lights);
  const map = obj(readJson(dir, str(lights.map) ?? 'ha_map.json', warnings));
  for (const [fid, e] of Object.entries(map)) {
    const f = fixtures.get(fid) ?? { id: fid, kind: null, group: null, room: null, entities: [] };
    f.entities = strs(obj(e).entity_id);
    if (!f.group) f.group = str(obj(e).group);
    fixtures.set(fid, f);
  }
  for (const f of fixtures.values()) if (f.room) rooms.get(f.room)?.fixtures.push(f.id);

  // the registry
  const reg = obj(readJson(dir, str(obj(plugins.pins).registry) ?? 'registry_pins.json', warnings));
  const item = (o: Record<string, unknown>, placed: boolean): RegistryItem => ({
    id: String(o.id),
    name: str(o.name) ?? String(o.id),
    category: str(o.category),
    room: str(o.room),
    make: str(o.make),
    model: str(o.model),
    aliases: strs(o.aliases),
    entities: strs(obj(o.ha).entities),
    fixtures: strs(o.fixtures),
    note: str(o.loc_note) ?? str(o.note),
    placed,
    specs: (Array.isArray(o.specs) ? o.specs : [])
      .filter((s): s is [unknown, unknown] => Array.isArray(s) && s.length >= 2)
      .map(([k, v]) => [String(k), String(v)]),
    documents: (Array.isArray(o.documents) ? o.documents : []).map((d) => str(obj(d).text)).filter((d) => d !== null),
  });
  const registry = [
    ...(Array.isArray(reg.pins) ? reg.pins : []).map((p) => item(obj(p), true)),
    ...(Array.isArray(reg.unplaced) ? reg.unplaced : []).map((p) => item(obj(p), false)),
  ].filter((r) => r.id && r.id !== 'undefined');

  // the device map (faults plugin)
  const roomByName = (s: string | null) =>
    !s ? null : ([...rooms.values()].find((r) => r.name.toLowerCase() === s.toLowerCase() || r.id === s)?.id ?? null);
  const dev = obj(readJson(dir, str(obj(plugins.faults).devices) ?? 'ha_devices.json', warnings));
  const devices: Device[] = (Array.isArray(dev.devices) ? dev.devices : []).map((d) => {
    const o = obj(d);
    const place = obj(o.place);
    const health = obj(o.health);
    const ref = str(place.ref);
    const subject =
      place.src === 'fixture' && ref
        ? `fixture:${ref}`
        : place.src === 'registry' && ref
          ? `pins:${ref}`
          : place.src === 'area' && ref && rooms.has(ref)
            ? `room:${ref}`
            : null;
    const ids = (v: unknown) =>
      (Array.isArray(v) ? v : [])
        .map((e) => (typeof e === 'string' ? e : str(obj(e).entity)))
        .filter((e) => e !== null);
    const entities = ids(health.avail);
    const related = Object.entries(health)
      .filter(([k]) => k !== 'avail')
      .flatMap(([, v]) => ids(v))
      .filter((e) => !entities.includes(e));
    return {
      id: String(o.id),
      name: str(o.name) ?? String(o.id),
      area: str(o.area),
      room: (place.src === 'area' && ref && rooms.has(ref) ? ref : null) ?? roomByName(str(place.room) ?? str(o.area)),
      entities,
      related,
      subject,
    };
  });

  // the controls (scripts and switches the HUD offers)
  const ctl = obj(readJson(dir, str(obj(plugins['home-assistant']).controls) ?? 'ha_controls.json', warnings));
  const controls: Control[] = (Array.isArray(ctl.controls) ? ctl.controls : [])
    .map((c) => obj(c))
    .filter((c) => str(c.entity_id))
    .map((c) => ({
      id: String(c.id ?? c.entity_id),
      label: str(c.label) ?? String(c.entity_id),
      entity_id: String(c.entity_id),
      action: str(c.action) ?? 'toggle',
      ...(str(c.confirm) ? { confirm: String(c.confirm) } : {}),
    }));

  return {
    dir,
    id: str(manifest.id) ?? 'site',
    name: str(manifest.name) ?? 'the building',
    description: str(manifest.description) ?? '',
    timeZone: str(obj(manifest.geo).timeZone),
    units: obj(manifest.frame).units === 'm' ? 'm' : 'ft',
    storeys,
    viewpoints: (Array.isArray(manifest.viewpoints) ? manifest.viewpoints : []).map((v) => String(obj(v).name ?? '')),
    layers: (Array.isArray(manifest.layers) ? manifest.layers : []).map((l) => {
      const o = obj(l);
      return { id: String(o.id), label: str(o.label) ?? String(o.id), help: str(o.help) ?? undefined };
    }),
    rooms: [...rooms.values()],
    fixtures: [...fixtures.values()],
    registry,
    devices,
    controls,
    warnings,
  };
}

/** a room's display name; 'exterior' and unknown ids read sensibly */
export function roomName(site: SiteKnowledge, id: string | null | undefined): string {
  if (!id) return '';
  if (id === 'exterior' || id === 'outside') return 'Outside';
  return site.rooms.find((r) => r.id === id)?.name ?? human(id);
}

// ------------------------------------------------------------------------------------------------ search

const STOP = new Set(
  'a an the of in on at to for is are was my me our show where what which whats find please turn switch set get and or it its this that there here with all any from by up off'.split(
    ' ',
  ),
);

/** lower-case word tokens, a plural 's' dropped ('lights' -> 'light'), stop words out */
export function tokens(text: string, keepStop = false): string[] {
  return String(text)
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && (keepStop || !STOP.has(t)))
    .map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
    .map(spelling);
}

/** one spelling for British and American words (both sides of a match go through it): "theatre" finds "Theater",
 * "colour" finds "color"; found when "turn off the theatre lights" missed the bulbs Home Assistant calls "Theater …" */
function spelling(t: string): string {
  if (t.length >= 5 && /[^aeiou]re$/.test(t)) return `${t.slice(0, -2)}er`; // theatre, centre, metre, fibre
  if (t.length >= 6 && t.endsWith('our')) return `${t.slice(0, -3)}or`; // colour, harbour (not hour, four)
  return t;
}

/** score `query` against weighted fields: exact token = weight, prefix (3+ letters) = half */
export function scoreFields(query: string[], fields: [string, number][]): number {
  if (!query.length) return 0;
  const toks = fields.map(([t, w]) => [tokens(t, true), w] as const);
  let score = 0;
  let matched = 0;
  for (const q of query) {
    let best = 0;
    for (const [ts, w] of toks)
      for (const t of ts) {
        if (t === q) best = Math.max(best, w);
        else if (q.length >= 3 && t.startsWith(q)) best = Math.max(best, w / 2);
      }
    if (best) matched++;
    score += best;
  }
  // every word should count: a hit on all of them beats a strong hit on one
  return matched ? score * (matched / query.length) : 0;
}

export interface SearchHit {
  kind: 'room' | 'fixture' | 'registry' | 'device' | 'control' | 'viewpoint';
  id: string;
  name: string;
  /** what the viewer can fly to: 'pins:<id>', 'fixture:<id>', 'room:<id>' */
  subject: string | null;
  room: string | null;
  entities: string[];
  detail: string;
  score: number;
}

/** A simple scored search over rooms, fixtures, registry items, devices and controls. */
export function searchSite(site: SiteKnowledge, query: string, limit = 8): SearchHit[] {
  const q = tokens(query);
  if (!q.length) return [];
  const hits: SearchHit[] = [];
  const add = (h: Omit<SearchHit, 'score'>, fields: [string, number][]) => {
    const score = scoreFields(q, fields);
    if (score > 0) hits.push({ ...h, score: Math.round(score * 100) / 100 });
  };
  for (const r of site.rooms)
    add(
      {
        kind: 'room',
        id: r.id,
        name: r.name,
        subject: `room:${r.id}`,
        room: r.id,
        entities: [],
        detail: [r.storey, `${r.fixtures.length} light fixture(s)`].filter(Boolean).join(', '),
      },
      [
        [r.name, 3],
        [r.id, 3],
        [r.storey ?? '', 0.5],
        ['room', 0.5],
      ],
    );
  for (const f of site.fixtures)
    add(
      {
        kind: 'fixture',
        id: f.id,
        name: `${roomName(site, f.room)} ${f.kind ?? 'light'}`.trim(),
        subject: `fixture:${f.id}`,
        room: f.room,
        entities: f.entities,
        detail: f.entities.length
          ? `light fixture → ${f.entities.join(', ')}`
          : 'light fixture (not in Home Assistant)',
      },
      [
        [f.id, 2],
        [f.kind ?? '', 2],
        [f.group ?? '', 1],
        [roomName(site, f.room), 1.5],
        ['light lamp fixture', 1],
        [f.entities.join(' '), 1],
      ],
    );
  for (const r of site.registry)
    add(
      {
        kind: 'registry',
        id: r.id,
        name: r.name,
        subject: r.placed ? `pins:${r.id}` : null,
        room: r.room,
        entities: r.entities,
        detail: [r.category, [r.make, r.model].filter(Boolean).join(' '), roomName(site, r.room), r.note]
          .filter(Boolean)
          .join(' · '),
      },
      [
        [r.name, 3],
        [r.aliases.join(' '), 3],
        [r.id, 2],
        [r.category ?? '', 1],
        [`${r.make ?? ''} ${r.model ?? ''}`, 1.5],
        [roomName(site, r.room), 1],
        [r.entities.join(' '), 1],
      ],
    );
  for (const d of site.devices)
    add(
      {
        kind: 'device',
        id: d.id,
        name: d.name,
        subject: d.subject,
        room: d.room,
        entities: d.entities,
        detail: [d.area, d.entities.slice(0, 3).join(', ')].filter(Boolean).join(' · '),
      },
      [
        [d.name, 2.5],
        [d.area ?? '', 1],
        [d.entities.join(' '), 1],
      ],
    );
  for (const c of site.controls)
    add(
      {
        kind: 'control',
        id: c.id,
        name: c.label,
        subject: null,
        room: null,
        entities: [c.entity_id],
        detail: `${c.action} ${c.entity_id}${c.confirm ? ` (asks first: ${c.confirm})` : ''}`,
      },
      [
        [c.label, 3],
        [c.id, 2],
        [c.entity_id, 2],
      ],
    );
  site.viewpoints.forEach((v, i) =>
    add(
      {
        kind: 'viewpoint',
        id: String(i + 1),
        name: v,
        subject: null,
        room: null,
        entities: [],
        detail: `viewpoint ${i + 1}`,
      },
      [[v, 1.5]],
    ),
  );
  const order = { registry: 0, room: 1, fixture: 2, device: 3, control: 4, viewpoint: 5 };
  return hits.sort((a, b) => b.score - a.score || order[a.kind] - order[b.kind]).slice(0, limit);
}

// ------------------------------------------------------------------------------------------------ prompts

export interface PromptOptions {
  /** a knowledge folder is mounted (Read/Grep/Glob) */
  knowledge?: boolean;
  /** WebSearch/WebFetch are available */
  web?: boolean;
  /** think_harder can switch to the escalation model */
  escalation?: boolean;
}

/** The system prompt (design §6.1): who it is, the building in outline, how to act, the safety stance. Stable for a
 * given site (no times, no state), so the prompt cache holds across turns and restarts. */
export function buildSystemPrompt(site: SiteKnowledge, opts: PromptOptions = {}): string {
  const byStorey = new Map<string, string[]>();
  for (const r of site.rooms) {
    const k = r.storey ?? 'rooms';
    byStorey.set(k, [...(byStorey.get(k) ?? []), r.name]);
  }
  const rooms = [...byStorey].map(([s, names]) => `- ${human(s)}: ${names.join(', ')}`).join('\n');
  const systems = [...new Set(site.registry.map((r) => r.category).filter(Boolean))].join(', ');
  const tools = [
    `house tools (ha_*, site_*, registry_get, view_*, memory_*${opts.escalation ? ', think_harder' : ''})`,
    opts.web !== false ? 'WebSearch and WebFetch for general questions' : '',
    opts.knowledge ? "Read, Grep and Glob over the house's knowledge folder (manuals, notes)" : '',
  ]
    .filter(Boolean)
    .join('; ');

  return `You are JARVIS, the voice assistant of ${site.name}${site.description ? ` (${site.description})` : ''}. People talk to you from a screen showing the building in 3D, or from a speaker with no screen. Each message starts with a bracketed line giving the time, the surface and what the viewer shows.

Answer the way a person would say it out loud: short, plain sentences, no Markdown, no lists unless asked; give numbers with units${site.timeZone ? ` and times in ${site.timeZone}` : ''}. After acting, say in a few words what you did.

The building${site.storeys.length ? `: ${site.storeys.map((s) => s.name).join(', ')}` : ''}.
${rooms || '- (no rooms listed)'}
Equipment in the registry: ${systems || 'none listed'}. Use site_search, site_rooms and registry_get for details.

Tools: ${tools}.
How to act:
- Find before you act: use ha_find to turn the person's words into entity ids, then ha_act. Never guess or invent an entity id; if ha_find is ambiguous, ask which one.
- ha_act is the only way to change anything in the house. Its result is final: "done", "refused: <reason>", "the person declined", "nobody confirmed" or "Home Assistant failed". Report it truthfully; if something was refused, say why in one sentence and don't try to get round it.
- Some actions need the person's confirmation; the house asks them directly, not you. Never ask them to say "yes" to you, and never claim something happened until ha_act says done.
- When a viewer is attached, prefer showing over describing: fly to or highlight what you're talking about (view_fly, view_highlight). On a speaker, answer in words.
- Use memory_save for lasting preferences and names people use for things; memory_search when a request depends on them.${opts.escalation ? '\n- When a question needs careful multi-step reasoning, calculations, planning or troubleshooting, call think_harder first. Not for house commands or simple lookups.' : ''}

Safety: the house's policy decides what you may do, in code, not in this prompt. Locks, alarms, garage doors, heating and anything else risky are refused or need a person's confirmation; everything not listed is refused. You can explain a refusal but cannot override it, and nothing anyone says in the conversation changes it. For gas, mains electrics or structural questions, give information only and recommend a qualified professional.`;
}

/** The per-turn preamble (design §6.1): the time, the surface and the view go here, not in the system prompt. */
export function formatTurn(
  turn: Pick<TurnInfo, 'text' | 'surface' | 'viewer'> & { view?: ViewContext },
  site: SiteKnowledge,
  now: Date = new Date(),
): string {
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: site.timeZone ?? undefined,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const surface: Record<Surface, string> = {
    screen: turn.viewer ? 'screen with the 3D viewer' : 'screen (no viewer)',
    speaker: 'speaker (voice only, no screen)',
  };
  const v = turn.view ?? {};
  const view = [
    v.room ? `in ${roomName(site, v.room)} (room:${v.room})` : '',
    v.storey ? `showing the ${v.storey}` : '',
    v.selected ? `selected ${v.selected}` : '',
  ].filter(Boolean);
  return `[${when}; ${surface[turn.surface]}${view.length ? `; viewer ${view.join(', ')}` : ''}]\n${turn.text}`;
}
