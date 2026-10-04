// The Home Assistant connector: it logs in, subscribes to the state stream and puts every entity into the core's
// store, and executes the store's calls for its entities through send() (policy.ts), under the site's allow-list.
// It knows nothing of fixtures or the model except for ?ha=mock, which makes up a state per switched fixture group.
//
// Login is Home Assistant's own browser OAuth flow (home-assistant-js-websocket): "Connect" sends the browser to HA's
// login page, which comes back here with ?auth_callback=1&code=…; the library swaps the code for tokens. The client_id
// is this page's origin, so no app has to be registered in HA. The tokens live in this browser's localStorage
// (TOKENS_KEY), as the HA frontend keeps its own; nothing is baked into the page. HA must list the viewer's origin in
// http: cors_allowed_origins, or the token exchange and the websocket fail.
// accessToken() hands the current access token (refreshed when it has expired) to other plugins through the
// `home-assistant.auth` service: the assistant logs in to its server with it. Nothing is handed out in mock or off
// mode.
// ?ha=mock replays a fake state stream instead (every fixture without a mapped entity gets a made-up one per switched
// group), for testing without a login; ?hamock=<seed> varies it, ?hamock=static stops the changes. ?ha=off never
// connects, even with stored tokens.
import {
  ERR_CANNOT_CONNECT,
  ERR_INVALID_AUTH,
  ERR_INVALID_AUTH_CALLBACK,
  callService,
  createConnection,
  getAuth,
  subscribeEntities,
  type Auth,
  type AuthData,
  type Connection,
} from 'home-assistant-js-websocket';
import type * as THREE from 'three';
import type { ConnectorHandle, HistoryPoint, StoreAction } from '../../plugin-api';
import { historyMessage, parseHistory } from './history';
import {
  allowRefusal,
  buildAllowlist,
  controlCall,
  createSender,
  entitiesOf,
  isControlAction,
  type Allowlist,
  planCalls,
} from './policy';
import type { Control, Entities, EntityState, MapEntry, ServiceData, Status, TogglePolicy } from './types';

const TOKENS_KEY = 'twin.hassTokens';

export interface MockApi {
  set(e: string, state: string, attributes?: Record<string, unknown>): void;
  load(list: EntityState[]): void;
  calls: { domain: string; service: string; data: ServiceData; t: number }[];
  /** make the next call fail with this reason */
  failNext: string | null;
  /** HA accepts but nothing changes (a dead bulb) */
  silent: boolean;
}

export interface ConnectorDeps {
  hassUrl: string;
  controlsUrl?: string;
  /** the site's fixture map (the lights plugin's): part of the allow-list, and what the mock fills in around */
  mapUrl?: string;
  mode: 'mock' | 'off' | 'live';
  /** ?hamock */
  mockSeed: string | null;
  handle: ConnectorHandle;
  /** the model's light fixtures (mock only) */
  fixtures: Record<string, THREE.Object3D>;
  /** mock: a made-up entity for a fixture (shown in the store's bindings as conf 'mock') */
  bindMock(fid: string, entity: string): void;
  onChange(): void;
}

export function createConnector(d: ConnectorDeps) {
  const HASS_URL = d.hassUrl;
  const c = {
    mode: d.mode,
    status: 'disconnected' as Status,
    error: '',
    conn: null as Connection | null,
    entities: {} as Entities,
    map: {} as Record<string, MapEntry>,
    controls: [] as Control[],
    toggle: {} as TogglePolicy,
    allow: new Map() as Allowlist,
    mock: null as MockApi | null,
    hassUrl: HASS_URL,
    /** control id -> 'sent' while a call is in flight, or an error text */
    pending: {} as Record<string, string>,
  };
  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => (timers.delete(t), disposed || fn()), ms);
    timers.add(t);
  };
  /** fixture id -> its made-up mock entity */
  const mockOf: Record<string, string> = {};

  function setStatus(s: Status, err = ''): void {
    c.status = s;
    c.error = err;
    d.handle.status(s, err);
    d.onChange();
  }
  function onEntities(ents: Entities): void {
    c.entities = ents;
    d.handle.replace(ents);
    d.onChange();
  }

  // ------------------------------------------------------------------ the site's files
  async function loadJson<T>(url: string | undefined): Promise<T | null> {
    if (!url) return null;
    try {
      const r = await fetch(url);
      return r.ok ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  }
  async function loadFiles(): Promise<void> {
    const m = await loadJson<Record<string, unknown> & { fixtures?: Record<string, unknown> }>(d.mapUrl);
    if (m)
      for (const [id, v] of Object.entries(m.fixtures || m)) if (v && typeof v === 'object') c.map[id] = v as MapEntry;
    // {controls: [...], fixture_toggle: {...}}, or a bare list (older files)
    const j = await loadJson<Control[] | { controls?: Control[]; fixture_toggle?: TogglePolicy }>(d.controlsUrl);
    if (j) {
      c.controls = (Array.isArray(j) ? j : j.controls || []).filter(
        (x) => x && x.id && x.entity_id && isControlAction(x.action),
      );
      c.toggle = (!Array.isArray(j) && j.fixture_toggle) || {};
    }
    rebuildAllow();
  }
  function rebuildAllow(): void {
    // the made-up mock lights are allowed in mock mode only, where nothing reaches Home Assistant
    const extra = c.mode === 'mock' ? Object.keys(c.entities).filter((e) => e.startsWith('light.')) : [];
    c.allow = buildAllowlist({ controls: c.controls, map: c.map, toggle: c.toggle, extra });
  }

  // ------------------------------------------------------------------ send(): the only call to Home Assistant
  const send = createSender({
    allow: () => c.allow,
    mock: () => (c.mock ? mockService : null),
    status: () => c.status,
    connected: () => !!c.conn,
    call: (domain, service, data) => callService(c.conn!, domain, service, data),
  });

  /** the store's call: one send() per domain */
  async function call(ids: string[], action: StoreAction, data: Record<string, unknown> = {}): Promise<void> {
    const plan = planCalls(ids, action, data, c.allow); // all or nothing: every domain's call checked first
    if ('refused' in plan) throw new Error(plan.refused);
    for (const [domain, sd] of plan.calls) await send(domain, action, sd);
  }
  /** past states from Home Assistant's recorder (read-only) */
  async function readHistory(entityId: string, from: number, to: number): Promise<HistoryPoint[]> {
    if (!c.conn || c.status !== 'live') throw new Error('not connected to Home Assistant');
    return parseHistory(await c.conn.sendMessagePromise(historyMessage(entityId, from, to)), entityId);
  }
  function refusal(ids: string[], action: StoreAction, data: Record<string, unknown> = {}): string | null {
    const r = allowRefusal(c.allow, action, { entity_id: ids });
    if (r) {
      const off = ids.filter((e) => !c.allow.get(e)?.has(action));
      const sw = off.some((e) => e.startsWith('switch.'));
      return `${off.join(', ')} isn't a light the model may switch (the controls file's fixture_toggle)${sw ? '; a switch needs switch_is_light in the fixture map' : ''}`;
    }
    if (!(c.status === 'live' || c.status === 'mock')) return 'not connected to Home Assistant';
    // the rest of what call() checks (each domain's service, the data's keys), so the store can refuse a call across
    // connectors before it sends any part of it
    const plan = planCalls(ids, action, data, c.allow);
    return 'refused' in plan ? plan.refused : null;
  }

  // ------------------------------------------------------------------ the Controls panel's actions
  async function act(ctl: Control, confirm: (q: string) => Promise<boolean>): Promise<string | null> {
    const cc = controlCall(c.controls, ctl, c.entities);
    if ('refused' in cc) {
      console.warn(`Home Assistant: ${cc.refused}`); // never anything outside the list
      return cc.refused;
    }
    if (ctl.confirm && !(await confirm(ctl.confirm))) return null;
    c.pending[ctl.id] = 'sent';
    d.onChange();
    try {
      if (c.mock && ctl.action === 'run') await mockRun(ctl, cc.service);
      else await send(cc.domain, cc.service, { entity_id: ctl.entity_id });
      delete c.pending[ctl.id];
      d.onChange();
      return null;
    } catch (err) {
      const why = `Failed: ${errText(err)}`;
      c.pending[ctl.id] = why;
      console.warn('Home Assistant:', err);
      later(() => {
        if (c.pending[ctl.id] !== 'sent') {
          delete c.pending[ctl.id];
          d.onChange();
        }
      }, 6000);
      d.onChange();
      return why;
    }
  }
  const errText = (err: unknown): string => {
    const e = err as { message?: string; code?: unknown } | null;
    return String(e?.message || e?.code || err);
  };

  // ------------------------------------------------------------------ live: the OAuth login and the websocket
  const saveTokens = (t: AuthData | null) => {
    try {
      if (t) localStorage.setItem(TOKENS_KEY, JSON.stringify(t));
      else localStorage.removeItem(TOKENS_KEY);
    } catch {
      /* private mode */
    }
  };
  const loadTokens = async (): Promise<AuthData | null | undefined> => {
    try {
      return JSON.parse(localStorage.getItem(TOKENS_KEY) as string) as AuthData | null;
    } catch {
      return null;
    }
  };
  const hasTokens = (): boolean => {
    try {
      return !!JSON.parse(localStorage.getItem(TOKENS_KEY) as string);
    } catch {
      return false;
    }
  };
  function why(err: unknown): string {
    if (err === ERR_INVALID_AUTH) return 'login refused or expired; connect again';
    if (err === ERR_CANNOT_CONNECT) return `can't reach ${HASS_URL}`;
    if (err === ERR_INVALID_AUTH_CALLBACK) return 'login came back for another server';
    if (err instanceof TypeError)
      return `blocked (is ${location.origin} in HA's cors_allowed_origins? See the Home Assistant docs)`;
    return String((err as Error)?.message || err);
  }

  /** the login (live mode, once connected), for accessToken() */
  let auth: Auth | null = null;
  /** a connect() under way, which accessToken() waits for */
  let connecting: Promise<void> | null = null;

  /** the person's current access token (refreshed if it has expired), or null: mock / off mode, not logged in */
  async function accessToken(): Promise<string | null> {
    if (c.mode !== 'live') return null;
    if (connecting) await connecting.catch(() => {});
    if (!auth) return null;
    try {
      if (auth.expired) await auth.refreshAccessToken();
      return auth.accessToken;
    } catch {
      return null;
    }
  }

  function connect(): Promise<void> {
    if (c.mode !== 'live' || c.conn) return Promise.resolve();
    if (connecting) return connecting;
    connecting = doConnect().finally(() => (connecting = null));
    return connecting;
  }

  async function doConnect(): Promise<void> {
    if (!HASS_URL) {
      setStatus('error', 'no Home Assistant URL in the site manifest');
      return;
    }
    setStatus('connecting');
    try {
      const a = await getAuth({ hassUrl: HASS_URL, saveTokens, loadTokens }); // may navigate away to HA's login
      if (disposed) return;
      const q2 = new URLSearchParams(location.search);
      if (q2.has('auth_callback')) {
        // tidy the login's code and state out of the address bar
        for (const k of ['auth_callback', 'code', 'state']) q2.delete(k);
        history.replaceState(null, '', location.pathname + (q2.toString() ? `?${q2}` : '') + location.hash);
      }
      if (a.expired) await a.refreshAccessToken();
      const conn = await createConnection({ auth: a });
      if (disposed) return conn.close();
      c.conn = conn;
      auth = a;
      conn.addEventListener('ready', () => setStatus('live')); // reconnected (the library retries)
      conn.addEventListener('disconnected', () => setStatus('connecting', 'connection lost, retrying'));
      conn.addEventListener('reconnect-error', (_c, e) => {
        if (e === ERR_INVALID_AUTH) {
          saveTokens(null);
          disconnect();
        }
        setStatus('error', why(e));
      });
      subscribeEntities(conn, (ents) => onEntities(ents as unknown as Entities));
      setStatus('live');
    } catch (err) {
      if (err === ERR_INVALID_AUTH) saveTokens(null);
      c.conn = null;
      auth = null;
      setStatus('error', why(err));
      console.warn('Home Assistant:', err);
    }
  }

  function disconnect(forget = false): void {
    if (c.conn) {
      c.conn.close();
      c.conn = null;
    }
    auth = null;
    if (forget) saveTokens(null);
    onEntities({});
    setStatus('disconnected');
  }

  // ------------------------------------------------------------------ mock: a fake, repeatable state stream
  // Every fixture without a mapped entity gets one per switched group (light.mock_<group>), so a group switches
  // together as it does in a real building. States come from a seeded generator (?hamock=<seed>): about 60 % on at
  // assorted brightness and colour temperature, a few RGB, about 8 % unavailable and 3 % unknown. Every 2 s one entity
  // flips, as a live building would (?hamock=static: no changes). twin.ha.mock.set(entity, state, attrs) sets one.
  let seed = +(d.mockSeed as string) || 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const now0 = Date.now();
  const invent = (e: string): EntityState => {
    const r = rnd();
    const st = r < 0.08 ? 'unavailable' : r < 0.11 ? 'unknown' : r < 0.71 ? 'on' : 'off';
    const a: EntityState['attributes'] = { friendly_name: e.replace(/^light\.mock_/, '').replace(/_/g, ' ') };
    if (st === 'on') {
      a.brightness = Math.round(70 + rnd() * 185);
      if (rnd() < 0.12) {
        a.color_mode = 'rgb';
        a.rgb_color = [255, Math.round(rnd() * 120), Math.round(80 + rnd() * 175)];
      } else {
        a.color_mode = 'color_temp';
        a.color_temp_kelvin = Math.round(2200 + rnd() * 1800);
      }
    }
    return { entity_id: e, state: st, attributes: a, last_changed: new Date(now0 - rnd() * 864e5).toISOString() };
  };
  /** every entity the map (with the mock's entries) names, mock or not */
  const mappedEntities = () => {
    const out = new Set<string>();
    for (const id of Object.keys(c.map)) for (const e of entitiesOf(c.map[id])) out.add(e);
    return out;
  };
  const seen = new Set<string>();
  // the switched group is the fixture's `fixture_group` extra (a `fixture.` prefix is dropped: docs/model-format.md)
  function adopt(ids: string[]): void {
    const fresh = ids.filter((id) => !seen.has(id));
    if (!fresh.length) return;
    for (const id of fresh) seen.add(id);
    const ents = { ...c.entities };
    for (const id of fresh) {
      if (entitiesOf(c.map[id]).length) continue;
      const g = String(d.fixtures[id].userData.fixture_group || id)
        .replace(/^fixture\./, '')
        .replace(/[^a-z0-9]+/gi, '_')
        .toLowerCase();
      const e = `light.mock_${g}`;
      c.map[id] = { ...(c.map[id] || {}), entity_id: e, conf: 'mock', src: '?ha=mock' };
      mockOf[id] = e;
      d.bindMock(id, e);
    }
    for (const e of [...mappedEntities()].sort()) if (!ents[e]) ents[e] = invent(e);
    c.entities = ents;
    rebuildAllow();
  }
  const set = (e: string, state: string, attributes: Record<string, unknown> = {}) => {
    const prev = c.entities[e] || { entity_id: e, attributes: {} };
    onEntities({
      ...c.entities,
      [e]: {
        ...prev,
        state,
        attributes: { ...prev.attributes, ...attributes },
        last_changed: new Date().toISOString(),
      },
    });
  };
  // replay recorded states (e.g. HA's /api/states) over the made-up ones
  const load = (list: EntityState[]) => {
    onEntities({ ...c.entities, ...Object.fromEntries(list.map((x) => [x.entity_id, x])) });
    rebuildAllow();
  };
  // run() plays a control's `mock` stand-in: the script is "on" for 1.5 s, then the listed rooms' mapped lights go on
  // or off
  async function mockRun(ctl: Control, service: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 250)); // a round trip
    if (ctl.action === 'toggle') {
      set(ctl.entity_id, service === 'turn_on' ? 'on' : 'off');
      if (ctl.power) set(ctl.power, service === 'turn_on' ? '490' : '0');
      return;
    }
    set(ctl.entity_id, 'on');
    later(() => {
      const m = ctl.mock || {},
        ents = { ...c.entities },
        now = new Date().toISOString();
      const inList = (list: string[] | undefined, room: string) =>
        (list || []).includes('*') || (list || []).includes(room);
      for (const [fid, node] of Object.entries(d.fixtures)) {
        const room = node.userData.room as string;
        if ((m.except || []).includes(room)) continue;
        const to = inList(m.lights_on, room) ? 'on' : inList(m.lights_off, room) ? 'off' : null;
        if (!to) continue;
        for (const e of entitiesOf(c.map[fid])) {
          if (!e.startsWith('light.')) continue; // lights only: not a plug-in switch
          const prev = ents[e] || { entity_id: e, attributes: {} };
          ents[e] = {
            ...prev,
            state: to,
            attributes: { brightness: 200, color_temp_kelvin: 2700, ...prev.attributes },
            last_changed: now,
          };
        }
      }
      ents[ctl.entity_id] = { ...ents[ctl.entity_id], state: 'off', last_changed: now };
      onEntities(ents);
    }, 1500);
  }
  // send() lands here in ?ha=mock: a 250 ms round trip, then the states change as HA would report them (a group
  // also switches its members). mock.failNext = 'reason' makes the next call fail, to test the error path;
  // mock.calls records every call.
  async function mockService(domain: string, svc: string, data: ServiceData): Promise<void> {
    const mock = c.mock!;
    mock.calls.push({ domain, service: svc, data, t: Date.now() });
    await new Promise((r) => setTimeout(r, 250));
    if (mock.failNext) {
      const m = mock.failNext;
      mock.failNext = null;
      throw new Error(m);
    }
    if (mock.silent) return; // HA accepts but nothing changes (a dead bulb)
    const ents = { ...c.entities },
      now = new Date().toISOString();
    const { entity_id: eid, ...attrs } = data;
    const apply = (e: string, to: string) => {
      const prev = ents[e] || { entity_id: e, attributes: {} };
      ents[e] = {
        ...prev,
        state: to,
        attributes: { ...prev.attributes, ...(to === 'on' ? attrs : {}) },
        last_changed: now,
      };
      for (const m of Array.isArray(prev.attributes?.entity_id) ? prev.attributes.entity_id : []) apply(m, to);
    };
    for (const e of ([] as string[]).concat(eid)) {
      const to = svc === 'toggle' ? (ents[e]?.state === 'on' ? 'off' : 'on') : svc === 'turn_on' ? 'on' : 'off';
      apply(e, to);
      if (domain === 'switch')
        for (const ctl of c.controls)
          if (ctl.entity_id === e && ctl.power)
            ents[ctl.power] = { ...ents[ctl.power], state: to === 'on' ? '490' : '0' };
    }
    onEntities(ents);
  }
  let flipper: ReturnType<typeof setInterval> | undefined;
  function startMock(): void {
    // the controls: scripts idle, a switch on at a made-up 490 W
    for (const ctl of c.controls) {
      if (!c.entities[ctl.entity_id])
        c.entities[ctl.entity_id] = {
          entity_id: ctl.entity_id,
          state: ctl.action === 'run' ? 'off' : 'on',
          attributes: { friendly_name: ctl.label },
          last_changed: new Date().toISOString(),
        };
      if (ctl.power && !c.entities[ctl.power])
        c.entities[ctl.power] = { entity_id: ctl.power, state: '490', attributes: { unit_of_measurement: 'W' } };
    }
    c.mock = { set, load, calls: [], failNext: null, silent: false };
    adopt(Object.keys(d.fixtures));
    onEntities(c.entities);
    setStatus('mock');
    if (d.mockSeed !== 'static') {
      flipper = setInterval(() => {
        const list = Object.keys(c.entities).filter(
          (e) => e.startsWith('light.') && ['on', 'off'].includes(c.entities[e].state),
        );
        const e = list[Math.floor(rnd() * list.length)];
        if (e)
          set(
            e,
            c.entities[e].state === 'on' ? 'off' : 'on',
            c.entities[e].attributes.brightness ? {} : { brightness: 200, color_temp_kelvin: 2700 },
          );
      }, 2000);
    }
  }

  // ------------------------------------------------------------------ start
  async function start(): Promise<void> {
    setStatus(c.mode === 'mock' ? 'mock' : 'disconnected');
    await loadFiles();
    if (c.mode === 'mock') return startMock();
    // reconnect by itself after the login redirect, or when this browser already holds tokens
    if (c.mode === 'live' && (new URLSearchParams(location.search).has('auth_callback') || hasTokens())) connect();
  }

  /** the extra model's lamps arrived (mock: give them made-up entities too) */
  function fixturesAdded(): void {
    if (c.mock) {
      adopt(Object.keys(d.fixtures));
      onEntities({ ...c.entities });
    }
  }

  /** the plugin stopped: no more calls, timers or states */
  function dispose(): void {
    disconnect();
    disposed = true;
    clearInterval(flipper);
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  return Object.assign(c, {
    accessToken,
    dispose,
    readHistory,
    start,
    connect,
    disconnect,
    send,
    call,
    refusal,
    act,
    fixturesAdded,
    rebuildAllow,
    mockOf,
  });
}

export type Connector = ReturnType<typeof createConnector>;
