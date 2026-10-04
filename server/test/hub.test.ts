// The session hub with fake connections and a fake agent that calls the real tools, through the real gate, against the
// mock Home Assistant and the example policy: hello/welcome, malformed input, turn serialisation and broadcast, view
// commands, and the confirmation flow, including that nothing the agent says can approve an action.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryAudit } from '../src/core/audit.ts';
import { createGate, type Gate } from '../src/core/gate.ts';
import { createMockHa, type MockHa } from '../src/core/ha-mock.ts';
import { createHub, parseClientMsg, type Conn, type Hub } from '../src/core/hub.ts';
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
  of<T extends ServerMsg['type']>(type: T): Extract<ServerMsg, { type: T }>[];
}
function conn(): FakeConn {
  const c: FakeConn = {
    sent: [],
    closed: false,
    send: (m) => void c.sent.push(structuredClone(m)),
    close: () => void (c.closed = true),
    of: (type) => c.sent.filter((m) => m.type === type) as never,
  };
  return c;
}

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
function rig(script?: Script, opts: { viewTimeoutMs?: number; ttlMs?: number } = {}): Rig {
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
  });
  return { hub, gate, ha, agent, audit };
}

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

const hello = (clientId: string, extra: Partial<Extract<ClientMsg, { type: 'hello' }>> = {}) => ({
  type: 'hello',
  clientId,
  surface: 'screen',
  capabilities: ['viewer', 'tts'],
  ...extra,
});
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
    expect(parseClientMsg(JSON.stringify(hello('a')))).toEqual({
      type: 'hello',
      clientId: 'a',
      surface: 'screen',
      capabilities: ['viewer', 'tts'],
      view: undefined,
    });
    expect(parseClientMsg({ type: 'say', text: ' hi ' })).toEqual({ type: 'say', text: 'hi', source: 'typed' });
    for (const bad of [
      'nope{',
      null,
      [],
      { type: 3 },
      { type: 'hello', clientId: '', surface: 'screen' },
      { type: 'hello', clientId: 'a', surface: 'tv' },
      { type: 'hello', clientId: 'a', surface: 'screen', capabilities: ['root'] },
      { type: 'hello', clientId: 'a', surface: 'screen', view: { room: 5 } },
      { type: 'say', text: '' },
      { type: 'say', text: 'x'.repeat(5000) },
      { type: 'say', text: 'hi', source: 'telepathy' },
      { type: 'confirm.reply', id: 'x', approved: 'yes' },
      { type: 'view.result', id: 'x' },
      { type: 'launch' },
    ])
      expect(typeof parseClientMsg(bad)).toBe('string');
  });
});

describe('hub: clients', () => {
  it('needs hello first, answers it with welcome, and survives garbage', async () => {
    const r = rig();
    const c = conn();
    await r.hub.onMessage(c, JSON.stringify(say('hi')));
    expect(c.sent).toEqual([{ type: 'error', message: 'say hello first' }]);
    await r.hub.onMessage(c, 'not json');
    await r.hub.onMessage(c, Buffer.from([0xff, 0xfe]));
    await r.hub.onMessage(c, JSON.stringify({ type: 'hello', clientId: 'x', surface: 'moon' }));
    expect(c.of('error')).toHaveLength(4);
    await r.hub.onMessage(c, JSON.stringify(hello('tab-1')));
    expect(c.of('welcome')[0]).toEqual({
      type: 'welcome',
      transcript: [],
      status: 'idle',
      agent: 'fake',
      transcribe: false,
      ha: 'mock',
    });
    await r.hub.onMessage(c, JSON.stringify(hello('tab-2')));
    expect(c.sent.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/already has a client id/) });
  });

  it('welcome carries the transcript so a second screen catches up', async () => {
    const r = rig(async (_t, emit) => {
      emit({ type: 'text', delta: 'Hello ' });
      emit({ type: 'text', delta: 'there.' });
      emit({ type: 'done' });
    });
    const a = await join2(r);
    await r.hub.onMessage(a, JSON.stringify(say('hi')));
    await r.hub.idle();
    const b = await join2(r, 'tab-2');
    expect(b.of('welcome')[0].transcript).toMatchObject([
      { kind: 'user', text: 'hi', source: 'typed', surface: 'screen' },
      { kind: 'assistant', text: 'Hello there.' },
    ]);
  });

  it('an authenticate hook can turn a client away', async () => {
    const r = rig();
    const hub = createHub({
      agent: r.agent,
      tools: [],
      gate: r.gate,
      info: { agent: 'fake', ha: 'mock', transcribe: false },
      authenticate: (h) => (h.clientId === 'evil' ? 'not allowed' : null),
    });
    const c = conn();
    await hub.onMessage(c, hello('evil'));
    expect(c.sent).toEqual([{ type: 'error', message: 'not allowed' }]);
    expect(c.closed).toBe(true);
    expect(hub.clientCount()).toBe(0);
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
    expect(r.audit.records.map((x) => [x.tool, x.decision])).toEqual([
      ['site_search', 'done'],
      ['ha_state', 'error'],
      ['shell', 'unknown tool'],
    ]);
    expect(r.audit.records[0]).toMatchObject({
      client: 'tab-1',
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
    const s = await join2(r, 'kitchen-speaker', { surface: 'speaker', capabilities: [] });
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
    expect(r.gate.pending('tab-1')).toHaveLength(1);
    expect(r.ha.calls).toEqual([]);
    await r.hub.onMessage(a, JSON.stringify({ type: 'confirm.reply', id, approved: false }));
    await r.hub.idle();
    expect(r.agent.results[0]).toMatch(/^the person declined/);
    expect(a.of('confirm.resolved')[0].outcome).toBe('denied');
    await r.hub.onMessage(a, JSON.stringify({ type: 'confirm.reply', id, approved: true }));
    expect(a.of('error').at(-1)!.message).toMatch(/already answered/);
    expect(r.ha.calls).toEqual([]);
  });

  it('a spoken "yes" on a speaker approves, and does not become a turn', async () => {
    const r = rig(actScript);
    const s = await join2(r, 'kitchen-speaker', { surface: 'speaker', capabilities: ['tts'] });
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
    const s = await join2(r, 'kitchen-speaker', { surface: 'speaker', capabilities: [] });
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
    expect(r.gate.pending('tab-1')).toHaveLength(1);
    expect(other.of('confirm.request')).toEqual([]);
    r.hub.onClose(again);
    await r.hub.idle();
    expect(r.gate.pending()).toEqual([]);
  });
});
