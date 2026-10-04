// How the plugin talks to the assistant server: one small interface (send, onMessage, onState, close) with two
// implementations, the real WebSocket below and the scripted in-page fake (mock.ts, ?assistant=mock), so the panel,
// the confirmations and the viewer commands run the same code either way.
//
// The socket reconnects with backoff (1 s doubling to a minute, with jitter) and stays quiet about it: no toasts, only
// the state, which the status item shows ("Assistant offline"). On every (re)connect it sends `hello` first, with a
// per-tab client id (sessionStorage, so a reload keeps it and the server can re-offer a pending confirmation).
import type { ClientMsg, HelloMsg, ServerMsg } from '../../../server/src/core/protocol.ts';

export type ConnState = 'connecting' | 'connected' | 'offline';

export interface Transport {
  /** false if it couldn't be sent (not connected) */
  send(m: ClientMsg): boolean;
  onMessage(fn: (m: ServerMsg) => void): void;
  onState(fn: (s: ConnState) => void): void;
  readonly state: ConnState;
  /** ms until the next reconnect attempt, or null */
  retryIn(): number | null;
  /** try again now (the panel's Retry) */
  retry(): void;
  close(): void;
}

/** the WebSocket and transcription URLs for a server base ('/assistant', 'https://host:8787/assistant'), relative to
 * the page; http(s) becomes ws(s) */
export function endpoints(server: string, base: string): { ws: string; transcribe: string } {
  const root = new URL(`${server.replace(/\/+$/, '')}/`, base);
  const ws = new URL('ws', root);
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : ws.protocol === 'http:' ? 'ws:' : ws.protocol;
  return { ws: ws.href, transcribe: new URL('transcribe', root).href };
}

/** reconnect delays: 1 s, 2 s, 4 s … up to a minute; ±20 % jitter so several tabs don't knock together */
export function backoff(attempt: number, rnd = Math.random): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.4 * rnd()));
}

/** a stable id for this tab (sessionStorage: survives a reload, not a new tab) */
export function clientId(): string {
  const k = 'jarvis.assistant.clientId';
  try {
    const v = sessionStorage.getItem(k);
    if (v) return v;
    const id = crypto.randomUUID?.() || `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(k, id);
    return id;
  } catch {
    return `c-${Date.now().toString(36)}`;
  }
}

/** is it a server message we understand (a JSON object with a string type)? */
export function parseServerMsg(data: unknown): ServerMsg | null {
  if (typeof data !== 'string') return null;
  try {
    const m = JSON.parse(data) as { type?: unknown };
    return m && typeof m === 'object' && typeof m.type === 'string' ? (m as ServerMsg) : null;
  } catch {
    return null;
  }
}

/** a connection that never answers in this long is given up and retried (a proxy that swallows the upgrade) */
const CONNECT_TIMEOUT = 8000;

export function createSocketTransport(opts: {
  url: string;
  /** the hello to send on each connect (the view context changes) */
  hello(): HelloMsg;
}): Transport {
  let ws: WebSocket | null = null;
  let state: ConnState = 'connecting';
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryAt: number | null = null;
  let closed = false;
  const msgFns: ((m: ServerMsg) => void)[] = [];
  const stateFns: ((s: ConnState) => void)[] = [];
  const set = (s: ConnState) => {
    if (s === state) return;
    state = s;
    for (const f of stateFns) f(s);
  };

  const schedule = () => {
    if (closed) return;
    const ms = backoff(attempt++);
    retryAt = Date.now() + ms;
    timer = setTimeout(connect, ms);
  };

  function connect(): void {
    clearTimeout(timer);
    retryAt = null;
    if (closed) return;
    let sock: WebSocket;
    try {
      sock = new WebSocket(opts.url);
    } catch {
      set('offline');
      return schedule();
    }
    ws = sock;
    const giveUp = setTimeout(() => sock.close(), CONNECT_TIMEOUT);
    sock.onopen = () => {
      clearTimeout(giveUp);
      attempt = 0;
      sock.send(JSON.stringify(opts.hello()));
      set('connected');
    };
    sock.onmessage = (e) => {
      const m = parseServerMsg(e.data);
      if (m) for (const f of msgFns) f(m);
    };
    sock.onclose = () => {
      clearTimeout(giveUp);
      if (ws !== sock) return;
      ws = null;
      // a lost connection and every failed try are "offline": the retries don't flicker "connecting"
      set('offline');
      schedule();
    };
    sock.onerror = () => {}; // onclose follows
  }

  const online = () => {
    if (state === 'offline' && !ws) connect();
  };
  addEventListener('online', online);
  connect();

  return {
    send(m) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(m));
      return true;
    },
    onMessage: (fn) => void msgFns.push(fn),
    onState: (fn) => void stateFns.push(fn),
    get state() {
      return state;
    },
    retryIn: () => (retryAt == null ? null : Math.max(0, retryAt - Date.now())),
    retry() {
      if (state !== 'offline' || ws) return; // (a retry already under way)
      attempt = 0;
      connect();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      removeEventListener('online', online);
      const s = ws;
      ws = null;
      s?.close();
    },
  };
}
