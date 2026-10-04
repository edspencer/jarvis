// How the plugin talks to the assistant server: one small interface (send, onMessage, onState, close) with two
// implementations, the real WebSocket below and the scripted in-page fake (mock.ts, ?assistant=mock), so the panel,
// the confirmations and the viewer commands run the same code either way.
//
// The socket reconnects with backoff (1 s doubling to a minute, with jitter) and stays quiet about it: no toasts, only
// the state, which the status item shows ("Assistant offline"). On every (re)connect it sends `hello` first, with a
// per-tab client id (sessionStorage, so a reload keeps it and the server can re-offer a pending confirmation) and the
// credential the plugin finds (the Home Assistant login or an access code), and nothing else until the `welcome`: only
// then is it 'connected' (the server cuts off a connection that sends more before its login). No credential, or the
// server refusing it (close code 4401), is the 'unauthorised' state: no more tries until retry() (a new code was
// entered, say). Every other close, 4503 ("couldn't check the login right now": Home Assistant down) included, is
// 'offline' and retried with the backoff, which only a welcome resets.
import type { ClientMsg, HelloMsg, ServerMsg } from '../../../server/src/core/protocol.ts';

export type ConnState = 'connecting' | 'connected' | 'offline' | 'unauthorised';

/** the server's close code for a refused credential (don't come back with the same one) */
export const CLOSE_UNAUTHORISED = 4401;
/** the server couldn't check the credential right now (Home Assistant down or busy): retried like any lost connection */
export const CLOSE_RETRY = 4503;

export interface Transport {
  /** false if it couldn't be sent (not connected) */
  send(m: ClientMsg): boolean;
  onMessage(fn: (m: ServerMsg) => void): void;
  onState(fn: (s: ConnState) => void): void;
  readonly state: ConnState;
  /** ms until the next reconnect attempt, or null */
  retryIn(): number | null;
  /** try again now (the panel's Retry, or a new access code) */
  retry(): void;
  /** drop the connection and start again with a fresh hello (the credential changed) */
  restart(): void;
  close(): void;
}

/** the WebSocket and transcription URLs for a server base ('/assistant'), relative to the page; http(s) becomes ws(s).
 * Throws for a server on another origin: it would be handed the person's Home Assistant login. */
export function endpoints(server: string, base: string): { ws: string; transcribe: string } {
  const root = new URL(`${server.replace(/\/+$/, '')}/`, base);
  if (root.origin !== new URL(base).origin)
    throw new Error(
      `the assistant's server must be on this page's origin (a path such as /assistant), not ${root.origin}: ` +
        'another origin would be sent the Home Assistant login',
    );
  const ws = new URL('ws', root);
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : ws.protocol === 'http:' ? 'ws:' : ws.protocol;
  return { ws: ws.href, transcribe: new URL('transcribe', root).href };
}

/** 'unauthorised' with nothing sent (no credential found): worth asking again when a login may have turned up */
export const awaitsLogin = (state: ConnState, used: string | null): boolean =>
  state === 'unauthorised' && used === null;

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
  /** the hello to send on each connect (the view context and the credential change); null: no credential, so don't
   * connect ('unauthorised') */
  hello(): Promise<HelloMsg | null>;
  /** a WebSocket constructor (tests) */
  WebSocket?: typeof WebSocket;
}): Transport {
  const WS = opts.WebSocket ?? WebSocket;
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

  /** a connect() is finding its credential */
  let starting = false;
  /** bumped by restart(): a connect() from before it gives up */
  let gen = 0;

  async function connect(): Promise<void> {
    clearTimeout(timer);
    retryAt = null;
    if (closed || starting) return;
    starting = true;
    const g = gen;
    let hello: HelloMsg | null;
    try {
      hello = await opts.hello();
    } catch {
      hello = null;
    }
    if (g !== gen) return; // restarted meanwhile (with another credential)
    starting = false;
    if (closed) return;
    if (!hello) return set('unauthorised');
    let sock: WebSocket;
    try {
      sock = new WS(opts.url);
    } catch {
      set('offline');
      return schedule();
    }
    ws = sock;
    const giveUp = setTimeout(() => sock.close(), CONNECT_TIMEOUT);
    sock.onopen = () => {
      clearTimeout(giveUp);
      sock.send(JSON.stringify(hello));
    };
    sock.onmessage = (e) => {
      const m = parseServerMsg(e.data);
      if (!m) return;
      // logged in: only now may anything else be sent (and only a login resets the backoff, so a server that keeps
      // closing with 4503 is asked less and less often)
      if (m.type === 'welcome' && ws === sock) {
        attempt = 0;
        set('connected');
      }
      for (const f of msgFns) f(m);
    };
    sock.onclose = (e) => {
      clearTimeout(giveUp);
      if (ws !== sock) return;
      ws = null;
      // refused: trying again with the same credential would only count as more failed logins
      if (e.code === CLOSE_UNAUTHORISED) return set('unauthorised');
      // a lost connection and every failed try are "offline": the retries don't flicker "connecting"
      set('offline');
      schedule();
    };
    sock.onerror = () => {}; // onclose follows
  }

  const online = () => {
    if (state === 'offline' && !ws) void connect();
  };
  addEventListener('online', online);
  void connect();

  return {
    send(m) {
      if (!ws || ws.readyState !== WS.OPEN || state !== 'connected') return false;
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
      if ((state !== 'offline' && state !== 'unauthorised') || ws || starting) return; // (a try already under way)
      attempt = 0;
      if (state === 'unauthorised') set('connecting');
      void connect();
    },
    restart() {
      if (closed) return;
      gen++;
      starting = false;
      clearTimeout(timer);
      const s = ws;
      ws = null;
      s?.close();
      attempt = 0;
      set('connecting');
      void connect();
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
