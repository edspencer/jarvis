// The session hub: every connected surface, one rolling conversation (design §9). Transport-agnostic: the server
// wraps each WebSocket in a Conn and feeds the hub raw messages; tests use fake conns.
//   - clients: `hello` first (id, credential, capabilities). The credential is checked (authenticate, core/auth.ts)
//     before anything else: a connection that sends anything but a good hello first gets an `error` and is closed
//     (4401). The surface is the credential's, from the server's configuration. `welcome` brings the recent transcript
//     and a /transcribe ticket (renewed every half ticket life). Every message is shape-checked here by hand and a bad
//     one gets an `error`, never a crash;
//   - before the login: exactly one message (the hello, at most maxHelloBytes) within helloTimeoutMs; a second one
//     while the hello is being checked, or a big one, cuts the connection off. Unauthenticated connections are capped
//     per address and in all (admits / onOpen). A connection the hub closes is gone at once: its later messages are
//     ignored, it gets one audit line, and it is cut off (terminate) if it hasn't closed after closeGraceMs;
//   - after it: messages in order, at most MAX_BACKLOG waiting per connection; logins are checked again (recheck):
//     HA logins every recheckMs with the latest credential (`auth` messages bring fresh HA tokens), everyone when the
//     clients file is reloaded (revalidate). Refused: closed 4401; a changed surface: closed 1012 (log in again);
//   - owners: a client is its user and its client id together (`<user key>/<client id>`), so a client id says nothing
//     without the login: confirmations, view commands and their answers belong to the owner;
//   - rate limits: `say`, `interrupt` and `reset` per user (one token bucket, limits.ts);
//   - turns: a FIFO queue, one at a time; the stream (turn.start, text.delta, tool, turn.end) goes to every client, so
//     a second screen follows live; the transcript is bounded and in memory;
//   - confirmations: the gate parks confirm-tier actions; the hub shows them to the client the turn came from only, and
//     routes that person's answer back: a click (confirm.reply) or, on a voice-only surface, their next utterance if
//     the gate's fixed yes/no list matches it whole. Only people's `say` messages ever reach gate.spoken(): the agent's
//     own text never does, so the model cannot approve its own request;
//   - view commands: a tool asks the turn's client's viewer to fly/highlight/toggle and waits for the result;
//   - a watchdog: a turn running longer than turnTimeoutMs is ended with an error and the agent reset, so the queue
//     and `reset` can't wait forever on an agent that never finishes.
import { randomUUID } from 'node:crypto';
import {
  CLOSE_UNAUTHORISED,
  createTicketStore,
  NOT_AUTHORISED,
  TICKET_TTL_MS,
  type AuthResult,
  type AuthUser,
  type Recheck,
  type TicketInfo,
} from './auth.ts';
import type { RateLimiter } from './limits.ts';
import type {
  AssistantState,
  ClientMsg,
  HelloAuth,
  HelloMsg,
  ServerMsg,
  Surface,
  ToolStatus,
  TranscriptEntry,
  ViewContext,
  ViewOp,
} from './protocol.ts';
import type { Agent, AgentEvent, PendingAction, ToolEnv, ToolRunner, ToolSpec, TurnInfo } from './types.ts';
import type { Audit } from './audit.ts';
import { ToolInputError } from './tools.ts';

/** one connection (a WebSocket, or a fake in tests) */
export interface Conn {
  send(msg: ServerMsg): void;
  /** close it, with a WebSocket close code (4401: not authorised) */
  close(code?: number, reason?: string): void;
  /** cut it off without the closing handshake */
  terminate?(): void;
  /** the client's address, for the failed-login limit and the unauthenticated-connection caps */
  readonly remote?: string;
}

/** the part of the gate the hub uses (its `clientId` is the hub's owner key: user and client id) */
export interface HubGate {
  reply(id: string, clientId: string, approved: boolean): { ok: true } | { ok: false; reason: string };
  spoken(clientId: string, text: string): boolean;
  cancel(clientId?: string): void;
  pending(clientId?: string): PendingAction[];
}

export interface HubOptions {
  agent: Agent;
  tools: ToolSpec[];
  gate: HubGate;
  /** what the welcome tells the panel */
  info: { agent: string; ha: 'mock' | 'live'; transcribe: boolean };
  /** the prompt the agent gets for a turn (the time, surface and view go in here; knowledge.formatTurn) */
  formatTurn?: (turn: TurnInfo) => string;
  /** who is this hello? (core/auth.ts) Refused: the conn gets an error and is closed with the result's code. */
  authenticate: (hello: HelloMsg, conn: Conn) => Promise<AuthResult> | AuthResult;
  /** check a logged-in user again (core/auth.ts recheck); none: never */
  recheck?: (user: AuthUser, auth: HelloAuth) => Promise<Recheck>;
  /** how often an HA login is checked again (default 10 min), and how soon after a check that couldn't tell (HA
   * down: the connection stays) it is tried again (default 1 min) */
  recheckMs?: number;
  recheckRetryMs?: number;
  /** a connection that hasn't said hello in this long is closed 4401 (default 10 s) */
  helloTimeoutMs?: number;
  /** the largest message before the login (default 8 KB) */
  maxHelloBytes?: number;
  /** connections waiting to log in, per address and in all (default 8 and 64) */
  preAuth?: { perAddress: number; total: number };
  /** a connection the hub closed is cut off if it is still there after this long (default 1 s) */
  closeGraceMs?: number;
  /** `say`, `interrupt` and `reset` messages per user (none: unlimited) */
  sayLimit?: RateLimiter;
  /** how long a /transcribe ticket lives (default 10 min); a fresh one is sent every half of it */
  ticketTtlMs?: number;
  audit?: Audit;
  /** transcript entries kept (default 200) */
  transcriptLimit?: number;
  /** entries sent with welcome (default 100) */
  welcomeLimit?: number;
  /** how long a view command waits for the viewer (default 5 s) */
  viewTimeoutMs?: number;
  /** a turn running longer is ended with an error and the agent reset (default 180 s) */
  turnTimeoutMs?: number;
  /** the transcript after each turn, reset or answer, to keep it somewhere.
   * TODO(open question 6: transcripts and privacy): nothing persists it by default until retention is decided. */
  persist?: (transcript: TranscriptEntry[]) => void;
  /** a transcript to start from (a persisted one) */
  transcript?: TranscriptEntry[];
  now?: () => number;
  newId?: () => string;
  log?: (msg: string) => void;
}

export interface Hub {
  /** may one more connection from this address wait to log in? (the server asks before the WebSocket upgrade) */
  admits(remote: string): boolean;
  /** a connection opened: false if it is over the caps (cut it off); else its hello deadline starts */
  onOpen(conn: Conn): boolean;
  /** a raw message from a conn: a JSON string or an already-parsed value */
  onMessage(conn: Conn, data: unknown): Promise<void>;
  onClose(conn: Conn): void;
  /** has it logged in? */
  authenticated(conn: Conn): boolean;
  /** check every logged-in user against `check` (the reloaded clients file): refused → closed 4401, a changed
   * surface → closed 1012; returns how many were closed */
  revalidate(check: (user: AuthUser, auth: HelloAuth) => Exclude<Recheck, 'unknown'>): number;
  /** gate hooks (createGate's onPending / onResolved) */
  onPending(p: PendingAction): void;
  onResolved(id: string, outcome: 'approved' | 'denied' | 'expired' | 'failed', detail?: string): void;
  /** the current transcript (a copy) */
  transcript(): TranscriptEntry[];
  /** resolves when no turn runs or waits (tests, shutdown) */
  idle(): Promise<void>;
  clientCount(): number;
  /** a /transcribe ticket's user, or null (unknown, expired, or its connection closed) */
  ticket(ticket: unknown): TicketInfo | null;
  close(): Promise<void>;
}

/** a user's client: the key the gate, the views and the confirmations know it by */
export const ownerKey = (user: AuthUser, clientId: string) => `${user.key}/${clientId}`;

interface Client {
  /** ownerKey(user, the hello's clientId) */
  owner: string;
  user: AuthUser;
  /** the login's credential, the latest copy (kept in memory for this connection only, to check the login again) */
  auth: HelloAuth;
  /** when the login was last found good, and last checked at all */
  checkedAt: number;
  triedAt: number;
  checking?: boolean;
  surface: Surface;
  viewer: boolean;
  tts: boolean;
  view?: ViewContext;
}

interface Turn {
  info: TurnInfo;
  /** the user it came from (AuthUser.key) */
  userKey: string;
  source: 'typed' | 'voice';
  interrupted?: boolean;
  /** it has ended (a late tool call from it, e.g. after the watchdog, is refused) */
  over?: boolean;
}

// ------------------------------------------------------------------------------------------------ validation

const MAX_TEXT = 4000;
/** messages waiting per connection after the login (a turn can keep `reset` waiting; a flood is cut off) */
const MAX_BACKLOG = 50;
const SLOW_DOWN = 'slow down: too many requests; try again in a moment';
/** a message's size in bytes (an already-parsed value, from tests: 0) */
const sizeOf = (d: unknown): number =>
  typeof d === 'string' ? Buffer.byteLength(d) : d instanceof Uint8Array || d instanceof ArrayBuffer ? d.byteLength : 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;

function viewCtx(v: unknown): ViewContext | undefined | string {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) return 'view must be an object';
  const out: ViewContext = {};
  for (const k of ['room', 'selected', 'storey'] as const) {
    const x = v[k];
    if (x === undefined || x === null) continue;
    if (typeof x !== 'string' || x.length > 200) return `view.${k} must be a short string`;
    out[k] = x;
  }
  return out;
}

function helloAuth(a: unknown): HelloAuth | null {
  if (!isObj(a)) return null;
  if (a.type === 'secret' && typeof a.secret === 'string' && a.secret) return { type: 'secret', secret: a.secret };
  if (a.type === 'ha' && typeof a.token === 'string' && a.token) return { type: 'ha', token: a.token };
  return null;
}

/** Check a client message's shape; returns the message or what's wrong with it. */
export function parseClientMsg(data: unknown): ClientMsg | string {
  let m = data;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      return 'not JSON';
    }
  }
  if (!isObj(m) || typeof m.type !== 'string') return 'a message is an object with a type';
  switch (m.type) {
    case 'hello': {
      if (!isId(m.clientId)) return 'hello: clientId must be a string of 1-128 characters';
      // (a `surface` is ignored: it comes from the credential)
      const auth = helloAuth(m.auth);
      if (!auth) return "hello: auth is required: { type: 'secret', secret } or { type: 'ha', token }";
      const caps = m.capabilities ?? [];
      if (!Array.isArray(caps) || caps.some((c) => c !== 'viewer' && c !== 'tts'))
        return "hello: capabilities is a list of 'viewer' / 'tts'";
      const view = viewCtx(m.view);
      if (typeof view === 'string') return `hello: ${view}`;
      return { type: 'hello', clientId: m.clientId, auth, capabilities: caps, view };
    }
    case 'say': {
      if (typeof m.text !== 'string' || !m.text.trim()) return 'say: text must be a non-empty string';
      if (m.text.length > MAX_TEXT) return `say: text is limited to ${MAX_TEXT} characters`;
      const source = m.source ?? 'typed';
      if (source !== 'typed' && source !== 'voice') return "say: source must be 'typed' or 'voice'";
      const view = viewCtx(m.view);
      if (typeof view === 'string') return `say: ${view}`;
      return { type: 'say', text: m.text.trim(), source, view };
    }
    case 'interrupt':
      return { type: 'interrupt' };
    case 'reset':
      return { type: 'reset' };
    case 'auth': {
      const auth = helloAuth(m.auth);
      if (!auth) return "auth: { type: 'secret', secret } or { type: 'ha', token }";
      return { type: 'auth', auth };
    }
    case 'confirm.reply':
      if (!isId(m.id) || typeof m.approved !== 'boolean') return 'confirm.reply: { id, approved: boolean }';
      return { type: 'confirm.reply', id: m.id, approved: m.approved };
    case 'view.result':
      if (!isId(m.id) || typeof m.ok !== 'boolean') return 'view.result: { id, ok: boolean, detail? }';
      if (m.detail !== undefined && typeof m.detail !== 'string') return 'view.result: detail must be a string';
      return { type: 'view.result', id: m.id, ok: m.ok, detail: (m.detail as string | undefined)?.slice(0, 500) };
    default:
      return `unknown message type ${String(m.type).slice(0, 40)}`;
  }
}

// ------------------------------------------------------------------------------------------------ the hub

export function createHub(opts: HubOptions): Hub {
  const { agent, gate } = opts;
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? randomUUID;
  const log = opts.log ?? (() => {});
  const limit = opts.transcriptLimit ?? 200;
  const welcomeLimit = opts.welcomeLimit ?? 100;
  const viewTimeout = opts.viewTimeoutMs ?? 5000;
  const turnTimeout = opts.turnTimeoutMs ?? 180_000;
  const toolsByName = new Map(opts.tools.map((t) => [t.name, t]));
  const ticketTtl = opts.ticketTtlMs ?? TICKET_TTL_MS;
  const tickets = createTicketStore({ ttlMs: ticketTtl, now });
  /** each conn's ticket renewal */
  const renewals = new Map<Conn, ReturnType<typeof setInterval>>();

  const helloTimeout = opts.helloTimeoutMs ?? 10_000;
  const maxHello = opts.maxHelloBytes ?? 8 * 1024;
  const preAuth = opts.preAuth ?? { perAddress: 8, total: 64 };
  const grace = opts.closeGraceMs ?? 1000;
  const recheckMs = opts.recheckMs ?? 10 * 60_000;
  const recheckRetry = opts.recheckRetryMs ?? 60_000;

  const clients = new Map<Conn, Client>();
  const chains = new Map<Conn, Promise<void>>();
  /** messages waiting per logged-in conn */
  const backlog = new Map<Conn, number>();
  /** conns that have closed or that the hub closed: their messages are ignored (one closing during an async
   * authenticate must not be registered afterwards) */
  const gone = new WeakSet<Conn>();
  /** conns that have sent their one message before the login */
  const spoke = new WeakSet<Conn>();
  /** conns waiting to log in (from onOpen): their address and hello deadline */
  const waiting = new Map<Conn, { remote: string; timer: ReturnType<typeof setTimeout> }>();
  const waitingAt = new Map<string, number>();
  /** conns the hub closed, cut off if still there after the grace */
  const reaping = new Map<Conn, ReturnType<typeof setTimeout>>();
  let transcript: TranscriptEntry[] = [...(opts.transcript ?? [])].slice(-limit);
  const queue: Turn[] = [];
  let current: Turn | null = null;
  let running: Promise<void> | null = null;
  let state: AssistantState = 'idle';
  let closed = false;
  /** the in-flight ha_act call of the current turn, so the pending chip updates the same row */
  let actCall: string | null = null;
  /** pending action id → the ha_act chip's call id */
  const callOf = new Map<string, string>();
  const views = new Map<string, { clientId: string; resolve: (r: { ok: boolean; detail?: string }) => void }>();

  // -------------------------------------------------------------------------------- sending

  const safeSend = (c: Conn, m: ServerMsg) => {
    try {
      c.send(m);
    } catch (e) {
      log(`send failed: ${(e as Error).message}`);
    }
  };
  const broadcast = (m: ServerMsg) => {
    for (const c of clients.keys()) safeSend(c, m);
  };
  const connsOf = (owner: string) => [...clients].filter(([, cl]) => cl.owner === owner).map(([c]) => c);
  const toClient = (owner: string, m: ServerMsg) => connsOf(owner).forEach((c) => safeSend(c, m));

  const setState = (s: AssistantState, detail?: string) => {
    state = s;
    broadcast({ type: 'status', state: s, ...(detail ? { detail } : {}) });
  };

  const record = (e: TranscriptEntry) => {
    transcript.push(e);
    if (transcript.length > limit) transcript = transcript.slice(-limit);
  };
  /** a tool chip: one transcript row per call, updated in place */
  const chip = (
    turnId: string,
    callId: string,
    name: string,
    summary: string,
    status: ToolStatus,
    subject?: string,
  ) => {
    const row = transcript.find((e) => e.kind === 'tool' && e.callId === callId);
    // an update without a subject keeps the call's earlier one, so the chip (live or replayed) stays clickable
    const subj = subject ?? (row?.kind === 'tool' ? row.subject : undefined);
    if (row && row.kind === 'tool') Object.assign(row, { summary, status }, subj ? { subject: subj } : {});
    else record({ kind: 'tool', turnId, callId, name, summary, status, ...(subj ? { subject: subj } : {}), at: now() });
    broadcast({ type: 'tool', turnId, callId, name, summary, status, ...(subj ? { subject: subj } : {}) });
  };
  const persist = () => {
    try {
      opts.persist?.(transcript.slice());
    } catch (e) {
      log(`persist failed: ${(e as Error).message}`);
    }
  };

  const welcome = (cl: Client, ticket: string): ServerMsg => ({
    type: 'welcome',
    transcript: transcript.slice(-welcomeLimit),
    status: state,
    agent: opts.info.agent,
    transcribe: opts.info.transcribe,
    ha: opts.info.ha,
    user: { name: cl.user.name },
    ticket,
  });
  const issue = (conn: Conn, cl: Client) => tickets.issue(conn, { user: cl.user, owner: cl.owner });

  // -------------------------------------------------------------------------------- view commands

  function viewFor(turn: TurnInfo) {
    return (op: ViewOp, args: Record<string, unknown>): Promise<{ ok: boolean; detail?: string }> => {
      const conn = [...clients].reverse().find(([, cl]) => cl.owner === turn.clientId && cl.viewer)?.[0];
      if (!conn) return Promise.resolve({ ok: false, detail: 'no viewer attached' });
      const id = newId();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          views.delete(id);
          resolve({ ok: false, detail: 'no answer from the viewer' });
        }, viewTimeout);
        views.set(id, {
          clientId: turn.clientId,
          resolve: (r) => {
            clearTimeout(timer);
            views.delete(id);
            resolve(r);
          },
        });
        safeSend(conn, { type: 'view.command', id, op, args: args as never });
      });
    };
  }

  /** the turn's client went away: its view commands won't be answered */
  const dropViews = (clientId: string) => {
    for (const v of [...views.values()])
      if (v.clientId === clientId) v.resolve({ ok: false, detail: 'no viewer attached' });
  };

  // -------------------------------------------------------------------------------- tools

  function runnerFor(turn: Turn): ToolRunner {
    const { info } = turn;
    const view = viewFor(info);
    return {
      async call(name, args) {
        const spec = toolsByName.get(name);
        const callId = newId();
        const base = {
          user: info.user,
          client: info.clientId,
          surface: info.surface,
          utterance: info.text,
          tool: name,
          args,
        };
        if (!spec) {
          opts.audit?.write({ kind: 'tool', ...base, decision: 'unknown tool' });
          return { text: `there is no tool called ${name}`, isError: true };
        }
        if (turn.over) {
          opts.audit?.write({ kind: 'tool', ...base, decision: 'turn over' });
          return { text: 'this turn has ended; nothing was done', isError: true };
        }
        if (name === 'ha_act') actCall = callId;
        let last: { summary: string; status: ToolStatus } | null = null;
        const env: ToolEnv = {
          turn: info,
          view,
          activity(summary, status, subject) {
            last = { summary, status };
            if (current !== turn) return; // a late call from an interrupted turn: keep quiet
            chip(info.turnId, callId, name, summary, status, subject);
          },
          ...(agent.escalate ? { escalate: () => agent.escalate!() } : {}),
        };
        try {
          const r = await spec.run(isObj(args) ? args : {}, env);
          const text = typeof r === 'string' ? r : JSON.stringify(r);
          const l = last as { summary: string; status: ToolStatus } | null;
          opts.audit?.write({ kind: 'tool', ...base, decision: l?.status ?? 'done', detail: l?.summary });
          return { text };
        } catch (e) {
          const msg = (e as Error).message || String(e);
          if (!(e instanceof ToolInputError)) log(`tool ${name} failed: ${(e as Error).stack ?? msg}`);
          const l = last as { summary: string; status: ToolStatus } | null;
          if (l && l.status === 'running') env.activity(l.summary, 'error');
          opts.audit?.write({ kind: 'tool', ...base, decision: 'error', detail: msg });
          return { text: `${name} failed: ${msg}`, isError: true };
        } finally {
          if (actCall === callId) actCall = null;
        }
      },
    };
  }

  // -------------------------------------------------------------------------------- turns

  async function runTurn(turn: Turn) {
    const { info } = turn;
    current = turn;
    record({
      kind: 'user',
      turnId: info.turnId,
      text: info.text,
      source: turn.source,
      surface: info.surface,
      at: now(),
    });
    broadcast({ type: 'turn.start', turnId: info.turnId, text: info.text, source: turn.source, surface: info.surface });
    setState('thinking');
    let reply: Extract<TranscriptEntry, { kind: 'assistant' }> | null = null;
    let ended: { error?: string; interrupted?: boolean } | null = null;
    const emit = (e: AgentEvent) => {
      if (current !== turn || ended) return;
      if (e.type === 'text') {
        if (!e.delta) return;
        // text after a tool chip is a new paragraph below it (as the panel shows it live), also in the transcript
        if (reply && transcript[transcript.length - 1] !== reply) reply = null;
        if (!reply) {
          reply = { kind: 'assistant', turnId: info.turnId, text: '', at: now() };
          record(reply);
        }
        reply.text += e.delta;
        broadcast({ type: 'text.delta', turnId: info.turnId, delta: e.delta });
      } else if (e.type === 'tool') {
        chip(info.turnId, e.callId, e.name, e.summary, e.status);
      } else if (e.type === 'done') {
        ended = { error: e.error, interrupted: e.interrupted };
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const prompt = opts.formatTurn ? opts.formatTurn(info) : info.text;
      const timedOut = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), turnTimeout)));
      const r = await Promise.race([agent.run(prompt, info, emit, runnerFor(turn)), timedOut]);
      if (r === 'timeout') {
        const secs = Math.round(turnTimeout / 1000);
        ended ??= { error: `no answer within ${secs} s, so the assistant was restarted` };
        log(`turn ${info.turnId} ran over ${secs} s: resetting the agent`);
        turn.over = true;
        gate.cancel(info.clientId);
        await agent.reset().catch((e) => log(`reset failed: ${(e as Error).message}`));
      }
    } catch (e) {
      ended ??= { error: (e as Error).message || 'the agent failed' };
      log(`agent failed: ${(e as Error).stack ?? e}`);
    } finally {
      clearTimeout(timer);
    }
    turn.over = true;
    const end = (ended ?? {}) as { error?: string; interrupted?: boolean };
    const interrupted = end.interrupted || turn.interrupted;
    current = null;
    broadcast({
      type: 'turn.end',
      turnId: info.turnId,
      ...(end.error && !interrupted ? { error: end.error } : {}),
      ...(interrupted ? { interrupted: true } : {}),
    });
    if (end.error && !interrupted) setState('error', end.error);
    persist();
  }

  function pump() {
    if (running || closed) return;
    running = (async () => {
      while (queue.length && !closed) await runTurn(queue.shift()!);
      running = null;
      if (state !== 'error' && !closed) setState('idle');
    })();
  }

  // -------------------------------------------------------------------------------- messages

  const fail = (conn: Conn, message: string) => safeSend(conn, { type: 'error', message });
  const unref = (t: ReturnType<typeof setTimeout>) => ((t as { unref?: () => void }).unref?.(), t);

  const unwait = (conn: Conn) => {
    const w = waiting.get(conn);
    if (!w) return;
    clearTimeout(w.timer);
    waiting.delete(conn);
    const n = (waitingAt.get(w.remote) ?? 1) - 1;
    if (n > 0) waitingAt.set(w.remote, n);
    else waitingAt.delete(w.remote);
  };
  const admits = (remote: string) => waiting.size < preAuth.total && (waitingAt.get(remote) ?? 0) < preAuth.perAddress;

  /** the hub is done with a conn (closed, or about to be): forget it and everything that hangs off it */
  function forget(conn: Conn) {
    gone.add(conn);
    unwait(conn);
    const cl = clients.get(conn);
    clients.delete(conn);
    chains.delete(conn);
    backlog.delete(conn);
    tickets.revoke(conn);
    clearInterval(renewals.get(conn));
    renewals.delete(conn);
    if (cl && !connsOf(cl.owner).length) {
      gate.cancel(cl.owner);
      dropViews(cl.owner);
    }
  }
  const cutOff = (conn: Conn) => {
    try {
      conn.terminate?.();
    } catch {}
  };
  /** Close a conn from the hub's side: gone at once (later messages are ignored), one audit line, then the error and
   * the close code, and a cut-off if it hasn't gone after the grace. `now`: no error, no handshake: cut off at once. */
  function drop(
    conn: Conn,
    code: number,
    message: string,
    detail: string,
    o: { now?: boolean; decision?: string } = {},
  ) {
    if (gone.has(conn)) return;
    const cl = clients.get(conn);
    forget(conn);
    opts.audit?.write({
      kind: 'auth',
      remote: conn.remote,
      ...(cl ? { user: cl.user.name, client: cl.owner } : {}),
      decision: o.decision ?? 'refused',
      detail,
    });
    if (o.now) return cutOff(conn);
    fail(conn, message);
    try {
      conn.close(code, message);
    } catch {}
    reaping.set(
      conn,
      unref(
        setTimeout(() => {
          reaping.delete(conn);
          cutOff(conn);
        }, grace),
      ),
    );
  }

  // -------------------------------------------------------------------------------- checking a login again

  /** an HA login is due a check: the last good one is recheckMs old, and the last try recheckRetry */
  const due = (cl: Client) => now() - cl.checkedAt >= recheckMs && now() - cl.triedAt >= recheckRetry;

  function settle(conn: Conn, cl: Client, r: Recheck) {
    if (r === 'ok') cl.checkedAt = now();
    else if (r === 'refused')
      drop(conn, CLOSE_UNAUTHORISED, NOT_AUTHORISED, 'the login is no longer good', { decision: 'revoked' });
    else if (r === 'changed')
      drop(conn, 1012, 'your login changed; connecting again', 'the login’s surface changed', { decision: 'changed' });
    // 'unknown' (Home Assistant down): kept, and tried again after recheckRetry
  }

  async function recheck(conn: Conn, cl: Client) {
    if (!opts.recheck || cl.checking) return;
    cl.checking = true;
    cl.triedAt = now();
    let r: Recheck;
    try {
      r = await opts.recheck(cl.user, cl.auth);
    } catch (e) {
      log(`recheck failed: ${(e as Error).message}`);
      r = 'unknown';
    } finally {
      cl.checking = false;
    }
    if (clients.get(conn) === cl) settle(conn, cl, r);
  }

  const sweep = opts.recheck
    ? unref(
        setInterval(
          () => {
            for (const [c, cl] of [...clients]) if (cl.user.via === 'ha' && due(cl)) void recheck(c, cl);
          },
          Math.min(recheckRetry, recheckMs),
        ),
      )
    : null;

  // -------------------------------------------------------------------------------- the first message

  async function first(conn: Conn, data: unknown) {
    const msg = parseClientMsg(data);
    // nothing but a good hello before a successful login: anything else is refused and the socket closed
    if (typeof msg === 'string' || msg.type !== 'hello')
      return drop(
        conn,
        CLOSE_UNAUTHORISED,
        typeof msg === 'string' ? msg : 'say hello first, with a credential',
        'no hello',
      );
    return hello(conn, msg);
  }

  async function handle(conn: Conn, data: unknown) {
    const cl = clients.get(conn);
    if (!cl || gone.has(conn)) return; // closed meanwhile
    const msg = parseClientMsg(data);
    if (typeof msg === 'string') return fail(conn, msg);
    if (msg.type === 'hello') return fail(conn, 'hello: this connection has already said hello');
    switch (msg.type) {
      case 'say': {
        if (opts.sayLimit && !opts.sayLimit.take(cl.user.key)) return fail(conn, SLOW_DOWN);
        if (msg.view) cl.view = msg.view;
        // a voice-only surface answers a pending confirmation by voice: the server matches the whole utterance against
        // a fixed list (the gate's); the model never sees it and nothing it says can do the same
        if (cl.surface === 'speaker' && gate.pending(cl.owner).length && gate.spoken(cl.owner, msg.text)) {
          record({
            kind: 'user',
            turnId: `answer-${newId()}`,
            text: msg.text,
            source: msg.source,
            surface: cl.surface,
            at: now(),
          });
          persist();
          return;
        }
        if (queue.length >= 20) return fail(conn, 'too many requests waiting; try again in a moment');
        queue.push({
          source: msg.source,
          userKey: cl.user.key,
          info: {
            turnId: newId(),
            clientId: cl.owner,
            user: cl.user.name,
            surface: cl.surface,
            text: msg.text,
            view: msg.view ?? cl.view,
            viewer: cl.viewer,
          },
        });
        pump();
        return;
      }
      case 'interrupt': {
        if (opts.sayLimit && !opts.sayLimit.take(cl.user.key)) return fail(conn, SLOW_DOWN);
        // this client's waiting turns and confirmations go, and the running turn stops (whoever's it is: barge-in).
        // The running turn's confirmations go too only if it is this user's own (another tab of theirs): someone
        // else's interrupt leaves their confirmation to them (unanswered, it expires: safe either way)
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].info.clientId === cl.owner) queue.splice(i, 1);
        gate.cancel(cl.owner);
        if (current && current.info.clientId !== cl.owner && current.userKey === cl.user.key)
          gate.cancel(current.info.clientId);
        if (current) {
          current.interrupted = true;
          await agent.interrupt().catch((e) => log(`interrupt failed: ${(e as Error).message}`));
        }
        return;
      }
      case 'reset': {
        if (opts.sayLimit && !opts.sayLimit.take(cl.user.key)) return fail(conn, SLOW_DOWN);
        queue.length = 0;
        gate.cancel();
        if (current) {
          current.interrupted = true;
          await agent.interrupt().catch(() => {});
        }
        await running;
        await agent.reset().catch((e) => log(`reset failed: ${(e as Error).message}`));
        record({ kind: 'divider', text: 'New conversation', at: now() });
        persist();
        state = 'idle';
        // everyone gets the transcript again, with the divider (the protocol has no separate message for it)
        for (const [c, x] of clients) safeSend(c, welcome(x, issue(c, x)));
        return;
      }
      case 'confirm.reply': {
        // only the owner (this user, this client id) may answer: gate.reply checks it
        const r = gate.reply(msg.id, cl.owner, msg.approved);
        if (!r.ok) fail(conn, `confirm.reply: ${r.reason}`);
        return;
      }
      case 'view.result': {
        const v = views.get(msg.id);
        if (v && v.clientId === cl.owner) v.resolve({ ok: msg.ok, detail: msg.detail });
        return; // unknown or someone else's: ignored
      }
      case 'auth': {
        // a fresh copy of the credential (an HA token is refreshed every 30 minutes): kept for the next check, and
        // checked now if one is due
        if (msg.auth.type !== cl.user.via) return fail(conn, `auth: this connection logged in with ${cl.user.via}`);
        cl.auth = msg.auth;
        if (cl.user.via === 'ha' && due(cl)) await recheck(conn, cl);
        return;
      }
    }
  }

  /** the first message: check the credential, then register the client and welcome it */
  async function hello(conn: Conn, msg: HelloMsg) {
    let r: AuthResult;
    try {
      r = await opts.authenticate(msg, conn);
    } catch (e) {
      log(`authenticate failed: ${(e as Error).message}`);
      r = { ok: false, reason: NOT_AUTHORISED, code: CLOSE_UNAUTHORISED };
    }
    if (gone.has(conn) || closed) return; // it closed (or was cut off) while we were deciding
    if (!r.ok) return drop(conn, r.code, r.reason, r.reason);
    unwait(conn);
    const cl: Client = {
      owner: ownerKey(r.user, msg.clientId),
      user: r.user,
      auth: msg.auth,
      checkedAt: now(),
      triedAt: now(),
      surface: r.user.surface,
      viewer: msg.capabilities.includes('viewer'),
      tts: msg.capabilities.includes('tts'),
      view: msg.view,
    };
    clients.set(conn, cl);
    opts.audit?.write({ kind: 'auth', user: r.user.name, client: cl.owner, surface: cl.surface, decision: 'ok' });
    safeSend(conn, welcome(cl, issue(conn, cl)));
    // a fresh ticket every half ticket life, so a long session can still talk (the old one works until it expires)
    const t = setInterval(() => safeSend(conn, { type: 'ticket', ticket: issue(conn, cl) }), ticketTtl / 2);
    unref(t);
    renewals.set(conn, t);
    // another connection of the same owner (a second socket of that tab, a quick reconnect while the old socket is
    // still open): show it the confirmations still waiting. A plain reload usually finds none: when an owner's last
    // connection closes, its confirmations are cancelled (fail-safe: nobody is left to answer them).
    for (const p of gate.pending(cl.owner)) safeSend(conn, confirmRequest(p));
  }

  const confirmRequest = (p: PendingAction): ServerMsg => ({
    type: 'confirm.request',
    id: p.id,
    summary: p.summary,
    detail: p.detail,
    risk: p.risk,
    expiresAt: p.expiresAt,
    ttlMs: Math.max(0, p.expiresAt - now()),
    ...(callOf.has(p.id) ? { callId: callOf.get(p.id) } : {}),
  });

  return {
    admits,

    onOpen(conn) {
      const remote = conn.remote ?? 'unknown';
      if (closed || !admits(remote)) {
        log(`refused a connection from ${remote}: too many waiting to log in`);
        return false;
      }
      const timer = unref(
        setTimeout(() => drop(conn, CLOSE_UNAUTHORISED, NOT_AUTHORISED, 'no hello in time'), helloTimeout),
      );
      waiting.set(conn, { remote, timer });
      waitingAt.set(remote, (waitingAt.get(remote) ?? 0) + 1);
      return true;
    },

    onMessage(conn, data) {
      if (gone.has(conn) || closed) return Promise.resolve();
      if (!clients.has(conn)) {
        // before the login: one message, the hello, and a small one; anything more is a flood, cut off at once
        if (spoke.has(conn)) {
          drop(conn, 1008, '', 'a message before the login finished', { now: true });
          return Promise.resolve();
        }
        spoke.add(conn);
        if (sizeOf(data) > maxHello) {
          drop(conn, 1009, '', `a ${sizeOf(data)}-byte message before the login`, { now: true });
          return Promise.resolve();
        }
        return first(conn, data).catch((e) => {
          log(`hello failed: ${(e as Error).stack ?? e}`);
          drop(conn, CLOSE_UNAUTHORISED, 'internal error', 'internal error');
        });
      }
      // after it: per connection, in order, a bounded number waiting
      const n = backlog.get(conn) ?? 0;
      if (n >= MAX_BACKLOG) {
        drop(conn, 1008, 'too many messages at once', 'message flood', { decision: 'closed' });
        return Promise.resolve();
      }
      backlog.set(conn, n + 1);
      const next = (chains.get(conn) ?? Promise.resolve())
        .then(() =>
          handle(conn, data).catch((e) => {
            log(`message failed: ${(e as Error).stack ?? e}`);
            fail(conn, 'internal error');
          }),
        )
        .finally(() => {
          const m = (backlog.get(conn) ?? 1) - 1;
          if (m > 0 && !gone.has(conn)) backlog.set(conn, m);
          else backlog.delete(conn);
        });
      chains.set(conn, next);
      return next;
    },

    onClose(conn) {
      clearTimeout(reaping.get(conn));
      reaping.delete(conn);
      forget(conn);
    },

    authenticated: (conn) => clients.has(conn),

    revalidate(check) {
      let n = 0;
      for (const [conn, cl] of [...clients]) {
        const r = check(cl.user, cl.auth);
        if (r === 'ok') continue;
        settle(conn, cl, r);
        n++;
      }
      return n;
    },

    onPending(p) {
      // the dialog and the ha_act chip share the call id, so the panel can tie them together
      const turnId = current?.info.turnId;
      const callId = turnId ? (actCall ?? `confirm-${p.id}`) : null;
      if (callId) callOf.set(p.id, callId);
      toClient(p.clientId, confirmRequest(p));
      if (turnId && callId) chip(turnId, callId, 'ha_act', `Waiting for confirmation: ${p.summary}`, 'pending');
    },

    onResolved(id, outcome, detail) {
      callOf.delete(id);
      broadcast({ type: 'confirm.resolved', id, outcome, ...(detail ? { detail } : {}) });
      opts.audit?.write({ kind: 'confirm', decision: outcome, detail, pendingId: id });
    },

    transcript: () => transcript.slice(),

    async idle() {
      while (running) await running;
    },

    clientCount: () => clients.size,

    ticket: (t) => tickets.check(t),

    async close() {
      closed = true;
      if (sweep) clearInterval(sweep);
      for (const c of [...waiting.keys()]) unwait(c);
      for (const t of reaping.values()) clearTimeout(t);
      reaping.clear();
      queue.length = 0;
      gate.cancel();
      if (current) await agent.interrupt().catch(() => {});
      for (const v of [...views.values()]) v.resolve({ ok: false, detail: 'the assistant is shutting down' });
      await running;
      for (const c of clients.keys()) {
        try {
          c.close();
        } catch {}
        tickets.revoke(c);
      }
      for (const t of renewals.values()) clearInterval(t);
      renewals.clear();
      clients.clear();
    },
  };
}
