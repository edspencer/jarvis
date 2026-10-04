// The session hub with fake connections and a fake agent that calls the real tools, through the real gate, against the
// mock Home Assistant and the example policy: logins (the real authenticator with access codes), hello/welcome,
// tickets, malformed input, turn serialisation and broadcast, view commands, the say limit, and the confirmation flow,
// including that nothing the agent says can approve an action and that only the same user and client can.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { memoryAudit } from '../src/core/audit.ts';
import { createAuthenticator, sha256Hex, type AuthResult, type Recheck } from '../src/core/auth.ts';
import { createRateLimiter, type RateLimiter } from '../src/core/limits.ts';
import { createGate, type Gate } from '../src/core/gate.ts';
import { createMockHa, type MockHa } from '../src/core/ha-mock.ts';
import { createHub, parseClientMsg, type Conn, type Hub, type HubOptions } from '../src/core/hub.ts';
import { loadSite } from '../src/core/knowledge.ts';
import { parsePolicy } from '../src/core/policy.ts';
import type { ClientMsg, ServerMsg } from '../src/core/protocol.ts';
import { createTools } from '../src/core/tools.ts';
import type { Agent, AgentEvent, ToolRunner, TurnInfo } from '../src/core/types.ts';
import { EXAMPLE_POLICY } from './policy-fixture.ts';

const site = loadSite(resolve(import.meta.dirname, '../../examples/demo-site'));

// ------------------------------------------------------------------------------------------------ fakes

interface FakeConn extends Conn {
  sent: ServerMsg[];
  closed: boolean;
  /** cut off (terminate) */
  terminated: boolean;
  code?: number;
  of<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }>[];
}
function conn(remote = '10.0.0.7'): FakeConn {
  const c: FakeConn = {
    sent: [],
    closed: false,
    terminated: false,
    remote,
    send: (m) => void c.sent.push(structuredClone(m)),
    close: (code) => void ((c.closed = true), (c.code = code)),
    terminate: () => void (c.terminated = true),
    of: (type) => c.sent.filter((m) => m.type === type) as never,
  };
  return c;
}

/** the access codes of the clients file the rig's authenticator knows; kitchen is a speaker */
const CODES = { alice: 'alice:alice-secret', bob: 'bob:bob-secret', kitchen: 'kitchen:kitchen-secret' };
const secret = (who: keyof typeof CODES) => ({ type: 'secret' as const, secret: CODES[who] });
const authenticator = () => {
  const a = createAuthenticator({
    kinds: ['secret'],
    clients: {
      clients: [
        { name: 'alice', secretSha256: sha256Hex(CODES.alice), surface: 'screen' },
        { name: 'bob', secretSha256: sha256Hex(CODES.bob), surface: 'screen' },
        { name: 'kitchen', secretSha256: sha256Hex(CODES.kitchen), surface: 'speaker' },
      ],
      haUsers: [],
    },
    haSurface: 'screen',
  });
  return (h: { auth: unknown }, c: Conn): Promise<AuthResult> => a.verify(h.auth, c.remote ?? '?');
};

type Script = (turn: TurnInfo, emit: (e: AgentEvent) => void, tools: ToolRunner, agent: FakeAgent) => Promise<void>;
interface FakeAgent extends Agent {
  script: Script;
  prompts: string[];
  interrupted: boolean;
  resets: number;
  results: string[];
}
function fakeAgent(script: Script = async (_t, emit) => emit({ type: 'done' })): FakeAgent {
  const a: FakeAgent = {
    name: 'fake',
    script,
    prompts: [],
    interrupted: false,
    resets: 0,
    results: [],
    async run(prompt, turn, emit, tools) {
      a.prompts.push(prompt);
      a.interrupted = false;
      await a.script(turn, emit, tools, a);
    },
    async interrupt() {
      a.interrupted = true;
    },
    async reset() {
      a.resets++;
    },
    async close() {},
  };
  return a;
}

interface Rig {
  hub: Hub;
  gate: Gate;
  ha: MockHa;
  agent: FakeAgent;
  audit: ReturnType<typeof memoryAudit>;
}
function rig(
  script?: Script,
  opts: { viewTimeoutMs?: number; ttlMs?: number; turnTimeoutMs?: number; sayLimit?: RateLimiter } = {},
): Rig {
  const ha = createMockHa();
  const agent = fakeAgent(script);
  const audit = memoryAudit();
  let hub: Hub | null = null;
  const gate = createGate({
    policy: parsePolicy(EXAMPLE_POLICY),
    backend: ha,
    ttlMs: opts.ttlMs,
    onPending: (p) => hub?.onPending(p),
    onResolved: (id, o, d) => hub?.onResolved(id, o, d),
  });
  const tools = createTools({ gate, ha, site, dataDir: mkdtempSync(join(tmpdir(), 'jarvis-hub-')) });
  hub = createHub({
    agent,
    tools,
    gate,
    audit,
    info: { agent: agent.name, ha: 'mock', transcribe: false },
    formatTurn: (t) => `[turn] ${t.text}`,
    viewTimeoutMs: opts.viewTimeoutMs ?? 200,
    turnTimeoutMs: opts.turnTimeoutMs,
    authenticate: authenticator(),
    sayLimit: opts.sayLimit,
  });
  return { hub, gate, ha, agent, audit };
}

/** a hub of its own over the rig's agent and gate, with some options */
const hubOf = (r: Rig, o: Partial<HubOptions> = {}) =>
  createHub({
    agent: r.agent,
    tools: [],
    gate: r.gate,
    audit: r.audit,
    info: { agent: 'fake', ha: 'mock', transcribe: false },
    authenticate: authenticator(),
    ...o,
  });
const authLines = (r: Rig) => r.audit.records.filter((x) => x.kind === 'auth');
const SLOW = 'slow down: too many requests; try again in a moment';
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

const until = async (pred: () => unknown, ms = 1000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

const hello = (
  clientId: string,
  extra: Partial<Extract<ClientMsg, { type: 'hello' }>> & { surface?: string } = {},
) => ({
  type: 'hello',
  clientId,
  auth: secret('alice'),
  capabilities: ['viewer', 'tts'],
  ...extra,
});
/** the owner key of one of the rig's users' clients */
const owner = (who: keyof typeof CODES, clientId: string) => `secret:${who}/${clientId}`;
const say = (text: string) => ({ type: 'say', text, source: 'typed' });

async function join2(r: Rig, id = 'tab-1', extra = {}) {
  const c = conn();
  await r.hub.onMessage(c, JSON.stringify(hello(id, extra)));
  return c;
}

const THERMOSTAT = { entity_ids: ['climate.hall_thermostat'], service: 'set_temperature', data: { temperature: 72 } };
/** an agent that asks for the thermostat change and reports the outcome */
const actScript: Script = async (_t, emit, tools, a) => {
  const r = await tools.call('ha_act', THERMOSTAT);
  a.results.push(r.text);
  emit({ type: 'text', delta: r.text });
  emit(a.interrupted ? { type: 'done', interrupted: true } : { type: 'done' });
};

// ------------------------------------------------------------------------------------------------ tests

describe('parseClientMsg', () => {
  it('accepts the protocol and rejects everything else with a reason', () => {
    expect(parseClientMsg(JSON.stringify(hello('a', { surface: 'speaker' })))).toEqual({
      type: 'hello',
      clientId: 'a',
      auth: { type: 'secret', secret: CODES.alice }, // (a surface is ignored: it comes from the credential)
      capabilities: ['viewer', 'tts'],
      view: undefined,
    });
    expect(parseClientMsg({ type: 'say', text: ' hi ' })).toEqual({ type: 'say', text: 'hi', source: 'typed' });
    for (const bad of [
      'nope{',
      null,
      [],
      { type: 3 },
      { type: 'hello', clientId: '', auth: secret('alice') },
      { type: 'hello', clientId: 'a' },
      { type: 'hello', clientId: 'a', auth: 'alice:alice-secret' },
      { type: 'hello', clientId: 'a', auth: { type: 'secret', secret: '' } },
      { type: 'hello', clientId: 'a', auth: { type: 'ha' } },
      { type: 'hello', clientId: 'a', auth: { type: 'password', password: 'x' } },
      { type: 'hello', clientId: 'a', auth: secret('alice'), capabilities: ['root'] },
      { type: 'hello', clientId: 'a', auth: secret('alice'), view: { room: 5 } },
      { type: 'say', text: '' },
      { type: 'say', text: 'x'.repeat(5000) },
      { type: 'say', text: 'hi', source: 'telepathy' },
      { type: 'confirm.reply', id: 'x', approved: 'yes' },
      { type: 'view.result', id: 'x' },
      { type: 'auth', auth: 'tok' },
      { type: 'launch' },
    ])
      expect(typeof parseClientMsg(bad)).toBe('string');
  });
});

describe('hub: clients', () => {
  it('nothing before a good hello: anything else is refused and the socket closed (4401)', async () => {
    for (const first of [
      JSON.stringify(say('hi')),
      'not json',
      Buffer.from([0xff, 0xfe]),
      JSON.stringify({ type: 'hello', clientId: 'x' }),
    ]) {
      const r = rig();
      const c = conn();
      await r.hub.onMessage(c, first);
      expect(c.of('error')).toHaveLength(1);
      expect(c).toMatchObject({ closed: true, code: 4401 });
      expect(r.hub.clientCount()).toBe(0);
    }
    const r = rig();
    const c = conn();
    await r.hub.onMessage(c, JSON.stringify(say('hi')));
    expect(c.sent).toEqual([{ type: 'error', message: 'say hello first, with a credential' }]);
  });

  it('a good hello is welcomed with the user, a ticket and the transcript; garbage after it is survived', async () => {
    const r = rig();
    const c = conn();
    await r.hub.onMessage(c, JSON.stringify(hello('tab-1')));
    const w = c.of('welcome')[0];
    expect(w).toEqual({
      type: 'welcome',
      transcript: [],
      status: 'idle',
      agent: 'fake',
      transcribe: false,
      ha: 'mock',
      user: { name: 'alice' },
      ticket: expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/),
    });
    expect(r.hub.ticket(w.ticket)).toMatchObject({
      user: { name: 'alice', key: 'secret:alice' },
      owner: owner('alice', 'tab-1'),
    });
    await r.hub.onMessage(c, 'not json');
    await r.hub.onMessage(c, Buffer.from([0xff, 0xfe]));
    await r.hub.onMessage(c, JSON.stringify({ type: 'nope' }));
    expect(c.of('error')).toHaveLength(3);
    expect(c.closed).toBe(false);
    await r.hub.onMessage(c, JSON.stringify(hello('tab-2')));
    expect(c.sent.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/already said hello/) });
    expect(r.audit.records.filter((x) => x.kind === 'auth')).toMatchObject([{ user: 'alice', decision: 'ok' }]);
  });

  it('a wrong access code, an unknown name, or a kind the server does not take: not authorised, closed', async () => {
    for (const auth of [
      { type: 'secret', secret: 'alice:wrong' },
      { type: 'secret', secret: 'mallory:alice-secret' },
      { type: 'secret', secret: 'alice-secret' },
      { type: 'ha', token: 'mock-user:alice' }, // the rig takes access codes only
    ]) {
      const r = rig();
      const c = conn();
      await r.hub.onMessage(c, hello('tab-1', { auth } as never));
      expect(c.sent).toEqual([{ type: 'error', message: 'not authorised' }]);
      expect(c).toMatchObject({ closed: true, code: 4401 });
      expect(r.hub.clientCount()).toBe(0);
      expect(r.audit.records.filter((x) => x.kind === 'auth')).toMatchObject([{ decision: 'refused' }]);
    }
  });

  it('after 5 failed logins an address is refused unchecked (4429), others are not; a right code still gets in', async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) {
      const c = conn('10.9.9.9');
      await r.hub.onMessage(c, hello('t', { auth: { type: 'secret', secret: 'alice:guess' } }));
      expect(c.code).toBe(4401);
    }
    const blocked = conn('10.9.9.9');
    await r.hub.onMessage(blocked, hello('t', { auth: { type: 'secret', secret: 'alice:guess' } }));
    expect(blocked.sent).toEqual([{ type: 'error', message: 'too many failed attempts; try again in a minute' }]);
    expect(blocked.code).toBe(4429);
    const right = conn('10.9.9.9'); // the access code is checked first: a right one isn't locked out by the guesses
    await r.hub.onMessage(right, hello('t'));
    expect(right.of('welcome')).toHaveLength(1);
    const other = conn('10.0.0.8');
    await r.hub.onMessage(other, hello('t'));
    expect(other.of('welcome')).toHaveLength(1);
  });

  it('before the login only the hello: anything sent while it is checked cuts the connection off, nothing queued', async () => {
    const r = rig();
    const wait = deferred();
    const verify = authenticator();
    let checks = 0;
    const hub = hubOf(r, { authenticate: async (h, c) => (checks++, await wait.promise, verify(h, c)) });
    const c = conn();
    const p = hub.onMessage(c, hello('t'));
    for (let i = 0; i < 1000; i++) void hub.onMessage(c, JSON.stringify(say(`flood ${i}`)));
    for (let i = 0; i < 10; i++) void hub.onMessage(c, hello('t'));
    expect(c.terminated).toBe(true);
    wait.resolve();
    await p;
    expect(checks).toBe(1);
    expect(hub.clientCount()).toBe(0); // the hello was good, but the connection is gone
    expect(c.sent).toEqual([]);
    await hub.idle();
    expect(r.agent.prompts).toEqual([]);
    expect(authLines(r)).toMatchObject([{ decision: 'refused', detail: 'a message before the login finished' }]);
  });

  it('a big first message is cut off unread', async () => {
    const r = rig();
    const hub = hubOf(r);
    const c = conn();
    await hub.onMessage(c, JSON.stringify({ ...hello('t'), pad: 'x'.repeat(9000) }));
    expect(c).toMatchObject({ terminated: true, sent: [] });
    expect(hub.clientCount()).toBe(0);
    const ok = conn();
    await hub.onMessage(ok, JSON.stringify({ ...hello('t'), pad: 'x'.repeat(4000) }));
    expect(ok.of('welcome')).toHaveLength(1);
  });

  it('a refused connection is gone at once: later messages ignored, one audit line, cut off after the grace', async () => {
    const r = rig();
    const hub = hubOf(r, { closeGraceMs: 20 });
    const c = conn();
    await hub.onMessage(c, hello('t', { auth: { type: 'secret', secret: 'alice:wrong' } }));
    expect(c).toMatchObject({ closed: true, code: 4401, terminated: false });
    for (let i = 0; i < 5; i++) await hub.onMessage(c, hello('t')); // even with the right code now
    await hub.onMessage(c, JSON.stringify(say('hi')));
    expect(c.sent).toEqual([{ type: 'error', message: 'not authorised' }]);
    expect(hub.clientCount()).toBe(0);
    expect(authLines(r)).toHaveLength(1);
    await until(() => c.terminated); // it didn't close: cut off
    // one that closes in time isn't
    const d = conn();
    await hub.onMessage(d, JSON.stringify(say('x')));
    expect(d.code).toBe(4401);
    hub.onClose(d);
    await sleep(40);
    expect(d.terminated).toBe(false);
  });

  it('caps the connections waiting to log in, per address and in all; no hello in time: 4401', async () => {
    const r = rig();
    const hub = hubOf(r, { preAuth: { perAddress: 2, total: 3 }, helloTimeoutMs: 30 });
    const [a1, a2, a3] = [conn('10.1.1.1'), conn('10.1.1.1'), conn('10.1.1.1')];
    expect([hub.onOpen(a1), hub.onOpen(a2)]).toEqual([true, true]);
    expect(hub.admits('10.1.1.1')).toBe(false);
    expect(hub.onOpen(a3)).toBe(false);
    const b = conn('10.2.2.2');
    expect(hub.onOpen(b)).toBe(true);
    expect(hub.admits('10.3.3.3')).toBe(false); // all of them
    await hub.onMessage(a1, hello('t')); // logged in: no longer waiting
    expect(hub.authenticated(a1)).toBe(true);
    expect(hub.admits('10.1.1.1')).toBe(true);
    hub.onClose(b);
    expect(hub.admits('10.3.3.3')).toBe(true);
    await until(() => a2.closed); // never said hello
    expect(a2).toMatchObject({ code: 4401, sent: [{ type: 'error', message: 'not authorised' }] });
    expect(authLines(r).at(-1)).toMatchObject({ decision: 'refused', detail: 'no hello in time' });
    await sleep(40);
    expect(a1.closed).toBe(false);
    expect(hub.admits('10.1.1.1')).toBe(true);
    await hub.close();
  });

  it('after the login a flood of waiting messages closes the connection (1008)', async () => {
    const r = rig(() => new Promise(() => {}), { turnTimeoutMs: 100 });
    const a = await join2(r);
    await r.hub.onMessage(a, JSON.stringify(say('hang')));
    await until(() => a.of('turn.start').length);
    void r.hub.onMessage(a, JSON.stringify({ type: 'reset' })); // waits for the hung turn
    for (let i = 0; i < 60; i++) void r.hub.onMessage(a, JSON.stringify(say(`m${i}`)));
    expect(a).toMatchObject({ closed: true, code: 1008 });
    expect(r.hub.clientCount()).toBe(0);
    await r.hub.idle();
    expect(r.agent.prompts).toEqual(['[turn] hang']);
  });

  it('the surface comes from the credential: a speaker stays a speaker whatever its hello says', async () => {
    const r = rig(async (t, emit, _tools, a) => {
      a.results.push(t.surface);
      emit({ type: 'done' });
    });
    const s = await join2(r, 'kitchen', { auth: secret('kitchen'), surface: 'screen' });
    await r.hub.onMessage(s, JSON.stringify(say('hello')));
    await r.hub.idle();
    expect(r.agent.results).toEqual(['speaker']);
    expect(s.of('turn.start')[0].surface).toBe('speaker');
    expect(s.of('welcome')[0].user).toEqual({ name: 'kitchen' });
  });

  it('tickets: one per connection, renewed, dead when the connection closes or after their time', async () => {
    let t = 1_000_000;
    const r = rig();
    const hub = createHub({
      agent: r.agent,
      tools: [],
      gate: r.gate,
      info: { agent: 'fake', ha: 'mock', transcribe: true },
      authenticate: authenticator(),
      ticketTtlMs: 60_000,
      now: () => t,
    });
    const a = conn();
    const b = conn();
    await hub.onMessage(a, hello('tab-1'));
    await hub.onMessage(b, hello('tab-1', { auth: secret('bob') }));
    const ta = a.of('welcome')[0].ticket;
    const tb = b.of('welcome')[0].ticket;
    expect(ta).not.toBe(tb);
    expect(hub.ticket(ta)?.owner).toBe(owner('alice', 'tab-1'));
    expect(hub.ticket(tb)?.owner).toBe(owner('bob', 'tab-1'));
    for (const bad of [undefined, '', 'nope', `${ta}x`, 42]) expect(hub.ticket(bad)).toBeNull();
    // the connection closes: its ticket dies; a reconnect gets a new one
    hub.onClose(a);
    expect(hub.ticket(ta)).toBeNull();
    const a2 = conn();
    await hub.onMessage(a2, hello('tab-1'));
    const ta2 = a2.of('welcome')[0].ticket;
    expect(ta2).not.toBe(ta);
    expect(hub.ticket(ta2)?.user.name).toBe('alice');
    // and it expires on its own
    t += 60_000;
    expect(hub.ticket(ta2)).toBeNull();
    await hub.close();
  });

  it('a fresh ticket arrives every half ticket life', async () => {
    const r = rig();
    const hub = createHub({
      agent: r.agent,
      tools: [],
      gate: r.gate,
      info: { agent: 'fake', ha: 'mock', transcribe: true },
      authenticate: authenticator(),
      ticketTtlMs: 40,
    });
    const a = conn();
    await hub.onMessage(a, hello('tab-1'));
    await until(() => a.of('ticket').length >= 2);
    const [t1, t2] = a.of('ticket').map((m) => m.ticket);
    expect(t1).not.toBe(t2);
    expect(hub.ticket(t2)?.user.name).toBe('alice');
    hub.onClose(a);
    const n = a.of('ticket').length;
    await new Promise((res) => setTimeout(res, 60));
    expect(a.of('ticket')).toHaveLength(n);
    expect(hub.ticket(t2)).toBeNull();
  });

  it('say is rate-limited per user', async () => {
    let t = 0;
    const r = rig(undefined, { sayLimit: createRateLimiter({ burst: 2, perMinute: 6 }, () => t) });
    const a = await join2(r);
    const a2 = await join2(r, 'tab-2'); // alice again, another tab: the same bucket
    const b = await join2(r, 'tab-3', { auth: secret('bob') });
    await r.hub.onMessage(a, JSON.stringify(say('one')));
    await r.hub.onMessage(a2, JSON.stringify(say('two')));
    await r.hub.onMessage(a, JSON.stringify(say('three')));
    expect(a.of('error').map((e) => e.message)).toEqual(['slow down: too many requests; try again in a moment']);
    await r.hub.onMessage(b, JSON.stringify(say('bob')));
    expect(b.of('error')).toEqual([]);
    t += 10_000; // one more a minute / 6
    await r.hub.onMessage(a, JSON.stringify(say('four')));
    await r.hub.idle();
    expect(r.agent.prompts).toEqual(['[turn] one', '[turn] two', '[turn] bob', '[turn] four']);
  });

  it('interrupt and reset come out of the same bucket: over it, "slow down" and nothing happens', async () => {
    const r = rig(undefined, { sayLimit: createRateLimiter({ burst: 2, perMinute: 1 }, () => 0) });
    const a = await join2(r);
    await r.hub.onMessage(a, JSON.stringify({ type: 'reset' }));
    await r.hub.onMessage(a, JSON.stringify({ type: 'interrupt' }));
    const welcomes = a.of('welcome').length;
    await r.hub.onMessage(a, JSON.stringify({ type: 'reset' }));
    await r.hub.onMessage(a, JSON.stringify({ type: 'interrupt' }));
    await r.hub.onMessage(a, JSON.stringify(say('hi')));
    expect(r.agent.resets).toBe(1);
    expect(a.of('welcome')).toHaveLength(welcomes);
    expect(a.of('error').map((e) => e.message)).toEqual([SLOW, SLOW, SLOW]);
    expect(r.agent.prompts).toEqual([]);
  });

  it('revalidate (the clients file reloaded): a gone login is closed 4401, a changed surface 1012, the rest stay', async () => {
    const r = rig();
    const a = await join2(r);
    const b = await join2(r, 'tab-2', { auth: secret('bob') });
    const k = await join2(r, 'kitchen', { auth: secret('kitchen') });
    const seen: unknown[] = [];
    const n = r.hub.revalidate((u, cred) => {
      seen.push(cred);
      return u.name === 'alice' ? 'refused' : u.name === 'kitchen' ? 'changed' : 'ok';
    });
    expect(n).toBe(2);
    expect(seen).toContainEqual(secret('alice')); // (with the credential it logged in with)
    expect(a).toMatchObject({ closed: true, code: 4401 });
    expect(a.of('error').at(-1)!.message).toBe('not authorised');
    expect(k).toMatchObject({ closed: true, code: 1012 });
    expect(b.closed).toBe(false);
    expect(r.hub.clientCount()).toBe(1);
    expect(r.hub.ticket(a.of('welcome')[0].ticket)).toBeNull();
    await r.hub.onMessage(a, JSON.stringify(say('still here?')));
    await r.hub.idle();
    expect(r.agent.prompts).toEqual([]);
    expect(authLines(r).slice(-2)).toMatchObject([
      { user: 'alice', decision: 'revoked' },
      { user: 'kitchen', decision: 'changed' },
    ]);
  });

  it('an HA login is checked again every 10 minutes with the latest token; HA down keeps it; refused closes 4401', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      let verdict: Recheck = 'ok';
      const seen: string[] = [];
      const hub = hubOf(r, {
        authenticate: async () => ({ ok: true, user: { key: 'ha:u1', name: 'Ana', via: 'ha', surface: 'screen' } }),
        recheck: async (_u, cred) => (seen.push(cred.type === 'ha' ? cred.token : '?'), verdict),
      });
      const c = conn();
      await hub.onMessage(c, hello('t', { auth: { type: 'ha', token: 't0' } }));
      expect(c.of('welcome')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(seen).toEqual([]);
      await hub.onMessage(c, { type: 'auth', auth: { type: 'ha', token: 't1' } }); // a fresh token: kept
      await hub.onMessage(c, { type: 'auth', auth: { type: 'secret', secret: 'x:y' } });
      expect(c.of('error').at(-1)!.message).toBe('auth: this connection logged in with ha');
      expect(seen).toEqual([]); // (not due yet)
      await vi.advanceTimersByTimeAsync(60_000);
      expect(seen).toEqual(['t1']);
      verdict = 'unknown'; // Home Assistant down: kept, and tried again a minute later
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(seen).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(seen).toHaveLength(3);
      expect(c.closed).toBe(false);
      verdict = 'refused';
      await vi.advanceTimersByTimeAsync(60_000);
      expect(c).toMatchObject({ closed: true, code: 4401 });
      expect(hub.clientCount()).toBe(0);
      await hub.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fresh HA token arriving when a check is due is checked at once', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      const seen: string[] = [];
      const hub = hubOf(r, {
        authenticate: async () => ({ ok: true, user: { key: 'ha:u1', name: 'Ana', via: 'ha', surface: 'screen' } }),
        recheck: async (_u, cred) => (seen.push(cred.type === 'ha' ? cred.token : '?'), 'refused'),
        recheckMs: 25_500,
        recheckRetryMs: 1000,
      });
      const c = conn();
      await hub.onMessage(c, hello('t', { auth: { type: 'ha', token: 't0' } }));
      await vi.advanceTimersByTimeAsync(25_600); // due, and the next sweep is 400 ms away
      expect(seen).toEqual([]);
      await hub.onMessage(c, { type: 'auth', auth: { type: 'ha', token: 't1' } });
      expect(seen).toEqual(['t1']);
      expect(c).toMatchObject({ closed: true, code: 4401 });
      await hub.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a refused login cannot be talked past: an authenticate that throws refuses', async () => {
    const r = rig();
    const hub = createHub({
      agent: r.agent,
      tools: [],
      gate: r.gate,
      info: { agent: 'fake', ha: 'mock', transcribe: false },
      authenticate: () => {
        throw new Error('boom');
      },
    });
    const c = conn();
    await hub.onMessage(c, hello('evil'));
    expect(c.sent).toEqual([{ type: 'error', message: 'not authorised' }]);
    expect(c).toMatchObject({ closed: true, code: 4401 });
    expect(hub.clientCount()).toBe(0);
  });

  it('a connection that closes during an async authenticate is not registered', async () => {
    const r = rig(actScript);
    const wait = deferred();
    const verify = authenticator();
    const hub = createHub({
      agent: r.agent,
      tools: [],
      gate: r.gate,
      info: { agent: 'fake', ha: 'mock', transcribe: false },
      authenticate: async (h, c) => (await wait.promise, verify(h, c)),
    });
    const c = conn();
    const p = hub.onMessage(c, hello('slow'));
    hub.onClose(c);
    wait.resolve();
    await p;
    expect(hub.clientCount()).toBe(0);
    expect(c.sent).toEqual([]);
  });
});

describe('hub: turns', () => {
  it('runs turns one at a time, in order, broadcasting the stream to every client', async () => {
    const gates = [deferred(), deferred()];
    let n = 0;
    const r = rig(async (_t, emit) => {
      const i = n++;
      emit({ type: 'text', delta: `answer ${i}` });
      await gates[i].promise;
      emit({ type: 'done' });
    });
    const a = await join2(r);
    const b = await join2(r, 'tab-2');
    await r.hub.onMessage(a, JSON.stringify(say('first')));
    await r.hub.onMessage(b, JSON.stringify(say('second')));
    await until(() => a.of('text.delta').length === 1);
    await new Promise((res) => setTimeout(res, 10));
    expect(a.of('turn.start')).toHaveLength(1); // the second waits
    expect(r.agent.prompts).toEqual(['[turn] first']);
    gates[0].resolve();
    await until(() => a.of('turn.start').length === 2);
    gates[1].resolve();
    await r.hub.idle();
    for (const c of [a, b]) {
      const types = c.sent.filter((m) => m.type !== 'welcome').map((m) => m.type);
      expect(types).toEqual([
        'turn.start',
        'status',
        'text.delta',
        'turn.end',
        'turn.start',
        'status',
        'text.delta',
        'turn.end',
        'status',
      ]);
      expect(c.of('turn.start').map((m) => [m.text, m.surface])).toEqual([
        ['first', 'screen'],
        ['second', 'screen'],
      ]);
      expect(c.of('status').map((s) => s.state)).toEqual(['thinking', 'thinking', 'idle']);
    }
  });

  it('an agent that throws ends its turn with an error; the next turn still runs', async () => {
    let n = 0;
    const r = rig(async (_t, emit) => {
      if (n++ === 0) throw new Error('rate limited');
      emit({ type: 'done' });
    });
    const a = await join2(r);
    await r.hub.onMessage(a, JSON.stringify(say('one')));
    await r.hub.onMessage(a, JSON.stringify(say('two')));
    await r.hub.idle();
    expect(a.of('turn.end').map((e) => e.error)).toEqual(['rate limited', undefined]);
    expect(a.of('status').map((s) => s.state)).toContain('error');
  });

  it('tool calls: chips per call, bad input and unknown tools come back as errors, all audited', async () => {
    const r = rig(async (_t, emit, tools, a) => {
      a.results.push((await tools.call('site_search', { query: 'water heater' })).text);
      a.results.push(JSON.stringify(await tools.call('ha_state', { entity_ids: ['bad id'] })));
      a.results.push(JSON.stringify(await tools.call('shell', {})));
      emit({ type: 'tool', callId: 'ws1', name: 'WebSearch', summary: 'Searching the web for x', status: 'running' });
      emit({ type: 'tool', callId: 'ws1', name: 'WebSearch', summary: 'Searching the web for x', status: 'done' });
      emit({ type: 'done' });
    });
    const c = await join2(r);
    await r.hub.onMessage(c, JSON.stringify(say('where is the water heater')));
    await r.hub.idle();
    expect(JSON.parse(r.agent.results[0])[0].subject).toBe('pins:plumb.water-heater');
    expect(JSON.parse(r.agent.results[1])).toMatchObject({
      isError: true,
      text: expect.stringMatching(/not valid ids/),
    });
    expect(JSON.parse(r.agent.results[2])).toEqual({ text: 'there is no tool called shell', isError: true });
    const chips = c.of('tool');
    expect(chips[0]).toMatchObject({ name: 'site_search', status: 'done', subject: 'pins:plumb.water-heater' });
    expect(chips.filter((x) => x.name === 'WebSearch').map((x) => x.status)).toEqual(['running', 'done']);
    // one transcript row per call, updated in place
    expect(r.hub.transcript().filter((e) => e.kind === 'tool' && e.callId === 'ws1')).toMatchObject([
      { status: 'done' },
    ]);
    expect(r.hub.transcript().find((e) => e.kind === 'tool' && e.name === 'site_search')).toMatchObject({
      subject: 'pins:plumb.water-heater',
    });
    const tools = r.audit.records.filter((x) => x.kind === 'tool');
    expect(tools.map((x) => [x.tool, x.decision])).toEqual([
      ['site_search', 'done'],
      ['ha_state', 'error'],
      ['shell', 'unknown tool'],
    ]);
    expect(tools[0]).toMatchObject({
      user: 'alice',
      client: owner('alice', 'tab-1'),
      surface: 'screen',
      utterance: 'where is the water heater',
    });
  });

  it('reset: the agent starts afresh, a divider, everyone gets the transcript again', async () => {
    const r = rig();
    const a = await join2(r);
    const b = await join2(r, 'tab-2');
    await r.hub.onMessage(a, JSON.stringify(say('hi')));
    await r.hub.idle();
    await r.hub.onMessage(b, JSON.stringify({ type: 'reset' }));
    expect(r.agent.resets).toBe(1);
    for (const c of [a, b])
      expect(c.of('welcome').at(-1)!.transcript.at(-1)).toMatchObject({ kind: 'divider', text: 'New conversation' });
  });

  it('text after a tool chip is a paragraph of its own in the transcript', async () => {
    const r = rig(async (_t, emit) => {
      emit({ type: 'text', delta: 'Let me look.' });
      emit({ type: 'tool', callId: 'w1', name: 'WebSearch', summary: 'Searching the web for me', status: 'running' });
      emit({ type: 'tool', callId: 'w1', name: 'WebSearch', summary: 'Searching the web for me', status: 'done' });
      emit({ type: 'text', delta: 'You are ' });
      emit({ type: 'text', delta: 'nowhere.' });
      emit({ type: 'done' });
    });
    const a = await join2(r);
    await r.hub.onMessage(a, JSON.stringify(say('where am i')));
    await r.hub.idle();
    expect(r.hub.transcript().map((e) => (e.kind === 'assistant' ? e.text : e.kind))).toEqual([
      'user',
      'Let me look.',
      'tool',
      'You are nowhere.',
    ]);
  });

  it('a turn that never finishes is ended by the watchdog, the agent reset, and the queue moves on', async () => {
    let n = 0;
    const r = rig(
      async (_t, emit, tools, a) => {
        if (n++ === 0) {
          await new Promise(() => {}); // hangs forever
        }
        a.results.push('second');
        emit({ type: 'text', delta: 'ok' });
        emit({ type: 'done' });
        void tools;
      },
      { turnTimeoutMs: 50 },
    );
    const a = await join2(r);
    await r.hub.onMessage(a, JSON.stringify(say('first')));
    await r.hub.onMessage(a, JSON.stringify(say('second')));
    await r.hub.idle();
    const ends = a.of('turn.end');
    expect(ends).toHaveLength(2);
    expect(ends[0].error).toBe('no answer within 0 s, so the assistant was restarted');
    expect(ends[1].error).toBeUndefined();
    expect(r.agent.resets).toBe(1);
    expect(r.agent.results).toEqual(['second']);
  });

  it('reset during a hung turn returns (bounded by the watchdog)', async () => {
    const r = rig(() => new Promise(() => {}), { turnTimeoutMs: 50 });
    const a = await join2(r);
    await r.hub.onMessage(a, JSON.stringify(say('hang')));
    await until(() => a.of('turn.start').length);
    await r.hub.onMessage(a, JSON.stringify({ type: 'reset' }));
    expect(a.of('turn.end')).toHaveLength(1);
    expect(a.of('welcome').at(-1)!.transcript.at(-1)).toMatchObject({ kind: 'divider' });
  });

  it('a late tool call from a turn the watchdog ended does nothing', async () => {
    let late: Promise<{ text: string }> | null = null;
    const go = deferred();
    const r = rig(
      async (_t, _emit, tools) => {
        await go.promise; // past the watchdog
        late = tools.call('ha_act', { entity_ids: ['light.hall'], service: 'turn_on' });
        await new Promise(() => {});
      },
      { turnTimeoutMs: 30 },
    );
    const a = await join2(r);
    await r.hub.onMessage(a, JSON.stringify(say('hang')));
    await r.hub.idle();
    go.resolve();
    await until(() => late);
    expect((await late!).text).toBe('this turn has ended; nothing was done');
    expect(r.ha.calls).toEqual([]);
  });
});

describe('hub: view commands', () => {
  const flyScript: Script = async (_t, emit, tools, a) => {
    a.results.push((await tools.call('view_fly', { subject: 'pins:plumb.water-heater' })).text);
    emit({ type: 'done' });
  };

  it('round trip: view.command to the turn client only, view.result answers the tool', async () => {
    const r = rig(flyScript);
    const a = await join2(r);
    const b = await join2(r, 'tab-2');
    await r.hub.onMessage(a, JSON.stringify(say('show me the water heater')));
    await until(() => a.of('view.command').length);
    const cmd = a.of('view.command')[0];
    expect(cmd).toMatchObject({ op: 'fly', args: { subject: 'pins:plumb.water-heater' } });
    expect(b.of('view.command')).toEqual([]);
    // someone else's answer, and an unknown id, are ignored
    await r.hub.onMessage(b, JSON.stringify({ type: 'view.result', id: cmd.id, ok: false }));
    await r.hub.onMessage(a, JSON.stringify({ type: 'view.result', id: 'nope', ok: false }));
    expect(a.of('error')).toEqual([]);
    await r.hub.onMessage(a, JSON.stringify({ type: 'view.result', id: cmd.id, ok: true }));
    await r.hub.idle();
    expect(r.agent.results).toEqual(['showing pins:plumb.water-heater']);
  });

  it('times out when the viewer does not answer', async () => {
    const r = rig(flyScript, { viewTimeoutMs: 30 });
    const a = await join2(r);
    await r.hub.onMessage(a, JSON.stringify(say('show me')));
    await r.hub.idle();
    expect(r.agent.results).toEqual(['could not show it: no answer from the viewer']);
  });

  it('no viewer: a speaker, or a screen without the capability', async () => {
    const r = rig(flyScript);
    const s = await join2(r, 'kitchen-speaker', { auth: secret('kitchen'), capabilities: [] });
    await r.hub.onMessage(s, JSON.stringify(say('show me')));
    await r.hub.idle();
    expect(s.of('view.command')).toEqual([]);
    expect(r.agent.results).toEqual(['could not show it: no viewer attached']);
  });

  it('the viewer disconnecting answers its pending command', async () => {
    const r = rig(flyScript, { viewTimeoutMs: 5000 });
    const a = await join2(r);
    await r.hub.onMessage(a, JSON.stringify(say('show me')));
    await until(() => a.of('view.command').length);
    r.hub.onClose(a);
    await r.hub.idle();
    expect(r.agent.results).toEqual(['could not show it: no viewer attached']);
  });
});

describe('hub: confirmations', () => {
  it('end to end: pending → approve → Home Assistant called → resolved', async () => {
    const r = rig(actScript);
    const a = await join2(r);
    const b = await join2(r, 'tab-2');
    await r.hub.onMessage(a, JSON.stringify(say('set the hall to 72')));
    await until(() => a.of('confirm.request').length);
    const req = a.of('confirm.request')[0];
    expect(req.summary).toMatch(/Hall thermostat/);
    expect(req.detail).toMatch(/climate\.set_temperature/);
    expect(req.expiresAt).toBeGreaterThan(Date.now());
    expect(req.ttlMs).toBeGreaterThan(29_000); // the time left, for a client whose clock is off
    expect(req.ttlMs).toBeLessThanOrEqual(30_000);
    expect(b.of('confirm.request')).toEqual([]); // only the client that asked
    expect(a.of('tool').at(-1)).toMatchObject({ name: 'ha_act', status: 'pending' });
    expect(r.ha.calls).toEqual([]);

    await r.hub.onMessage(a, JSON.stringify({ type: 'confirm.reply', id: req.id, approved: true }));
    await r.hub.idle();
    expect(r.ha.calls).toMatchObject([
      {
        domain: 'climate',
        service: 'set_temperature',
        data: { entity_id: ['climate.hall_thermostat'], temperature: 72 },
      },
    ]);
    for (const c of [a, b])
      expect(c.of('confirm.resolved')).toEqual([{ type: 'confirm.resolved', id: req.id, outcome: 'approved' }]);
    expect(r.agent.results[0]).toMatch(/^done: /);
    // the pending chip and the final chip are the same row
    const chips = a.of('tool').filter((t) => t.name === 'ha_act');
    expect(new Set(chips.map((t) => t.callId)).size).toBe(1);
    expect(req.callId).toBe(chips[0].callId);
    expect(chips.map((t) => t.status)).toEqual(['running', 'pending', 'done']);
  });

  it('a reply from another client is rejected and changes nothing', async () => {
    const r = rig(actScript);
    const a = await join2(r);
    const b = await join2(r, 'tab-2');
    await r.hub.onMessage(a, JSON.stringify(say('set the hall to 72')));
    await until(() => a.of('confirm.request').length);
    const { id } = a.of('confirm.request')[0];
    await r.hub.onMessage(b, JSON.stringify({ type: 'confirm.reply', id, approved: true }));
    expect(b.of('error').at(-1)!.message).toBe('confirm.reply: not your pending action');
    expect(r.gate.pending(owner('alice', 'tab-1'))).toHaveLength(1);
    expect(r.ha.calls).toEqual([]);
    await r.hub.onMessage(a, JSON.stringify({ type: 'confirm.reply', id, approved: false }));
    await r.hub.idle();
    expect(r.agent.results[0]).toMatch(/^the person declined/);
    expect(a.of('confirm.resolved')[0].outcome).toBe('denied');
    await r.hub.onMessage(a, JSON.stringify({ type: 'confirm.reply', id, approved: true }));
    expect(a.of('error').at(-1)!.message).toMatch(/already answered/);
    expect(r.ha.calls).toEqual([]);
  });

  it('confirmations belong to the user AND the client: same id as another user, or same user elsewhere, cannot answer', async () => {
    const r = rig(actScript);
    const a = await join2(r, 'tab-1');
    const bobSameId = await join2(r, 'tab-1', { auth: secret('bob') });
    const aliceElsewhere = await join2(r, 'tab-9');
    await r.hub.onMessage(a, JSON.stringify(say('set the hall to 72')));
    await until(() => a.of('confirm.request').length);
    const { id } = a.of('confirm.request')[0];
    // bob's tab with alice's client id neither sees the dialog nor may answer it
    expect(bobSameId.of('confirm.request')).toEqual([]);
    await r.hub.onMessage(bobSameId, JSON.stringify({ type: 'confirm.reply', id, approved: true }));
    expect(bobSameId.of('error').at(-1)!.message).toBe('confirm.reply: not your pending action');
    // alice herself, from another tab, may not either
    await r.hub.onMessage(aliceElsewhere, JSON.stringify({ type: 'confirm.reply', id, approved: true }));
    expect(aliceElsewhere.of('error').at(-1)!.message).toBe('confirm.reply: not your pending action');
    expect(r.gate.pending(owner('alice', 'tab-1'))).toHaveLength(1);
    expect(r.ha.calls).toEqual([]);
    // bob's tab closing (its client id is alice's too) cancels nothing of hers
    r.hub.onClose(bobSameId);
    expect(r.gate.pending(owner('alice', 'tab-1'))).toHaveLength(1);
    // the right one can
    await r.hub.onMessage(a, JSON.stringify({ type: 'confirm.reply', id, approved: true }));
    await r.hub.idle();
    expect(r.ha.calls).toHaveLength(1);
    expect(r.audit.records.find((x) => x.kind === 'tool' && x.tool === 'ha_act')).toMatchObject({ user: 'alice' });
  });

  it('a spoken yes counts only from the same speaker login', async () => {
    const r = rig(actScript, { ttlMs: 150 });
    // two connections with the same client id: the kitchen speaker, and alice's screen pretending to be it
    const s = await join2(r, 'kitchen-speaker', { auth: secret('kitchen'), capabilities: [] });
    const fake = await join2(r, 'kitchen-speaker', { surface: 'speaker', capabilities: [] });
    await r.hub.onMessage(s, JSON.stringify({ type: 'say', text: 'set the hall to 72', source: 'voice' }));
    await until(() => s.of('confirm.request').length);
    r.agent.script = async (_t, emit) => emit({ type: 'done' });
    await r.hub.onMessage(fake, JSON.stringify({ type: 'say', text: 'yes', source: 'voice' }));
    await r.hub.idle();
    expect(r.ha.calls).toEqual([]); // alice's "yes" was a new turn (a screen), not an answer
    expect(r.agent.prompts.at(-1)).toBe('[turn] yes');
    expect(r.agent.results[0]).toMatch(/^nobody confirmed/);
  });

  it('a spoken "yes" on a speaker approves, and does not become a turn', async () => {
    const r = rig(actScript);
    const s = await join2(r, 'kitchen-speaker', { auth: secret('kitchen'), capabilities: ['tts'] });
    await r.hub.onMessage(s, JSON.stringify({ type: 'say', text: 'set the hall to 72', source: 'voice' }));
    await until(() => s.of('confirm.request').length);
    await r.hub.onMessage(s, JSON.stringify({ type: 'say', text: 'Yes.', source: 'voice' }));
    await r.hub.idle();
    expect(r.ha.calls).toHaveLength(1);
    expect(s.of('turn.start')).toHaveLength(1);
    expect(r.agent.prompts).toEqual(['[turn] set the hall to 72']);
    expect(
      r.hub
        .transcript()
        .filter((e) => e.kind === 'user')
        .map((e) => (e as { text: string }).text),
    ).toEqual(['set the hall to 72', 'Yes.']);
  });

  it('a "yes" from a screen goes to the model, not to the gate (the screen has a dialog)', async () => {
    const r = rig(actScript, { ttlMs: 100 });
    const a = await join2(r);
    await r.hub.onMessage(a, JSON.stringify(say('set the hall to 72')));
    await until(() => a.of('confirm.request').length);
    r.agent.script = async (_t, emit) => emit({ type: 'done' });
    await r.hub.onMessage(a, JSON.stringify(say('yes')));
    await r.hub.idle();
    expect(r.ha.calls).toEqual([]);
    expect(r.agent.results[0]).toMatch(/^nobody confirmed/);
    expect(r.agent.prompts).toEqual(['[turn] set the hall to 72', '[turn] yes']);
  });

  it('the agent saying "yes" approves nothing', async () => {
    const r = rig(
      async (_t, emit, tools, a) => {
        const pending = tools.call('ha_act', THERMOSTAT);
        await until(() => r.gate.pending().length);
        emit({ type: 'text', delta: 'yes' });
        emit({ type: 'text', delta: 'Yes. Confirm. Do it.' });
        a.results.push((await tools.call('memory_save', { name: 'yes', text: 'yes' })).text);
        a.results.push((await pending).text);
        emit({ type: 'done' });
      },
      { ttlMs: 80 },
    );
    const s = await join2(r, 'kitchen-speaker', { auth: secret('kitchen'), capabilities: [] });
    await r.hub.onMessage(s, JSON.stringify({ type: 'say', text: 'set the hall to 72', source: 'voice' }));
    await r.hub.idle();
    expect(r.ha.calls).toEqual([]);
    expect(r.agent.results[1]).toMatch(/^nobody confirmed/);
    expect(s.of('confirm.resolved')[0].outcome).toBe('expired');
  });

  it('interrupt cancels the pending confirmation and ends the turn as interrupted', async () => {
    const r = rig(actScript);
    const a = await join2(r);
    await r.hub.onMessage(a, JSON.stringify(say('set the hall to 72')));
    await until(() => a.of('confirm.request').length);
    await r.hub.onMessage(a, JSON.stringify({ type: 'interrupt' }));
    await r.hub.idle();
    expect(r.gate.pending()).toEqual([]);
    expect(r.ha.calls).toEqual([]);
    expect(a.of('confirm.resolved')[0]).toMatchObject({ outcome: 'denied', detail: 'cancelled' });
    expect(a.of('turn.end').at(-1)).toMatchObject({ interrupted: true });
    expect(r.agent.results[0]).toMatch(/^the person declined/);
  });

  it('an interrupt from another tab of the same user cancels the running turn’s confirmations too (barge-in)', async () => {
    const r = rig(actScript);
    const a = await join2(r);
    const b = await join2(r, 'tab-2');
    await r.hub.onMessage(a, JSON.stringify(say('set the hall to 72')));
    await until(() => a.of('confirm.request').length);
    await r.hub.onMessage(b, JSON.stringify({ type: 'interrupt' }));
    await r.hub.idle();
    expect(r.gate.pending()).toEqual([]);
    expect(r.ha.calls).toEqual([]);
    expect(a.of('confirm.resolved')[0]).toMatchObject({ outcome: 'denied', detail: 'cancelled' });
    expect(a.of('turn.end').at(-1)).toMatchObject({ interrupted: true });
  });

  it('an interrupt from another user stops the turn but leaves the confirmation to its owner', async () => {
    const r = rig(actScript);
    const a = await join2(r);
    const b = await join2(r, 'tab-b', { auth: secret('bob') });
    await r.hub.onMessage(a, JSON.stringify(say('set the hall to 72')));
    await until(() => a.of('confirm.request').length);
    await r.hub.onMessage(b, JSON.stringify({ type: 'interrupt' }));
    expect(r.agent.interrupted).toBe(true);
    expect(r.gate.pending(owner('alice', 'tab-1'))).toHaveLength(1);
    expect(a.of('confirm.resolved')).toEqual([]);
    await r.hub.onMessage(
      a,
      JSON.stringify({ type: 'confirm.reply', id: a.of('confirm.request')[0].id, approved: false }),
    );
    await r.hub.idle();
    expect(a.of('turn.end').at(-1)).toMatchObject({ interrupted: true });
    expect(r.ha.calls).toEqual([]);
  });

  it('disconnecting cancels the pending confirmation', async () => {
    const r = rig(actScript);
    const a = await join2(r);
    const b = await join2(r, 'tab-2');
    await r.hub.onMessage(a, JSON.stringify(say('set the hall to 72')));
    await until(() => a.of('confirm.request').length);
    r.hub.onClose(a);
    await r.hub.idle();
    expect(r.gate.pending()).toEqual([]);
    expect(r.ha.calls).toEqual([]);
    expect(b.of('confirm.resolved')[0].outcome).toBe('denied');
  });

  it('a reconnect of the same client id sees its pending confirmation again', async () => {
    const r = rig(actScript);
    const a = await join2(r);
    const other = await join2(r, 'tab-3');
    await r.hub.onMessage(a, JSON.stringify(say('set the hall to 72')));
    await until(() => a.of('confirm.request').length);
    const again = await join2(r, 'tab-1');
    expect(again.of('confirm.request')).toHaveLength(1);
    expect(again.of('confirm.request')[0].callId).toBe(a.of('confirm.request')[0].callId);
    r.hub.onClose(a); // another connection of tab-1 remains: still pending
    expect(r.gate.pending(owner('alice', 'tab-1'))).toHaveLength(1);
    expect(other.of('confirm.request')).toEqual([]);
    r.hub.onClose(again);
    await r.hub.idle();
    expect(r.gate.pending()).toEqual([]);
  });
});
