// A pretend Home Assistant for development and tests: the demo building's lights (from examples/demo-site/ha_map.json),
// the controls file's scripts and switches, and a handful of made-up entities so every policy tier can be shown (a
// thermostat to confirm, a lock and a garage door to refuse, a timed valve and pump, a network switch that must never
// be switched). Only the demo building: never point it at a real site's files. No network, no real HA.
// callService changes states the obvious way and records every call in `calls`; history is synthetic and
// deterministic (seeded), so tests can assert on it. respond answers weather.get_forecasts only (synthetic daily or
// hourly forecasts from the clock and the seed) and records it in `responds`.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HaIdentity } from './auth.ts';
import type { HaBackend, HaHistoryPoint, HaState } from './types.ts';

export interface MockHaOptions {
  /** seeds the synthetic history */
  seed?: number;
  /** the demo site folder (default: the repo's examples/demo-site) */
  siteDir?: string;
  /** the clock for last_changed (default Date.now) */
  now?: () => number;
}

export interface MockHa extends HaBackend {
  readonly kind: 'mock';
  /** every callService, in order (data as given) */
  readonly calls: { domain: string; service: string; data: { entity_id: string[] } & Record<string, unknown> }[];
  /** every respond, in order (data as given) */
  readonly responds: { domain: string; service: string; data: { entity_id: string[] } & Record<string, unknown> }[];
  /** the live state objects, by entity id (tests may poke them) */
  readonly entities: Map<string, HaState>;
}

/** the made-up entities (besides the demo site's lights, scripts and switches) */
export const MOCK_EXTRA_IDS: readonly string[] = [
  'climate.hall_thermostat',
  'lock.front_door',
  'cover.garage_door',
  'valve.garden_zone_1',
  'switch.pond_pump',
  'switch.network_rack',
  'weather.home',
  'sensor.outdoor_temperature',
  'sensor.pond_pump_power',
  'fan.bedroom_fan',
  'scene.evening',
  'scene.away',
];

export const DEMO_SITE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../examples/demo-site');

/** ha_map.json fixture prefixes → the demo rooms */
const ROOMS: Readonly<Record<string, string>> = {
  living: 'Living room',
  kitchen: 'Kitchen',
  hall: 'Hall',
  study: 'Study',
  bedroom_1: 'Bedroom 1',
  bedroom_2: 'Bedroom 2',
  landing: 'Landing',
  bathroom: 'Bathroom',
  porch: 'Porch',
  terrace: 'Terrace',
};

interface MapEntry {
  entity_id?: string | string[] | null;
}
interface Control {
  entity_id?: string;
  label?: string;
  action?: string;
  mock?: { lights_off?: string[] };
}

const words = (objectId: string) => {
  const w = objectId.replace(/_/g, ' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/** the made-up entities' starting states */
function extras(): HaState[] {
  const s = (entity_id: string, state: string, attributes: HaState['attributes']): HaState => ({
    entity_id,
    state,
    attributes,
  });
  return [
    s('climate.hall_thermostat', 'heat', {
      friendly_name: 'Hall thermostat',
      area: 'Hall',
      temperature: 70,
      current_temperature: 68,
      hvac_mode: 'heat',
      hvac_modes: ['off', 'heat', 'cool', 'heat_cool'],
      min_temp: 45,
      max_temp: 95,
      unit_of_measurement: '°F',
    }),
    s('lock.front_door', 'locked', { friendly_name: 'Front door lock', area: 'Hall' }),
    s('cover.garage_door', 'closed', { friendly_name: 'Garage door', device_class: 'garage', area: 'Porch' }),
    s('valve.garden_zone_1', 'closed', { friendly_name: 'Garden zone 1', device_class: 'water', area: 'Garden' }),
    s('switch.pond_pump', 'off', { friendly_name: 'Pond pump', area: 'Garden' }),
    s('sensor.pond_pump_power', '0', {
      friendly_name: 'Pond pump power',
      device_class: 'power',
      unit_of_measurement: 'W',
      area: 'Garden',
    }),
    s('switch.network_rack', 'on', { friendly_name: 'Network rack power', area: 'Study' }),
    s('weather.home', 'partlycloudy', {
      friendly_name: 'Home',
      temperature: 81,
      humidity: 64,
      temperature_unit: '°F',
      forecast: [
        { datetime: '2026-01-01T00:00:00Z', condition: 'sunny', temperature: 84, templow: 70, precipitation: 0 },
        { datetime: '2026-01-02T00:00:00Z', condition: 'rainy', temperature: 79, templow: 71, precipitation: 12 },
        { datetime: '2026-01-03T00:00:00Z', condition: 'partlycloudy', temperature: 82, templow: 69, precipitation: 1 },
      ],
    }),
    s('sensor.outdoor_temperature', '79', {
      friendly_name: 'Outdoor temperature',
      device_class: 'temperature',
      unit_of_measurement: '°F',
      area: 'Terrace',
    }),
    s('fan.bedroom_fan', 'off', { friendly_name: 'Bedroom fan', percentage: 0, area: 'Bedroom 1' }),
    s('scene.evening', 'scening', { friendly_name: 'Evening', area: 'Living room' }),
    // a scene that sets more than lights (in a real house: locks, covers, the alarm), to show why scenes are named
    s('scene.away', 'scening', { friendly_name: 'Away' }),
  ];
}

/** mulberry32: a small seeded PRNG */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** The mock's logins (JARVIS_ASSISTANT_AUTH=ha with JARVIS_HA_MODE=mock, never live): a token `mock-user:<name>` is
 * the user <name> (id `mock-<name, lower case>`); anything else is refused. */
export function mockCurrentUser(token: string): HaIdentity | null {
  const m = /^mock-user:([A-Za-z0-9._ -]{1,64})$/.exec(typeof token === 'string' ? token : '');
  if (!m || !m[1].trim()) return null;
  const name = m[1].trim();
  return { id: `mock-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, is_admin: false };
}

/** the most hourly history points one call returns (a month) */
const MAX_POINTS = 24 * 31;

/** how many forecast entries weather.get_forecasts gives, by type */
const FORECAST_LEN: Readonly<Record<string, number>> = { daily: 10, hourly: 48 };
const CONDITIONS = ['sunny', 'partlycloudy', 'cloudy', 'rainy', 'lightning-rainy', 'partlycloudy', 'sunny'];

/** a synthetic forecast for a weather entity: from the next midnight / hour (UTC), deterministic for the clock and seed */
function forecast(st: HaState, type: string, nowMs: number, seed: number): Record<string, unknown>[] {
  const step = type === 'daily' ? 86_400_000 : 3_600_000;
  const start = Math.ceil(nowMs / step) * step;
  const base = typeof st.attributes.temperature === 'number' ? st.attributes.temperature : 75;
  const rand = prng(seed ^ hash(`${st.entity_id}/${type}`) ^ Math.floor(start / step));
  return Array.from({ length: FORECAST_LEN[type] }, (_, i) => {
    const t = start + i * step;
    const hour = new Date(t).getUTCHours();
    const wet = rand();
    const precip = wet > 0.6 ? Math.round((wet - 0.6) * 50) / 2 : 0;
    const temp =
      type === 'daily'
        ? base + Math.round((rand() - 0.5) * 8)
        : base + Math.round(Math.sin(((hour - 9) / 24) * 2 * Math.PI) * 6);
    return {
      datetime: new Date(t).toISOString(),
      condition: precip ? (wet > 0.9 ? 'lightning-rainy' : 'rainy') : CONDITIONS[Math.floor(rand() * 3)],
      temperature: temp,
      ...(type === 'daily' ? { templow: temp - 10 - Math.round(rand() * 4) } : {}),
      precipitation_probability: Math.round(wet * 100),
      precipitation: precip,
      wind_speed: Math.round(rand() * 150) / 10,
      wind_bearing: Math.round(rand() * 360),
      humidity: 55 + Math.round(rand() * 35),
    };
  });
}

/** A mock HA over the demo building. `createMockHa()`, `createMockHa(42)` or `createMockHa({ seed, siteDir })`. */
export function createMockHa(opts: number | MockHaOptions = {}): MockHa {
  const o: MockHaOptions = typeof opts === 'number' ? { seed: opts } : opts;
  const seed = o.seed ?? 1;
  const now = o.now ?? Date.now;
  const siteDir = o.siteDir ?? DEMO_SITE_DIR;
  const readJson = (f: string): unknown => JSON.parse(readFileSync(resolve(siteDir, f), 'utf8'));

  const entities = new Map<string, HaState>();
  const at = () => new Date(now()).toISOString();
  const add = (st: HaState) => {
    if (!entities.has(st.entity_id)) entities.set(st.entity_id, { ...st, last_changed: at() });
  };

  // the lights of the fixture map (a switch.* marked as a light stays a switch)
  const map = readJson('ha_map.json') as Record<string, MapEntry>;
  const areaOf = new Map<string, string>();
  for (const [fixture, entry] of Object.entries(map)) {
    const ids = Array.isArray(entry?.entity_id) ? entry.entity_id : entry?.entity_id ? [entry.entity_id] : [];
    const prefix = fixture.split('.')[0];
    for (const id of ids) {
      if (typeof id !== 'string' || !/^(light|switch)\.[a-z0-9_]+$/.test(id)) continue;
      const area = ROOMS[prefix] ?? words(prefix);
      areaOf.set(id, area);
      let name = words(id.split('.')[1]);
      if (name === area) name += ' light';
      const light = id.startsWith('light.');
      add({
        entity_id: id,
        state: 'off',
        attributes: {
          friendly_name: name,
          area,
          ...(light ? { brightness: null, color_mode: null, supported_color_modes: ['color_temp'] } : {}),
        },
      });
    }
  }

  // the controls file's scripts / scenes / switches
  const controls = ((readJson('ha_controls.json') as { controls?: Control[] }).controls ?? []).filter(Boolean);
  const scriptOff = new Map<string, string[]>();
  for (const c of controls) {
    if (typeof c.entity_id !== 'string') continue;
    const d = c.entity_id.split('.')[0];
    if (d === 'script') {
      add({ entity_id: c.entity_id, state: 'off', attributes: { friendly_name: c.label ?? words(c.entity_id) } });
      scriptOff.set(c.entity_id, c.mock?.lights_off ?? []);
    }
  }
  for (const st of extras()) add(st);
  for (const c of controls)
    if (typeof c.entity_id === 'string' && !entities.has(c.entity_id))
      add({ entity_id: c.entity_id, state: 'off', attributes: { friendly_name: c.label ?? c.entity_id } });

  const calls: MockHa['calls'] = [];
  const responds: MockHa['responds'] = [];

  const set = (id: string, state: string, attrs: Record<string, unknown> = {}) => {
    const cur = entities.get(id)!;
    const changed = cur.state !== state;
    entities.set(id, {
      ...cur,
      state,
      attributes: { ...cur.attributes, ...attrs },
      last_changed: changed ? at() : cur.last_changed,
    });
    if (id === 'switch.pond_pump') set('sensor.pond_pump_power', state === 'on' ? '42' : '0');
  };

  const lightOn = (id: string, data: Record<string, unknown>) => {
    if (!id.startsWith('light.')) return set(id, 'on');
    const cur = entities.get(id)!.attributes;
    const pct = typeof data.brightness_pct === 'number' ? data.brightness_pct : undefined;
    const brightness =
      pct !== undefined
        ? Math.round((pct / 100) * 255)
        : typeof data.brightness === 'number'
          ? data.brightness
          : typeof cur.brightness === 'number'
            ? cur.brightness
            : 255;
    const attrs: Record<string, unknown> = { brightness, color_mode: 'color_temp' };
    if (typeof data.color_temp_kelvin === 'number') attrs.color_temp_kelvin = data.color_temp_kelvin;
    set(id, 'on', attrs);
  };
  const off = (id: string) => set(id, 'off', id.startsWith('light.') ? { brightness: null, color_mode: null } : {});

  const lightsInAreas = (areas: string[]) =>
    [...entities.values()]
      .filter((e) => areaOf.has(e.entity_id))
      .filter((e) => areas.includes('*') || areas.some((a) => (ROOMS[a] ?? words(a)) === areaOf.get(e.entity_id)))
      .map((e) => e.entity_id);

  /** domain → service → what it does to one entity */
  const SERVICES: Record<string, Record<string, (id: string, data: Record<string, unknown>) => void>> = {
    light: {
      turn_on: lightOn,
      turn_off: off,
      toggle: (id, d) => (entities.get(id)!.state === 'on' ? off(id) : lightOn(id, d)),
    },
    switch: {
      turn_on: (id) => set(id, 'on'),
      turn_off: off,
      toggle: (id) => set(id, entities.get(id)!.state === 'on' ? 'off' : 'on'),
    },
    fan: {
      turn_on: (id, d) => set(id, 'on', { percentage: typeof d.percentage === 'number' ? d.percentage : 100 }),
      turn_off: (id) => set(id, 'off', { percentage: 0 }),
      set_percentage: (id, d) => {
        const p = Number(d.percentage);
        if (!Number.isFinite(p)) throw new Error('percentage required');
        set(id, p > 0 ? 'on' : 'off', { percentage: p });
      },
    },
    climate: {
      set_temperature: (id, d) => {
        const t = Number(d.temperature);
        if (!Number.isFinite(t)) throw new Error('temperature required');
        const mode = typeof d.hvac_mode === 'string' ? d.hvac_mode : undefined;
        set(id, mode ?? entities.get(id)!.state, { temperature: t, ...(mode ? { hvac_mode: mode } : {}) });
      },
      set_hvac_mode: (id, d) => {
        const modes = entities.get(id)!.attributes.hvac_modes as string[];
        if (typeof d.hvac_mode !== 'string' || !modes.includes(d.hvac_mode)) throw new Error('bad hvac_mode');
        set(id, d.hvac_mode, { hvac_mode: d.hvac_mode });
      },
      turn_on: (id) => set(id, 'heat', { hvac_mode: 'heat' }),
      turn_off: (id) => set(id, 'off', { hvac_mode: 'off' }),
    },
    cover: {
      open_cover: (id) => set(id, 'open'),
      close_cover: (id) => set(id, 'closed'),
    },
    lock: {
      lock: (id) => set(id, 'locked'),
      unlock: (id) => set(id, 'unlocked'),
    },
    valve: {
      open_valve: (id) => set(id, 'open'),
      close_valve: (id) => set(id, 'closed'),
    },
    scene: {
      turn_on: (id) => {
        if (id === 'scene.evening') for (const l of lightsInAreas(['living'])) lightOn(l, { brightness_pct: 40 });
        if (id === 'scene.away') for (const l of lightsInAreas(['*'])) off(l);
        set(id, 'scening');
        entities.set(id, { ...entities.get(id)!, last_changed: at() });
      },
    },
    script: {
      turn_on: (id) => {
        for (const l of lightsInAreas(scriptOff.get(id) ?? [])) off(l);
        entities.set(id, { ...entities.get(id)!, last_changed: at() });
      },
    },
  };

  return {
    kind: 'mock',
    calls,
    responds,
    entities,
    async states(ids) {
      const list = ids ? ids.map((id) => entities.get(id)).filter((x): x is HaState => !!x) : [...entities.values()];
      return structuredClone(list);
    },
    async history(entityId, from, to) {
      const st = entities.get(entityId);
      if (!st) return [];
      const start = Math.ceil(from.getTime() / 3_600_000) * 3_600_000;
      const end = to.getTime();
      const rand = prng(seed ^ hash(entityId) ^ Math.floor(start / 3_600_000));
      const out: HaHistoryPoint[] = [];
      const numeric = Number.isFinite(Number(st.state)) && st.state !== '';
      const base = numeric ? Number(st.state) : 0;
      for (let t = start; t <= end && out.length < MAX_POINTS; t += 3_600_000) {
        const hour = new Date(t).getUTCHours();
        let state: string;
        if (numeric) state = (base + Math.sin(((hour - 9) / 24) * 2 * Math.PI) * 6 + (rand() - 0.5) * 2).toFixed(1);
        else if (st.entity_id.startsWith('climate.')) state = rand() < 0.1 ? 'off' : st.state;
        else if (/^(light|switch|fan)\./.test(entityId))
          state = (hour >= 18 || hour < 7) && rand() < 0.7 ? 'on' : 'off';
        else if (/^(cover|valve)\./.test(entityId)) state = rand() < 0.05 ? 'open' : 'closed';
        else state = st.state;
        out.push({ state, at: new Date(t).toISOString() });
      }
      return out;
    },
    async currentUser(token) {
      return mockCurrentUser(token);
    },
    async callService(domain, service, data) {
      const handler = SERVICES[domain]?.[service];
      if (!handler) throw new Error(`mock HA: unknown service ${domain}.${service}`);
      const ids = data?.entity_id;
      if (!Array.isArray(ids) || !ids.length) throw new Error('mock HA: no entity_id');
      for (const id of ids) {
        if (!entities.has(id)) throw new Error(`mock HA: unknown entity ${id}`);
        if (id.split('.')[0] !== domain) throw new Error(`mock HA: ${id} is not in ${domain}`);
      }
      calls.push({ domain, service, data: structuredClone(data) });
      const { entity_id: _ids, ...rest } = data;
      for (const id of ids) handler(id, rest);
    },
    async respond(domain, service, data) {
      if (domain !== 'weather' || service !== 'get_forecasts')
        throw new Error(`mock HA: ${domain}.${service} returns no response`);
      const ids = data?.entity_id;
      if (!Array.isArray(ids) || !ids.length) throw new Error('mock HA: no entity_id');
      const { entity_id: _ids, ...rest } = data;
      if (!Object.hasOwn(FORECAST_LEN, String(rest.type)) || Object.keys(rest).length !== 1)
        throw new Error(`mock HA: weather.get_forecasts needs type daily or hourly`);
      for (const id of ids) {
        if (!entities.has(id)) throw new Error(`mock HA: unknown entity ${id}`);
        if (!id.startsWith('weather.')) throw new Error(`mock HA: ${id} is not in weather`);
      }
      responds.push({ domain, service, data: structuredClone(data) });
      return Object.fromEntries(
        ids.map((id) => [id, { forecast: forecast(entities.get(id)!, String(rest.type), now(), seed) }]),
      );
    },
  };
}

/** every entity id the mock has (the demo site's and the made-up ones), for others' tests and fixtures */
export function mockEntityIds(opts: number | MockHaOptions = {}): string[] {
  return [...createMockHa(opts).entities.keys()];
}
