// The real agent: one Claude Agent SDK session in streaming-input mode (one long-lived Claude Code process, so a turn
// doesn't pay start-up), resumed from <data>/session.json after a restart (design §3). The house tools are an
// in-process MCP server; the built-ins are only WebSearch/WebFetch and, with a knowledge folder, Read/Grep/Glob.
// Every tool call also passes core/guard.ts twice (canUseTool and a PreToolUse hook), so a misconfiguration can't
// open Bash, Write or a path outside the knowledge folder. Turns are serialised by the hub, so the house tools run
// against the current turn's ToolRunner.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type HookCallback,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { checkToolUse } from './core/guard.ts';
import type { Effort } from './core/config.ts';
import type { Agent, AgentEvent, ParamSpec, ToolRunner, ToolSpec, TurnInfo } from './core/types.ts';

export interface SdkAgentOptions {
  tools: ToolSpec[];
  systemPrompt: string;
  model: string;
  effort: Effort;
  /** session.json lives here; also the empty working folder when there is no knowledge folder */
  dataDir: string;
  knowledgeDir: string | null;
  /** WebSearch / WebFetch (default true; JARVIS_ASSISTANT_WEB) */
  web?: boolean;
  /** hosts WebFetch must never reach besides private addresses (Home Assistant's) */
  blockedHosts?: string[];
  log?: (msg: string) => void;
  /** tests: a fake query() */
  queryImpl?: typeof query;
}

const SERVER = 'house';
export const houseToolName = (name: string) => `mcp__${SERVER}__${name}`;

/** ParamSpec → zod (core stays dependency-free; the SDK wants zod shapes) */
export function zodShape(params: Record<string, ParamSpec>): Record<string, z.ZodType> {
  const out: Record<string, z.ZodType> = {};
  for (const [k, p] of Object.entries(params)) {
    let t: z.ZodType;
    if (p.type === 'string') t = p.enum?.length ? z.enum(p.enum as [string, ...string[]]) : z.string();
    else if (p.type === 'number') {
      let n = z.number();
      if (p.min !== undefined) n = n.min(p.min);
      if (p.max !== undefined) n = n.max(p.max);
      t = n;
    } else if (p.type === 'boolean') t = z.boolean();
    else if (p.type === 'string[]') t = z.array(z.string());
    else t = z.record(z.string(), z.unknown());
    t = t.describe(p.description);
    out[k] = p.optional ? t.optional() : t;
  }
  return out;
}

/** a one-line chip for a built-in tool call */
function builtinSummary(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => String(input[k] ?? '').slice(0, 80);
  switch (name) {
    case 'WebSearch':
      return `Searching the web for ${s('query')}`;
    case 'WebFetch':
      return `Reading ${s('url').replace(/^https?:\/\//, '')}`;
    case 'Read':
      return `Reading ${s('file_path').split('/').pop()}`;
    case 'Grep':
      return `Searching the notes for ${s('pattern')}`;
    case 'Glob':
      return `Listing ${s('pattern')}`;
    default:
      return name;
  }
}

/** a push-driven async iterable: the streaming-input prompt */
function inputQueue() {
  const items: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  return {
    push(m: SDKUserMessage) {
      items.push(m);
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      while (true) {
        while (items.length) yield items.shift()!;
        if (done) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
  };
}

interface TurnState {
  emit: (e: AgentEvent) => void;
  resolve: () => void;
  /** ids of streamed assistant messages (their text already went out as deltas) */
  streamed: Set<string>;
  /** built-in tool calls waiting for their result */
  builtins: Map<string, string>;
  interrupted: boolean;
  /** the prompt, for the one retry after a session that couldn't be resumed */
  prompt: string;
  /** that retry happened */
  retried: boolean;
}

/** the environment for the Claude Code process: ours, minus our own settings (the HA token, the STT key, …) */
export function childEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('JARVIS_')) out[k] = v;
  return { ...out, CLAUDE_AGENT_SDK_CLIENT_APP: 'jarvis-assistant/0' };
}

const userMsg = (content: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content },
  parent_tool_use_id: null,
});

export function createSdkAgent(o: SdkAgentOptions): Agent {
  const log = o.log ?? ((m: string) => console.error(m));
  const run = o.queryImpl ?? query;
  const sessionFile = join(o.dataDir, 'session.json');
  const cwd = o.knowledgeDir ?? join(o.dataDir, 'workdir');
  mkdirSync(cwd, { recursive: true });

  const web = o.web !== false;
  const builtins = [...(web ? ['WebSearch', 'WebFetch'] : []), ...(o.knowledgeDir ? ['Read', 'Grep', 'Glob'] : [])];
  const houseTools = new Set(o.tools.map((t) => houseToolName(t.name)));
  const guardOpts = { houseTools, knowledgeDir: o.knowledgeDir, web, blockedHosts: o.blockedHosts ?? [] };

  let runner: ToolRunner | null = null;
  let turn: TurnState | null = null;
  let q: Query | null = null;
  let input: ReturnType<typeof inputQueue> | null = null;
  let fresh = false; // reset(): don't resume

  const loadSession = (): string | undefined => {
    if (fresh) return undefined;
    try {
      const s = JSON.parse(readFileSync(sessionFile, 'utf8')) as { sessionId?: unknown };
      return typeof s.sessionId === 'string' ? s.sessionId : undefined;
    } catch {
      return undefined;
    }
  };
  const saveSession = (sessionId: string) => {
    try {
      mkdirSync(o.dataDir, { recursive: true });
      writeFileSync(sessionFile, JSON.stringify({ sessionId, savedAt: new Date().toISOString() }) + '\n');
    } catch (e) {
      log(`assistant: cannot save ${sessionFile}: ${(e as Error).message}`);
    }
  };

  const mcp = createSdkMcpServer({
    name: SERVER,
    version: '1.0.0',
    tools: o.tools.map((spec) =>
      tool(
        spec.name,
        spec.description,
        zodShape(spec.params),
        async (args) => {
          if (!runner) return { content: [{ type: 'text', text: 'no turn is running' }], isError: true };
          const r = await runner.call(spec.name, args as Record<string, unknown>);
          return { content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) };
        },
        { annotations: { readOnlyHint: !!spec.readOnly } },
      ),
    ),
  });

  const canUseTool: CanUseTool = async (name, toolInput) => {
    const g = checkToolUse(name, toolInput, guardOpts);
    return g.allow ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: g.reason };
  };
  const preToolUse: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    const g = checkToolUse(hookInput.tool_name, (hookInput.tool_input ?? {}) as Record<string, unknown>, guardOpts);
    return g.allow
      ? {}
      : {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: g.reason,
          },
        };
  };

  const clearSession = () => {
    try {
      writeFileSync(sessionFile, '{}\n');
    } catch {}
  };

  function start() {
    input = inputQueue();
    const resume = loadSession();
    fresh = false;
    const options: Options = {
      model: o.model,
      effort: o.effort,
      systemPrompt: o.systemPrompt,
      settingSources: [],
      tools: builtins,
      mcpServers: { [SERVER]: mcp },
      strictMcpConfig: true,
      allowedTools: [...houseTools, ...builtins],
      permissionMode: 'dontAsk',
      canUseTool,
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      // TODO(design §9): a PreCompact hook that writes a summary to memory/house, and the daily soft reset.
      includePartialMessages: true,
      cwd,
      ...(resume ? { resume } : {}),
      env: childEnv(process.env),
      stderr: (d) => log(`claude: ${d.trimEnd()}`),
    };
    const thisQ = run({ prompt: input, options });
    q = thisQ;
    let started = false; // its init message came
    void (async () => {
      let failure: string;
      try {
        for await (const m of thisQ) {
          if (q !== thisQ) continue;
          if (m.type === 'system' && m.subtype === 'init') started = true;
          handle(m);
        }
        failure = 'the assistant process ended';
      } catch (e) {
        failure = `the assistant failed: ${(e as Error).message}`;
      }
      if (q !== thisQ) return; // closed by reset() or close()
      q = null;
      input = null;
      if (resume && !started) {
        // the saved session can't be resumed (gone, or from another machine): forget it, so no later turn tries again
        log(`assistant: cannot resume session ${resume} (${failure}); starting a new one`);
        clearSession();
        fresh = true;
        const t = turn;
        if (t && !t.retried && !t.interrupted) {
          t.retried = true;
          start();
          input!.push(userMsg(t.prompt));
          return;
        }
      } else log(`assistant: ${failure}`);
      endTurn({ error: failure });
    })();
  }

  function endTurn(d: { error?: string; interrupted?: boolean }) {
    const t = turn;
    if (!t) return;
    turn = null;
    for (const [id, name] of t.builtins) t.emit({ type: 'tool', callId: id, name, summary: name, status: 'error' });
    t.emit({ type: 'done', ...(t.interrupted ? { interrupted: true } : d) });
    t.resolve();
  }

  function handle(m: SDKMessage) {
    if (m.type === 'system' && m.subtype === 'init') {
      saveSession(m.session_id);
      return;
    }
    const t = turn;
    if (!t) return;
    if (m.type === 'stream_event') {
      if (m.parent_tool_use_id) return;
      const ev = m.event;
      if (ev.type === 'message_start') t.streamed.add(ev.message.id);
      else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta')
        t.emit({ type: 'text', delta: ev.delta.text });
      return;
    }
    if (m.type === 'assistant') {
      if (m.parent_tool_use_id) return;
      const streamed = t.streamed.has(m.message.id);
      for (const b of m.message.content) {
        if (b.type === 'text' && !streamed && b.text) t.emit({ type: 'text', delta: b.text });
        if (b.type === 'tool_use' && !b.name.startsWith('mcp__')) {
          t.builtins.set(b.id, b.name);
          t.emit({
            type: 'tool',
            callId: b.id,
            name: b.name,
            summary: builtinSummary(b.name, (b.input ?? {}) as Record<string, unknown>),
            status: 'running',
          });
        }
      }
      return;
    }
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (typeof b !== 'object' || b.type !== 'tool_result') continue;
        const name = t.builtins.get(b.tool_use_id);
        if (!name) continue;
        t.builtins.delete(b.tool_use_id);
        t.emit({ type: 'tool', callId: b.tool_use_id, name, summary: name, status: b.is_error ? 'error' : 'done' });
      }
      return;
    }
    if (m.type === 'result') {
      saveSession(m.session_id);
      if (m.subtype === 'success' && !m.is_error) endTurn({});
      else if (m.subtype === 'success')
        endTurn({ error: /limit/i.test(m.result) ? `usage limit: ${m.result}` : m.result || 'the model failed' });
      else endTurn({ error: m.errors?.join('; ') || m.subtype });
    }
  }

  return {
    name: o.model,

    run(prompt: string, _turn: TurnInfo, emit: (e: AgentEvent) => void, tools: ToolRunner) {
      return new Promise<void>((resolve) => {
        runner = tools;
        turn = {
          emit,
          resolve: () => {
            runner = null;
            resolve();
          },
          streamed: new Set(),
          builtins: new Map(),
          interrupted: false,
          prompt,
          retried: false,
        };
        if (!q) start();
        input!.push(userMsg(prompt));
      });
    },

    async interrupt() {
      if (!turn || !q) return;
      turn.interrupted = true;
      try {
        await q.interrupt();
      } catch (e) {
        // the turn still ends with its `result` (or the process ending); the hub's turn timeout bounds the wait
        log(`assistant: interrupt failed: ${(e as Error).message}`);
      }
    },

    async reset() {
      endTurn({ interrupted: true });
      const old = q;
      q = null;
      input?.end();
      input = null;
      old?.close();
      fresh = true; // the next turn starts a new session (and a restart before it doesn't resume the old one)
      clearSession();
    },

    async close() {
      endTurn({ error: 'the assistant is shutting down' });
      input?.end();
      q?.close();
      q = null;
    },
  };
}
