// The session hub: every connected surface, one rolling conversation (design §9). Transport-agnostic: the server
// wraps each WebSocket in a Conn and feeds the hub raw messages; tests use fake conns.
//   - clients: `hello` first (id, surface, capabilities), answered by `welcome` with the recent transcript; every
//     message is shape-checked here by hand and a bad one gets an `error`, never a crash;
//   - turns: a FIFO queue, one at a time; the stream (turn.start, text.delta, tool, turn.end) goes to every client, so
//     a second screen follows live; the transcript is bounded and in memory;
//   - confirmations: the gate parks confirm-tier actions; the hub shows them to the client the turn came from only, and
//     routes that person's answer back: a click (confirm.reply) or, on a voice-only surface, their next utterance if
//     the gate's fixed yes/no list matches it whole. Only people's `say` messages ever reach gate.spoken(): the agent's
//     own text never does, so the model cannot approve its own request;
//   - view commands: a tool asks the turn's client's viewer to fly/highlight/toggle and waits for the result.
import { randomUUID } from 'node:crypto';
import type {
  AssistantState,
  ClientMsg,
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
  close(): void;
}

/** the part of the gate the hub uses */
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
  /** may this hello join? null: yes; a string: the reason it may not (the conn is closed). v1 accepts everyone. */
  authenticate?: (hello: HelloMsg, conn: Conn) => Promise<string | null> | string | null;
  audit?: Audit;
  /** transcript entries kept (default 200) */
  transcriptLimit?: number;
  /** entries sent with welcome (default 100) */
  welcomeLimit?: number;
  /** how long a view command waits for the viewer (default 5 s) */
  viewTimeoutMs?: number;
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
  /** a raw message from a conn: a JSON string or an already-parsed value */
  onMessage(conn: Conn, data: unknown): Promise<void>;
  onClose(conn: Conn): void;
  /** gate hooks (createGate's onPending / onResolved) */
  onPending(p: PendingAction): void;
  onResolved(id: string, outcome: 'approved' | 'denied' | 'expired' | 'failed', detail?: string): void;
  /** the current transcript (a copy) */
  transcript(): TranscriptEntry[];
  /** resolves when no turn runs or waits (tests, shutdown) */
  idle(): Promise<void>;
  clientCount(): number;
  close(): Promise<void>;
}

interface Client {
  clientId: string;
  surface: Surface;
  viewer: boolean;
  tts: boolean;
  view?: ViewContext;
}

interface Turn {
  info: TurnInfo;
  source: 'typed' | 'voice';
  interrupted?: boolean;
}

// ------------------------------------------------------------------------------------------------ validation

const MAX_TEXT = 4000;
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
      if (m.surface !== 'screen' && m.surface !== 'speaker') return "hello: surface must be 'screen' or 'speaker'";
      const caps = m.capabilities ?? [];
      if (!Array.isArray(caps) || caps.some((c) => c !== 'viewer' && c !== 'tts'))
        return "hello: capabilities is a list of 'viewer' / 'tts'";
      const view = viewCtx(m.view);
      if (typeof view === 'string') return `hello: ${view}`;
      return { type: 'hello', clientId: m.clientId, surface: m.surface, capabilities: caps, view };
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
  const toolsByName = new Map(opts.tools.map((t) => [t.name, t]));

  const clients = new Map<Conn, Client>();
  const chains = new Map<Conn, Promise<void>>();
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
  const connsOf = (clientId: string) => [...clients].filter(([, cl]) => cl.clientId === clientId).map(([c]) => c);
  const toClient = (clientId: string, m: ServerMsg) => connsOf(clientId).forEach((c) => safeSend(c, m));

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

  const welcome = (): ServerMsg => ({
    type: 'welcome',
    transcript: transcript.slice(-welcomeLimit),
    status: state,
    agent: opts.info.agent,
    transcribe: opts.info.transcribe,
    ha: opts.info.ha,
  });

  // -------------------------------------------------------------------------------- view commands

  function viewFor(turn: TurnInfo) {
    return (op: ViewOp, args: Record<string, unknown>): Promise<{ ok: boolean; detail?: string }> => {
      const conn = [...clients].reverse().find(([, cl]) => cl.clientId === turn.clientId && cl.viewer)?.[0];
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
        const base = { client: info.clientId, surface: info.surface, utterance: info.text, tool: name, args };
        if (!spec) {
          opts.audit?.write({ kind: 'tool', ...base, decision: 'unknown tool' });
          return { text: `there is no tool called ${name}`, isError: true };
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
    try {
      const prompt = opts.formatTurn ? opts.formatTurn(info) : info.text;
      await agent.run(prompt, info, emit, runnerFor(turn));
    } catch (e) {
      ended ??= { error: (e as Error).message || 'the agent failed' };
      log(`agent failed: ${(e as Error).stack ?? e}`);
    }
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

  async function handle(conn: Conn, data: unknown) {
    const msg = parseClientMsg(data);
    if (typeof msg === 'string') return fail(conn, msg);
    const cl = clients.get(conn);
    if (msg.type === 'hello') {
      if (cl && cl.clientId !== msg.clientId) return fail(conn, 'hello: this connection already has a client id');
      const why = opts.authenticate ? await opts.authenticate(msg, conn) : null;
      if (why) {
        fail(conn, why);
        return conn.close();
      }
      clients.set(conn, {
        clientId: msg.clientId,
        surface: msg.surface,
        viewer: msg.capabilities.includes('viewer'),
        tts: msg.capabilities.includes('tts'),
        view: msg.view,
      });
      safeSend(conn, welcome());
      // a reload or reconnect: show it the confirmations still waiting for it
      for (const p of gate.pending(msg.clientId)) safeSend(conn, confirmRequest(p));
      return;
    }
    if (!cl) return fail(conn, 'say hello first');
    switch (msg.type) {
      case 'say': {
        if (msg.view) cl.view = msg.view;
        // a voice-only surface answers a pending confirmation by voice: the server matches the whole utterance against
        // a fixed list (the gate's); the model never sees it and nothing it says can do the same
        if (cl.surface === 'speaker' && gate.pending(cl.clientId).length && gate.spoken(cl.clientId, msg.text)) {
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
          info: {
            turnId: newId(),
            clientId: cl.clientId,
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
        // this client's waiting turns go, the running one stops (whoever's it is: barge-in), its confirmations close
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].info.clientId === cl.clientId) queue.splice(i, 1);
        gate.cancel(cl.clientId);
        if (current) {
          current.interrupted = true;
          await agent.interrupt().catch((e) => log(`interrupt failed: ${(e as Error).message}`));
        }
        return;
      }
      case 'reset': {
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
        for (const c of clients.keys()) safeSend(c, welcome());
        return;
      }
      case 'confirm.reply': {
        const r = gate.reply(msg.id, cl.clientId, msg.approved);
        if (!r.ok) fail(conn, `confirm.reply: ${r.reason}`);
        return;
      }
      case 'view.result': {
        const v = views.get(msg.id);
        if (v && v.clientId === cl.clientId) v.resolve({ ok: msg.ok, detail: msg.detail });
        return; // unknown or someone else's: ignored
      }
    }
  }

  const confirmRequest = (p: PendingAction): ServerMsg => ({
    type: 'confirm.request',
    id: p.id,
    summary: p.summary,
    detail: p.detail,
    risk: p.risk,
    expiresAt: p.expiresAt,
    ...(callOf.has(p.id) ? { callId: callOf.get(p.id) } : {}),
  });

  return {
    onMessage(conn, data) {
      // per connection, in order (an async hello finishes before the next message)
      const next = (chains.get(conn) ?? Promise.resolve()).then(() =>
        handle(conn, data).catch((e) => {
          log(`message failed: ${(e as Error).stack ?? e}`);
          fail(conn, 'internal error');
        }),
      );
      chains.set(conn, next);
      return next;
    },

    onClose(conn) {
      const cl = clients.get(conn);
      clients.delete(conn);
      chains.delete(conn);
      if (!cl) return;
      if (!connsOf(cl.clientId).length) {
        gate.cancel(cl.clientId);
        dropViews(cl.clientId);
      }
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

    async close() {
      closed = true;
      queue.length = 0;
      gate.cancel();
      if (current) await agent.interrupt().catch(() => {});
      for (const v of [...views.values()]) v.resolve({ ok: false, detail: 'the assistant is shutting down' });
      await running;
      for (const c of clients.keys()) {
        try {
          c.close();
        } catch {}
      }
      clients.clear();
    },
  };
}
