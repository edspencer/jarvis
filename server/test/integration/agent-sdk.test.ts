// The SDK agent against a fake query(): the options it starts the session with (tools, permissions, guard, resume),
// and how it maps the SDK's messages to the hub's events. No model is called.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage, SDKUserMessage, query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createSdkAgent, zodShape } from '../../src/agent-sdk.ts';
import type { AgentEvent, ToolSpec } from '../../src/core/types.ts';

type Reply = (text: string, n: number) => SDKMessage[] | 'die' | 'hang';

/** a fake query(): answers each pushed user message with the messages `reply` gives */
function fakeQuery(reply: Reply) {
  const calls: { options: Options }[] = [];
  let interrupts = 0;
  let closes = 0;
  const impl = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    calls.push({ options: params.options });
    const sid = `session-${calls.length}`;
    let wakeHang: (() => void) | null = null;
    let closed = false;
    async function* gen(): AsyncGenerator<SDKMessage> {
      yield { type: 'system', subtype: 'init', session_id: sid } as unknown as SDKMessage;
      let n = 0;
      for await (const m of params.prompt) {
        const out = reply(String(m.message.content), n++);
        if (out === 'die') throw new Error('process exited with code 1');
        if (out === 'hang') {
          await new Promise<void>((r) => (wakeHang = r));
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
        wakeHang?.();
      },
      close() {
        closes++;
        closed = true;
        wakeHang?.();
      },
    });
  }) as unknown as typeof query;
  return { impl, calls, interrupts: () => interrupts, closes: () => closes };
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

function agent(reply: Reply, extra: { knowledgeDir?: string | null; dataDir?: string } = {}) {
  const fq = fakeQuery(reply);
  const dataDir = extra.dataDir ?? mkdtempSync(join(tmpdir(), 'jarvis-sdk-'));
  const a = createSdkAgent({
    tools: TOOLS,
    systemPrompt: 'You are JARVIS.',
    model: 'claude-test',
    effort: 'low',
    dataDir,
    knowledgeDir: extra.knowledgeDir ?? null,
    queryImpl: fq.impl,
    log: () => {},
  });
  const turn = async (text: string) => {
    const events: AgentEvent[] = [];
    await a.run(text, { turnId: 't', clientId: 'c', surface: 'screen', text, viewer: true }, (e) => events.push(e), {
      call: async () => ({ text: 'ok' }),
    });
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
    });
    expect(o.resume).toBeUndefined();
    expect(Object.keys(o.mcpServers!)).toEqual(['house']);
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
