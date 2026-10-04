// The live Home Assistant backend: one websocket to HA's /api/websocket, authenticated with a long-lived token. It acts
// as the assistant's OWN Home Assistant user, a dedicated non-admin user (e.g. "JARVIS assistant", design §2.3), so
// every action shows up in HA's logbook under that user and revoking it is one click. Never give it an admin's token.
// The person's own HA login (from the viewer) is for identifying who is talking: currentUser() checks it on a separate,
// one-off websocket (auth, auth/current_user, close) and never on this connection (createHaUserCheck below).
//
// Only the gate (core/gate.ts) may call callService. This file just speaks the protocol: auth, get_states,
// history/history_during_period and call_service, with a timeout on every request and reconnection with exponential
// backoff. Requests made while disconnected wait for the connection (up to their timeout).
//
// Tests: the framing is unit-tested against a fake in-process socket (server/test/ha-live.test.ts); nothing here is ever
// exercised against a real Home Assistant in tests.
import { createHash } from 'node:crypto';
import type { HaIdentity } from './core/auth.ts';
import type { HaBackend, HaHistoryPoint, HaState } from './core/types.ts';

/** the part of the WHATWG WebSocket this client uses (Node 22's global WebSocket, or a fake in tests) */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface LiveHaOptions {
  /** HA's base URL (https://ha.example.org:8123) or its websocket URL (wss://…/api/websocket) */
  url: string;
  /** a long-lived access token of the assistant's own non-admin HA user */
  token: string;
  /** per request (ms) */
  timeoutMs?: number;
  /** first and largest reconnect delay (ms) */
  backoffMs?: [number, number];
  /** builds the socket (default: the global WebSocket) */
  socket?: (url: string) => SocketLike;
  log?: (msg: string) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface LiveHa extends HaBackend {
  readonly kind: 'live';
  /** resolves once authenticated (rejects if the token is refused) */
  ready(): Promise<void>;
  readonly connected: boolean;
}

export interface HaUserCheckOptions {
  url: string;
  /** the assistant's own token: a person presenting it is refused (it would make them the assistant); a fast path */
  ownToken?: string;
  /** the assistant's own HA user id: a token of that user is refused, whatever its string (rejects: not known yet, so
   * the check can't be made: the login is retried later) */
  ownUserId?: () => Promise<string>;
  /** the whole check (ms, default 5 s) */
  timeoutMs?: number;
  /** how long a good answer is remembered, by the token's hash (ms, default 60 s); refusals never are */
  cacheMs?: number;
  socket?: (url: string) => SocketLike;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/**
 * Who a person's Home Assistant access token belongs to (the `ha` login, core/auth.ts): a fresh websocket with THAT
 * token (auth, then auth/current_user, then close). null: HA refused the token. Throws: HA couldn't be asked (no
 * answer in time, the socket failed), which the authenticator treats as "not authorised" too. The token is not kept;
 * a good answer is cached for a minute under the token's SHA-256, so a reconnecting tab doesn't ask HA every time.
 * Any token of the assistant's own HA user is refused (null), not just its own token string.
 */
export function createHaUserCheck(o: HaUserCheckOptions): (token: string) => Promise<HaIdentity | null> {
  const url = websocketUrl(o.url);
  const timeoutMs = o.timeoutMs ?? 5_000;
  const cacheMs = o.cacheMs ?? 60_000;
  const now = o.now ?? Date.now;
  const setT = o.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearT = o.clearTimeout ?? ((h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
  const makeSocket = o.socket ?? defaultSocket;
  const cache = new Map<string, { who: HaIdentity; until: number }>();

  /** the person, unless it is the assistant's own user */
  const notOwn = async (who: HaIdentity | null) =>
    who && o.ownUserId && who.id === (await o.ownUserId()) ? null : who;

  return async (token) => {
    if (typeof token !== 'string' || !token) return null;
    if (o.ownToken && token.trim() === o.ownToken.trim()) return null;
    const key = createHash('sha256').update(token).digest('hex');
    const hit = cache.get(key);
    if (hit && hit.until > now()) return notOwn(hit.who);
    cache.delete(key);
    for (const [k, v] of cache) if (v.until <= now()) cache.delete(k);

    const who = await new Promise<HaIdentity | null>((resolve, reject) => {
      let sock: SocketLike;
      let done = false;
      const finish = (err: Error | null, v: HaIdentity | null = null) => {
        if (done) return;
        done = true;
        clearT(timer);
        try {
          sock?.close();
        } catch {}
        if (err) reject(err);
        else resolve(v);
      };
      const timer = setT(() => finish(new Error(`Home Assistant did not answer within ${timeoutMs} ms`)), timeoutMs);
      try {
        sock = makeSocket(url);
      } catch (e) {
        return finish(e instanceof Error ? e : new Error(String(e)));
      }
      sock.onerror = () => {}; // onclose follows
      sock.onclose = () => finish(new Error('the Home Assistant connection closed'));
      sock.onmessage = (ev) => {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (m.type === 'auth_required') sock.send(JSON.stringify({ type: 'auth', access_token: token }));
        else if (m.type === 'auth_invalid') finish(null, null);
        else if (m.type === 'auth_ok') sock.send(JSON.stringify({ id: 1, type: 'auth/current_user' }));
        else if (m.type === 'result' && m.id === 1) {
          const r = (m.result ?? {}) as Record<string, unknown>;
          if (!m.success || typeof r.id !== 'string') return finish(new Error('auth/current_user failed'));
          const name = typeof r.name === 'string' && r.name ? r.name : r.id;
          finish(null, { id: r.id, name, is_admin: r.is_admin === true });
        }
      };
    });
    if (who) cache.set(key, { who, until: now() + cacheMs });
    return notOwn(who);
  };
}

function defaultSocket(u: string): SocketLike {
  const WS = (globalThis as { WebSocket?: new (u: string) => SocketLike }).WebSocket;
  if (!WS) throw new Error('no global WebSocket (Node 22 or later needed)');
  return new WS(u);
}

/** https://host:8123 → wss://host:8123/api/websocket */
export function websocketUrl(url: string): string {
  const u = new URL(url);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  if (!u.pathname.endsWith('/api/websocket')) u.pathname = `${u.pathname.replace(/\/+$/, '')}/api/websocket`;
  return u.toString();
}

interface Waiting {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: unknown;
}

export function createLiveHa(opts: LiveHaOptions): LiveHa {
  const url = websocketUrl(opts.url);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const [backoffMin, backoffMax] = opts.backoffMs ?? [1_000, 30_000];
  const log = opts.log ?? (() => {});
  const setT = opts.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
  const makeSocket = opts.socket ?? defaultSocket;
  const userCheck = createHaUserCheck({
    url: opts.url,
    ownToken: opts.token,
    ownUserId: () => ownUser(),
    socket: opts.socket,
    setTimeout: opts.setTimeout,
    clearTimeout: opts.clearTimeout,
  });

  let ws: SocketLike | null = null;
  let authed = false;
  let closed = false;
  let nextId = 1;
  let delay = backoffMin;
  let retry: unknown = null;
  const inflight = new Map<number, Waiting>();
  let readyWaiters: { resolve(): void; reject(e: Error): void }[] = [];
  /** the assistant's own HA user id (auth/current_user on this connection, once), and the request for it */
  let ownId: string | null = null;
  let asking: Promise<string> | null = null;

  /** who the assistant is in Home Assistant (asked once connected; a person's token of that user is refused) */
  function ownUser(): Promise<string> {
    if (ownId) return Promise.resolve(ownId);
    asking ??= request<{ id?: unknown }>({ type: 'auth/current_user' })
      .then((r) => {
        if (typeof r?.id !== 'string' || !r.id) throw new Error('auth/current_user gave no user id');
        ownId = r.id;
        return r.id;
      })
      .finally(() => (asking = null));
    return asking;
  }

  const settleReady = (err?: Error) => {
    const ws_ = readyWaiters;
    readyWaiters = [];
    for (const w of ws_) {
      if (err) w.reject(err);
      else w.resolve();
    }
  };

  function connect() {
    if (closed) return;
    authed = false;
    let sock: SocketLike;
    try {
      sock = makeSocket(url);
    } catch (e) {
      log(`ha-live: ${(e as Error).message}`);
      return scheduleReconnect();
    }
    ws = sock;
    sock.onmessage = (ev) => onMessage(sock, ev.data);
    sock.onerror = () => {}; // onclose follows
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      authed = false;
      for (const [id, w] of inflight) {
        clearT(w.timer);
        inflight.delete(id);
        w.reject(new Error('Home Assistant connection closed'));
      }
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (closed || retry) return;
    log(`ha-live: reconnecting in ${delay} ms`);
    retry = setT(() => {
      retry = null;
      connect();
    }, delay);
    delay = Math.min(delay * 2, backoffMax);
  }

  function onMessage(sock: SocketLike, raw: unknown) {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    // HA may batch messages into an array (coalesce_messages); we don't ask for it, but accept it
    if (Array.isArray(msg)) {
      for (const m of msg) onMessage(sock, JSON.stringify(m));
      return;
    }
    switch (msg.type) {
      case 'auth_required':
        sock.send(JSON.stringify({ type: 'auth', access_token: opts.token }));
        return;
      case 'auth_ok':
        authed = true;
        delay = backoffMin;
        log('ha-live: connected');
        settleReady();
        if (!ownId) ownUser().catch((e) => log(`ha-live: couldn't learn the assistant's own user: ${e.message}`));
        return;
      case 'auth_invalid':
        log(`ha-live: token refused: ${String(msg.message ?? '')}`);
        settleReady(new Error(`Home Assistant refused the token: ${String(msg.message ?? '')}`));
        sock.close(); // onclose reconnects with backoff: the token may be fixed without a restart
        return;
      case 'result': {
        const w = inflight.get(msg.id as number);
        if (!w) return;
        inflight.delete(msg.id as number);
        clearT(w.timer);
        if (msg.success) w.resolve(msg.result);
        else {
          const e = (msg.error ?? {}) as { code?: string; message?: string };
          w.reject(new Error(`Home Assistant: ${e.message ?? 'error'}${e.code ? ` (${e.code})` : ''}`));
        }
        return;
      }
    }
  }

  /** wait until authenticated, at most `ms` */
  function whenReady(ms: number): Promise<void> {
    if (authed && ws) return Promise.resolve();
    if (closed) return Promise.reject(new Error('Home Assistant client closed'));
    return new Promise((resolve, reject) => {
      const timer = setT(() => {
        readyWaiters = readyWaiters.filter((w) => w !== waiter);
        reject(new Error('not connected to Home Assistant'));
      }, ms);
      const waiter = {
        resolve: () => {
          clearT(timer);
          resolve();
        },
        reject: (e: Error) => {
          clearT(timer);
          reject(e);
        },
      };
      readyWaiters.push(waiter);
    });
  }

  async function request<T>(payload: Record<string, unknown>): Promise<T> {
    await whenReady(timeoutMs);
    const sock = ws!;
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setT(() => {
        inflight.delete(id);
        reject(new Error(`Home Assistant did not answer ${String(payload.type)} within ${timeoutMs} ms`));
      }, timeoutMs);
      inflight.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        sock.send(JSON.stringify({ id, ...payload }));
      } catch (e) {
        inflight.delete(id);
        clearT(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  connect();

  return {
    kind: 'live',
    get connected() {
      return authed && !!ws;
    },
    ready: () => whenReady(timeoutMs),
    async states(ids) {
      const all = await request<HaState[]>({ type: 'get_states' });
      if (!ids) return all;
      const want = new Set(ids);
      return all.filter((s) => want.has(s.entity_id));
    },
    async history(entityId, from, to) {
      const res = await request<Record<string, { s?: string; lu?: number; lc?: number }[]>>({
        type: 'history/history_during_period',
        start_time: from.toISOString(),
        end_time: to.toISOString(),
        entity_ids: [entityId],
        minimal_response: true,
        no_attributes: true,
        significant_changes_only: false,
      });
      const rows = res?.[entityId] ?? [];
      return rows
        .filter((r) => typeof r.s === 'string')
        .map((r): HaHistoryPoint => ({ state: r.s!, at: new Date((r.lc ?? r.lu ?? 0) * 1000).toISOString() }));
    },
    currentUser: (token) => userCheck(token),
    async callService(domain, service, data) {
      const { entity_id, ...serviceData } = data;
      await request({ type: 'call_service', domain, service, service_data: serviceData, target: { entity_id } });
    },
    close() {
      closed = true;
      if (retry) clearT(retry);
      retry = null;
      settleReady(new Error('Home Assistant client closed'));
      const s = ws;
      ws = null;
      for (const [id, w] of inflight) {
        clearT(w.timer);
        inflight.delete(id);
        w.reject(new Error('Home Assistant client closed'));
      }
      s?.close();
    },
  };
}
