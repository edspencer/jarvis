// The SDK agent against a fake query(): the options it starts the session with (tools, permissions, guard, resume),
// and how it maps the SDK's messages to the hub's events. No model is called.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createSdkAgent, zodShape } from '../../src/agent-sdk.ts';
import type { Escalation } from '../../src/core/config.ts';
import type { AgentEvent, ToolSpec } from '../../src/core/types.ts';

type Reply = (text: string, n: number) => SDKMessage[] | 'die' | 'hang' | Promise<SDKMessage[]>;

interface FakeOpts {
  /** a resumed session dies before its init message (a session id the CLI can't find) */
  badResume?: boolean;
  /** interrupt() throws (the turn still ends when its `result` comes) */
  interruptThrows?: boolean;
  /** more fields of the init message (model, apiKeySource, …) */
  init?: Record<string, unknown>;
  /** send init again before every turn, as the CLI does in streaming-input mode */
  initEachTurn?: boolean;
  /** setModel / applyFlagSettings throw when this says so */
  switchFails?: (what: string) => boolean;
}

/** a fake query(): answers each pushed user message with the messages `reply` gives */
function fakeQuery(reply: Reply, fo: FakeOpts = {}) {
  const calls: { options: Options; prompts: string[] }[] = [];
  /** prompts and model / effort switches, in order, across every process: 'prompt:hi', 'model:x', 'effort:high' */
  const trace: string[] = [];
  let interrupts = 0;
  let closes = 0;
  let wake: (() => void) | null = null;
  const impl = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const call = { options: params.options, prompts: [] as string[] };
    calls.push(call);
    const sid = `session-${calls.length}`;
    let wakeHang: (() => void) | null = null;
    let closed = false;
    async function* gen(): AsyncGenerator<SDKMessage> {
      if (fo.badResume && params.options.resume) {
        for await (const m of params.prompt) {
          call.prompts.push(String(m.message.content));
          break;
        }
        throw new Error(`No conversation found with session ID: ${params.options.resume}`);
      }
      const init = { type: 'system', subtype: 'init', ...fo.init, session_id: sid } as unknown as SDKMessage;
      yield init;
      let n = 0;
      for await (const m of params.prompt) {
        if (fo.initEachTurn && n > 0) yield init;
        call.prompts.push(String(m.message.content));
        trace.push(`prompt:${String(m.message.content)}`);
        const out = await reply(String(m.message.content), n++);
        if (out === 'die') throw new Error('process exited with code 1');
        if (out === 'hang') {
          await new Promise<void>((r) => (wake = wakeHang = r));
          if (closed) return;
          yield result(sid, 'error_during_execution');
          continue;
        }
        for (const x of out) yield { parent_tool_use_id: null, ...x, session_id: sid } as SDKMessage;
      }
    }
    const it = gen();
    return Object.assign(it, {
      async interrupt() {
        interrupts++;
        if (fo.interruptThrows) throw new Error('the control channel is gone');
        wakeHang?.();
      },
      close() {
        closes++;
        closed = true;
        wakeHang?.();
      },
      async setModel(model?: string) {
        if (fo.switchFails?.(`model:${model}`)) throw new Error('the control channel is gone');
        trace.push(`model:${model}`);
      },
      async applyFlagSettings(settings: { effortLevel?: string }) {
        if (fo.switchFails?.(`effort:${settings.effortLevel}`)) throw new Error('the control channel is gone');
        trace.push(`effort:${settings.effortLevel}`);
      },
    });
  }) as unknown as typeof query;
  /** wake: let a hanging turn produce its result */
  return { impl, calls, trace, interrupts: () => interrupts, closes: () => closes, wake: () => wake?.() };
}

const result = (sid: string, subtype = 'success', extra: Record<string, unknown> = {}) =>
  ({
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    result: '',
    errors: [],
    session_id: sid,
    ...extra,
  }) as never;
const streamText = (id: string, text: string) =>
  [
    { type: 'stream_event', event: { type: 'message_start', message: { id } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { type: 'assistant', message: { id, content: [{ type: 'text', text }] } },
  ] as never[];

const TOOLS: ToolSpec[] = [
  {
    name: 'ha_find',
    description: 'find',
    readOnly: true,
    params: {
      query: { type: 'string', description: 'q' },
      domain: { type: 'string', description: 'd', optional: true },
    },
    run: async () => 'ok',
  },
];

function agent(
  reply: Reply,
  extra: {
    knowledgeDir?: string | null;
    dataDir?: string;
    web?: boolean;
    blockedHosts?: string[];
    log?: (m: string) => void;
    escalation?: Escalation | null;
  } & FakeOpts = {},
) {
  const fq = fakeQuery(reply, extra);
  const dataDir = extra.dataDir ?? mkdtempSync(join(tmpdir(), 'jarvis-sdk-'));
  const a = createSdkAgent({
    tools: TOOLS,
    systemPrompt: 'You are JARVIS.',
    model: 'claude-test',
    effort: 'low',
    dataDir,
    knowledgeDir: extra.knowledgeDir ?? null,
    web: extra.web,
    blockedHosts: extra.blockedHosts,
    escalation: extra.escalation,
    queryImpl: fq.impl,
    log: extra.log ?? (() => {}),
  });
  const turn = async (text: string) => {
    const events: AgentEvent[] = [];
    await a.run(
      text,
      { turnId: 't', clientId: 'c', user: 'u', surface: 'screen', text, viewer: true },
      (e) => events.push(e),
      {
        call: async () => ({ text: 'ok' }),
      },
    );
    return events;
  };
  return { a, fq, dataDir, turn };
}

describe('sdk agent', () => {
  it('starts one streaming session with a locked-down tool set', async () => {
    const { fq, turn } = agent(() => [...streamText('m1', 'Hello there.'), result('session-1')]);
    const events = await turn('hi');
    expect(events).toEqual([{ type: 'text', delta: 'Hello there.' }, { type: 'done' }]); // the full message isn't repeated
    await turn('again');
    expect(fq.calls).toHaveLength(1); // one long-lived process
    const o = fq.calls[0].options;
    expect(o).toMatchObject({
      model: 'claude-test',
      effort: 'low',
      systemPrompt: 'You are JARVIS.',
      settingSources: [],
      tools: ['WebSearch', 'WebFetch'],
      allowedTools: ['mcp__house__ha_find', 'WebSearch', 'WebFetch'],
      permissionMode: 'dontAsk',
      includePartialMessages: true,
      strictMcpConfig: true,
    });
    expect(o.resume).toBeUndefined();
    expect(Object.keys(o.mcpServers!)).toEqual(['house']);
  });

  it("the Claude Code process gets none of the assistant's own settings (the HA token, the STT key, …)", async () => {
    const keep = { ...process.env };
    Object.assign(process.env, { JARVIS_HA_TOKEN: 'ha-secret', JARVIS_STT_KEY: 'stt-secret', JARVIS_X: '1' });
    try {
      const { fq, turn } = agent(() => [result('s')]);
      await turn('hi');
      const env = fq.calls[0].options.env!;
      expect(Object.keys(env).filter((k) => k.startsWith('JARVIS_'))).toEqual([]);
      expect(JSON.stringify(env)).not.toMatch(/ha-secret|stt-secret/);
      expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('jarvis-assistant/0');
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    }
  });

  it('JARVIS_ASSISTANT_WEB=off drops WebSearch/WebFetch; WebFetch never reaches the LAN or Home Assistant', async () => {
    const off = agent(() => [result('s')], { web: false });
    await off.turn('hi');
    expect(off.fq.calls[0].options.tools).toEqual([]);
    const on = agent(() => [result('s')], { blockedHosts: ['ha.example.org'] });
    await on.turn('hi');
    const o = on.fq.calls[0].options;
    const ask = (url: string) => o.canUseTool!('WebFetch', { url }, { signal: new AbortController().signal } as never);
    expect(await ask('https://example.org/manual')).toMatchObject({ behavior: 'allow' });
    for (const url of ['https://ha.example.org/api/', 'http://10.20.30.40:8123/', 'http://homeassistant.local/'])
      expect(await ask(url)).toMatchObject({ behavior: 'deny' });
  });

  it('adds Read/Grep/Glob only with a knowledge folder, and cwd is that folder', async () => {
    const kb = mkdtempSync(join(tmpdir(), 'jarvis-kb-'));
    const { fq, turn } = agent(() => [result('s')], { knowledgeDir: kb });
    await turn('hi');
    expect(fq.calls[0].options.tools).toEqual(['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob']);
    expect(fq.calls[0].options.cwd).toBe(kb);
  });

  it('canUseTool and the PreToolUse hook refuse anything off the list', async () => {
    const { fq, turn } = agent(() => [result('s')]);
    await turn('hi');
    const o = fq.calls[0].options;
    const ask = (name: string, input: Record<string, unknown> = {}) =>
      o.canUseTool!(name, input, { signal: new AbortController().signal } as never);
    expect(await ask('mcp__house__ha_find', { query: 'x' })).toMatchObject({ behavior: 'allow' });
    expect(await ask('Bash', { command: 'rm -rf /' })).toMatchObject({ behavior: 'deny' });
    expect(await ask('Read', { file_path: '/etc/passwd' })).toMatchObject({ behavior: 'deny' });
    expect(await ask('mcp__evil__x')).toMatchObject({ behavior: 'deny' });
    const hook = o.hooks!.PreToolUse![0].hooks[0];
    const h = (tool_name: string) =>
      hook({ hook_event_name: 'PreToolUse', tool_name, tool_input: {} } as never, 'id', {
        signal: new AbortController().signal,
      });
    expect(await h('Write')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await h('WebSearch')).toEqual({});
  });

  it('logs the session, model and credential source once per session; warns, boxed, when an API key beats the OAuth token', async () => {
    const keep = { ...process.env };
    const logged = async (apiKeySource: string, oauth: string | undefined) => {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (oauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = oauth;
      const lines: string[] = [];
      const { a, turn } = agent(() => [result('s')], {
        init: { model: 'claude-test-1', apiKeySource },
        initEachTurn: true,
        log: (m) => lines.push(m),
      });
      await turn('one');
      await turn('two');
      await turn('three');
      await a.reset(); // a new session logs again
      await turn('four');
      return lines;
    };
    try {
      const sub = await logged('none', 'oat-secret-value');
      expect(sub).toEqual([
        'assistant: session session- model=claude-test-1 apiKeySource=none',
        'assistant: session session- model=claude-test-1 apiKeySource=none',
      ]);
      const billed = await logged('ANTHROPIC_API_KEY', 'oat-secret-value');
      expect(billed.filter((l) => l.startsWith('assistant: session'))).toHaveLength(2);
      const boxes = billed.filter((l) => l.includes('BILLED TO AN API KEY, NOT YOUR SUBSCRIPTION'));
      expect(boxes).toHaveLength(2); // with each session's line, not each turn's
      expect(boxes[0]).toMatch(/^!+\n/);
      expect(billed.join('\n')).not.toContain('oat-secret-value');
      expect(await logged('ANTHROPIC_API_KEY', undefined)).toHaveLength(2); // API billing is what was asked for
      expect(await logged('ANTHROPIC_API_KEY', '  ')).toHaveLength(2); // blank: not set
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
      Object.assign(process.env, keep);
    }
  });

  it('saves the session id and resumes it after a restart; reset starts fresh', async () => {
    const first = agent(() => [result('s')]);
    await first.turn('hi');
    expect(JSON.parse(readFileSync(join(first.dataDir, 'session.json'), 'utf8')).sessionId).toBe('session-1');
    const second = agent(() => [result('s')], { dataDir: first.dataDir });
    await second.turn('hi');
    expect(second.fq.calls[0].options.resume).toBe('session-1');
    await second.a.reset();
    expect(second.fq.closes()).toBe(1);
    expect(JSON.parse(readFileSync(join(first.dataDir, 'session.json'), 'utf8'))).toEqual({});
    await second.turn('hi');
    expect(second.fq.calls).toHaveLength(2);
    expect(second.fq.calls[1].options.resume).toBeUndefined();
  });

  it('maps unstreamed text, built-in tool chips and errors', async () => {
    const { turn } = agent((text) => {
      if (text === 'search')
        return [
          {
            type: 'assistant',
            message: {
              id: 'a1',
              content: [{ type: 'tool_use', id: 'tu1', name: 'WebSearch', input: { query: 'tides' } }],
            },
          },
          {
            type: 'assistant',
            message: { id: 'a0', content: [{ type: 'tool_use', id: 'tu0', name: 'mcp__house__ha_find', input: {} }] },
          },
          {
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }] },
          },
          { type: 'assistant', message: { id: 'a2', content: [{ type: 'text', text: 'High tide at six.' }] } },
          result('s'),
        ] as never[];
      if (text === 'limit')
        return [result('s', 'success', { is_error: true, result: 'Claude AI usage limit reached' })];
      return [result('s', 'error_max_turns', { errors: ['too many turns'] })];
    });
    expect(await turn('search')).toEqual([
      { type: 'tool', callId: 'tu1', name: 'WebSearch', summary: 'Searching the web for tides', status: 'running' },
      { type: 'tool', callId: 'tu1', name: 'WebSearch', summary: 'WebSearch', status: 'done' },
      { type: 'text', delta: 'High tide at six.' },
      { type: 'done' },
    ]);
    expect((await turn('limit')).at(-1)).toEqual({ type: 'done', error: 'usage limit: Claude AI usage limit reached' });
    expect((await turn('other')).at(-1)).toEqual({ type: 'done', error: 'too many turns' });
  });

  it('a session that cannot be resumed is forgotten and the turn retried in a new one, once', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-sdk-'));
    writeFileSync(join(dataDir, 'session.json'), JSON.stringify({ sessionId: 'gone' }));
    const { fq, turn } = agent(() => [...streamText('m1', 'Hello.'), result('s')], { dataDir, badResume: true });
    expect(await turn('hi')).toEqual([{ type: 'text', delta: 'Hello.' }, { type: 'done' }]);
    expect(fq.calls.map((c) => c.options.resume)).toEqual(['gone', undefined]);
    expect(fq.calls[1].prompts).toEqual(['hi']); // the same prompt, again
    expect(JSON.parse(readFileSync(join(dataDir, 'session.json'), 'utf8')).sessionId).toBe('session-2');
    expect((await turn('again')).at(-1)).toEqual({ type: 'done' });
    expect(fq.calls).toHaveLength(2);
  });

  it('if the fresh session fails too, the turn reports it, and the dead session id is gone', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'jarvis-sdk-'));
    writeFileSync(join(dataDir, 'session.json'), JSON.stringify({ sessionId: 'gone' }));
    const { fq, turn } = agent(() => 'die', { dataDir, badResume: true });
    expect((await turn('hi')).at(-1)).toEqual({
      type: 'done',
      error: 'the assistant failed: process exited with code 1',
    });
    expect(fq.calls.map((c) => c.options.resume)).toEqual(['gone', undefined]);
    expect(JSON.parse(readFileSync(join(dataDir, 'session.json'), 'utf8')).sessionId).toBe('session-2');
  });

  it('an interrupt that throws keeps waiting for the turn’s result', async () => {
    const { a, fq, turn } = agent(() => 'hang', { interruptThrows: true });
    let done = false;
    const p = turn('long question').then((e) => ((done = true), e));
    await new Promise((r) => setTimeout(r, 20));
    await a.interrupt();
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    fq.wake(); // the process gets to it after all
    expect(await p).toEqual([{ type: 'done', interrupted: true }]);
  });

  it('interrupt ends the turn as interrupted', async () => {
    const { a, fq, turn } = agent(() => 'hang');
    const p = turn('long question');
    await new Promise((r) => setTimeout(r, 20));
    await a.interrupt();
    expect(await p).toEqual([{ type: 'done', interrupted: true }]);
    expect(fq.interrupts()).toBe(1);
  });

  it('a crashed process fails the turn; the next turn starts a new one, resuming', async () => {
    let n = 0;
    const { fq, turn } = agent(() => (n++ === 0 ? 'die' : [result('s')]));
    expect(await turn('one')).toEqual([{ type: 'done', error: 'the assistant failed: process exited with code 1' }]);
    expect(await turn('two')).toEqual([{ type: 'done' }]);
    expect(fq.calls).toHaveLength(2);
    expect(fq.calls[1].options.resume).toBe('session-1');
  });
});

const OPUS: Escalation = { model: 'claude-opus-5-5', effort: 'high' };

describe('sdk agent: models and escalation', () => {
  it('starts on the default model and effort, and never turns thinking off (Opus 5.5 cannot run without it)', async () => {
    const { fq, turn } = agent(() => [result('s')], { escalation: OPUS });
    await turn('hi');
    const o = fq.calls[0].options;
    expect(o).toMatchObject({ model: 'claude-test', effort: 'low' });
    expect(o.thinking).toBeUndefined();
    expect(o.maxThinkingTokens).toBeUndefined();
    const { mcpServers: _m, ...plain } = o;
    expect(JSON.stringify(plain)).not.toMatch(
      /"thinking":\{"type":"disabled"\}|alwaysThinkingEnabled|maxThinkingTokens/,
    );
    expect(fq.trace).toEqual(['prompt:hi']); // no switches on an ordinary turn
  });

  it('an explicit ask switches before the prompt goes in, shows a chip, logs once, and switches back after', async () => {
    const lines: string[] = [];
    const { fq, turn } = agent(() => [...streamText('m1', 'Here goes.'), result('s')], {
      escalation: OPUS,
      log: (m) => void (m.startsWith('assistant: session') || lines.push(m)),
    });
    const events = await turn('Think hard: how big a pressure tank?');
    expect(fq.trace).toEqual([
      'model:claude-opus-5-5',
      'effort:high',
      'prompt:Think hard: how big a pressure tank?',
      'model:claude-test',
      'effort:low',
    ]);
    expect(events).toEqual([
      {
        type: 'tool',
        callId: 'escalate-1',
        name: 'think_harder',
        summary: 'Thinking harder (claude-opus-5-5)',
        status: 'done',
      },
      { type: 'text', delta: 'Here goes.' },
      { type: 'done' },
    ]);
    expect(lines).toEqual(['assistant: escalated to claude-opus-5-5 (high): explicit ask']);
    await turn('and the hall light?');
    expect(fq.trace.slice(5)).toEqual(['prompt:and the hall light?']);
  });

  it('think_harder mid-turn switches for the rest of the turn (once), then back', async () => {
    const lines: string[] = [];
    const answers: unknown[] = [];
    const box: { a?: ReturnType<typeof agent>['a'] } = {};
    const rig = agent(
      async (text) => {
        if (text === 'why does the AC lock out?') {
          answers.push(await box.a!.escalate!());
          answers.push(await box.a!.escalate!()); // a second call in the same turn
        }
        return [result('s')];
      },
      { escalation: OPUS, log: (m) => void (m.startsWith('assistant: session') || lines.push(m)) },
    );
    box.a = rig.a;
    await rig.turn('why does the AC lock out?');
    expect(rig.fq.trace).toEqual([
      'prompt:why does the AC lock out?',
      'model:claude-opus-5-5',
      'effort:high',
      'model:claude-test',
      'effort:low',
    ]);
    expect(answers).toEqual([
      {
        ok: true,
        detail: 'switched to claude-opus-5-5 at high effort for the rest of this turn',
        model: 'claude-opus-5-5',
      },
      { ok: true, detail: 'already on claude-opus-5-5 (high effort) for this turn', model: 'claude-opus-5-5' },
    ]);
    expect(lines).toEqual(['assistant: escalated to claude-opus-5-5 (high): think_harder']);
    // the next turn may escalate again
    await rig.turn('why does the AC lock out?');
    expect(rig.fq.trace.slice(5)).toEqual([
      'prompt:why does the AC lock out?',
      'model:claude-opus-5-5',
      'effort:high',
      'model:claude-test',
      'effort:low',
    ]);
  });

  it('escalation off: think_harder says so, an explicit ask runs as usual, nothing switches', async () => {
    const answers: unknown[] = [];
    const box: { a?: ReturnType<typeof agent>['a'] } = {};
    const rig = agent(
      async () => {
        answers.push(await box.a!.escalate!());
        return [result('s')];
      },
      { escalation: null },
    );
    box.a = rig.a;
    const events = await rig.turn('think hard about it');
    expect(events).toEqual([{ type: 'done' }]);
    expect(answers).toEqual([{ ok: false, detail: 'escalation is off here; answer with the current model' }]);
    expect(rig.fq.trace).toEqual(['prompt:think hard about it']);
    expect(await rig.a.escalate!()).toEqual({
      ok: false,
      detail: 'escalation is off here; answer with the current model',
    });
  });

  it('a failed escalation is reported and the turn carries on; the half-done switch is still undone', async () => {
    const lines: string[] = [];
    const { fq, turn } = agent(() => [result('s')], {
      escalation: OPUS,
      switchFails: (w) => w === 'effort:high',
      log: (m) => void (m.startsWith('assistant: session') || lines.push(m)),
    });
    expect(await turn('take your time')).toEqual([{ type: 'done' }]); // no chip
    expect(fq.trace).toEqual(['model:claude-opus-5-5', 'prompt:take your time', 'model:claude-test', 'effort:low']);
    expect(lines).toEqual(['assistant: cannot escalate to claude-opus-5-5: the control channel is gone']);
  });

  it('switching back fails: logged, and the next turn restarts the process (resuming the session) at the defaults', async () => {
    const lines: string[] = [];
    let failBack = true;
    const { fq, turn } = agent(() => [result('s')], {
      escalation: OPUS,
      switchFails: (w) => failBack && w === 'model:claude-test',
      log: (m) => void (m.startsWith('assistant: session') || lines.push(m)),
    });
    await turn('use opus for this');
    expect(fq.calls).toHaveLength(1);
    expect(lines).toContain(
      'assistant: cannot switch back to claude-test (the control channel is gone); the next turn restarts the session',
    );
    failBack = false;
    expect(await turn('and now?')).toEqual([{ type: 'done' }]);
    expect(fq.closes()).toBe(1);
    expect(fq.calls).toHaveLength(2);
    expect(fq.calls[1].options).toMatchObject({ model: 'claude-test', effort: 'low', resume: 'session-1' });
    expect(fq.calls[1].prompts).toEqual(['and now?']);
    expect(lines).toContain('assistant: restarting the session on claude-test (low)');
    // and only once
    await turn('again');
    expect(fq.calls).toHaveLength(2);
  });

  it('a turn that ends by reset or a crash leaves no escalation behind', async () => {
    let n = 0;
    const { a, fq, turn } = agent(() => (n++ === 0 ? 'die' : [result('s')]), { escalation: OPUS });
    expect((await turn('think it through')).at(-1)).toMatchObject({ type: 'done', error: expect.any(String) });
    expect(fq.trace).toEqual(['model:claude-opus-5-5', 'effort:high', 'prompt:think it through']); // nothing to revert
    await turn('next');
    expect(fq.calls[1].options).toMatchObject({ model: 'claude-test', effort: 'low' });
    expect(fq.trace.slice(3)).toEqual(['prompt:next']);
    await a.reset();
    expect(await a.escalate!()).toEqual({ ok: false, detail: 'no turn is running' });
  });
});

describe('zodShape', () => {
  it('turns ParamSpecs into zod', () => {
    const s = z.object(
      zodShape({
        q: { type: 'string', description: 'q' },
        e: { type: 'string', description: 'e', enum: ['a', 'b'], optional: true },
        n: { type: 'number', description: 'n', min: 1, max: 5, optional: true },
        b: { type: 'boolean', description: 'b', optional: true },
        l: { type: 'string[]', description: 'l', optional: true },
        o: { type: 'object', description: 'o', optional: true },
      }),
    );
    expect(s.parse({ q: 'x', e: 'a', n: 3, b: true, l: ['a'], o: { k: 1 } })).toBeTruthy();
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ q: 'x', n: 9 }).success).toBe(false);
    expect(s.safeParse({ q: 'x', e: 'c' }).success).toBe(false);
  });
});
