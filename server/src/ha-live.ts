// The live Home Assistant backend: one websocket to HA's /api/websocket, authenticated with a long-lived token. It acts
// as the assistant's OWN Home Assistant user, a dedicated non-admin user (e.g. "JARVIS assistant", design §2.3), so
// every action shows up in HA's logbook under that user and revoking it is one click. Never give it an admin's token.
// The person's own HA login (from the viewer) is for identifying who is talking; it is never used here.
//
// Only the gate (core/gate.ts) may call callService. This file just speaks the protocol: auth, get_states,
// history/history_during_period and call_service, with a timeout on every request and reconnection with exponential
// backoff. Requests made while disconnected wait for the connection (up to their timeout).
//
// Tests: the framing is unit-tested against a fake in-process socket (server/test/ha-live.test.ts); nothing here is ever
// exercised against a real Home Assistant in tests.
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
  const makeSocket =
    opts.socket ??
    ((u: string) => {
      const WS = (globalThis as { WebSocket?: new (u: string) => SocketLike }).WebSocket;
      if (!WS) throw new Error('no global WebSocket (Node 22 or later needed)');
      return new WS(u);
    });

  let ws: SocketLike | null = null;
  let authed = false;
  let closed = false;
  let nextId = 1;
  let delay = backoffMin;
  let retry: unknown = null;
  const inflight = new Map<number, Waiting>();
  let readyWaiters: { resolve(): void; reject(e: Error): void }[] = [];

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
