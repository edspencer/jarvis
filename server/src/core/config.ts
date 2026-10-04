// The assistant's configuration: environment variables, optionally under a JSON file (JARVIS_ASSISTANT_CONFIG) whose
// keys are the same variable names, so there is one vocabulary. The environment wins over the file. Everything is
// validated here, once, so the rest of the server can trust it; nothing is hard-coded beyond these defaults.
// See server/README.md and docs/assistant.md for the table.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type AgentKind = 'sdk' | 'scripted';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SttConfig {
  /** OpenAI-compatible base, e.g. http://speaches:8000/v1 (we POST {url}/audio/transcriptions) */
  url: string;
  model?: string;
  key?: string;
  language?: string;
}

export interface AssistantConfig {
  host: string;
  port: number;
  /** URL prefix, no trailing slash: '/assistant' */
  base: string;
  /** allowed WebSocket Origins; empty: same host as the request only */
  origins: string[];
  siteDir: string;
  policyPath: string;
  /** JARVIS_ASSISTANT_POLICY was set (a missing file is then an error, not the deny-everything default) */
  policyExplicit: boolean;
  /** session.json, memory/, audit.jsonl */
  dataDir: string;
  /** a read-only folder of manuals and notes for Read/Grep/Glob; null: those tools are off */
  knowledgeDir: string | null;
  agent: AgentKind;
  model: string;
  effort: Effort;
  ha: { mode: 'mock' | 'live'; url?: string; token?: string };
  /** null: transcription is off (POST /transcribe answers 503) */
  stt: SttConfig | null;
}

// TODO(open question 1: model default for voice): a fast model at low effort with on-demand escalation, or a stronger
// model always? Until that's settled the default is the strong model at low effort.
export const DEFAULT_MODEL = 'claude-opus-5';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** every variable the server reads (the JSON file may only carry these) */
export const CONFIG_KEYS = [
  'JARVIS_ASSISTANT_HOST',
  'JARVIS_ASSISTANT_PORT',
  'JARVIS_ASSISTANT_BASE',
  'JARVIS_ASSISTANT_ORIGINS',
  'JARVIS_SITE_DIR',
  'JARVIS_ASSISTANT_POLICY',
  'JARVIS_ASSISTANT_DATA',
  'JARVIS_ASSISTANT_KNOWLEDGE',
  'JARVIS_ASSISTANT_AGENT',
  'JARVIS_ASSISTANT_MODEL',
  'JARVIS_ASSISTANT_EFFORT',
  'JARVIS_HA_MODE',
  'JARVIS_HA_URL',
  'JARVIS_HA_TOKEN',
  'JARVIS_STT_URL',
  'JARVIS_STT_MODEL',
  'JARVIS_STT_KEY',
  'JARVIS_STT_LANGUAGE',
] as const;

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid assistant configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

/** the JSON file's values under the environment's (only known keys; values become strings) */
function mergeFile(env: Env, cwd: string, problems: string[]): Env {
  const file = env.JARVIS_ASSISTANT_CONFIG?.trim();
  if (!file) return env;
  const path = resolve(cwd, file);
  let obj: unknown;
  try {
    obj = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    problems.push(`JARVIS_ASSISTANT_CONFIG: cannot read ${path}: ${(e as Error).message}`);
    return env;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    problems.push(`JARVIS_ASSISTANT_CONFIG: ${path} must hold a JSON object`);
    return env;
  }
  const out: Env = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(k)) {
      problems.push(`JARVIS_ASSISTANT_CONFIG: unknown key ${k}`);
      continue;
    }
    if (v === null || v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  return { ...out, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== '')) };
}

const get = (env: Env, k: string): string | undefined => {
  const v = env[k]?.trim();
  return v ? v : undefined;
};

/** Read and validate the configuration; throws ConfigError listing every problem at once. */
export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): AssistantConfig {
  const problems: string[] = [];
  const e = mergeFile(env, cwd, problems);
  const path = (k: string, dflt: string) => resolve(cwd, get(e, k) ?? dflt);

  const host = get(e, 'JARVIS_ASSISTANT_HOST') ?? '127.0.0.1';

  const portRaw = get(e, 'JARVIS_ASSISTANT_PORT') ?? '8787';
  const port = Number(portRaw);
  if (!/^\d+$/.test(portRaw) || port > 65535) problems.push(`JARVIS_ASSISTANT_PORT: not a port: ${portRaw}`);

  let base = get(e, 'JARVIS_ASSISTANT_BASE') ?? '/assistant';
  base = base.replace(/\/+$/, '');
  if (base && !/^\/[A-Za-z0-9._~/-]*$/.test(base)) problems.push(`JARVIS_ASSISTANT_BASE: not a URL path: ${base}`);

  const origins: string[] = [];
  for (const o of (get(e, 'JARVIS_ASSISTANT_ORIGINS') ?? '').split(',').map((s) => s.trim())) {
    if (!o) continue;
    let u: URL | null = null;
    try {
      u = new URL(o);
    } catch {}
    if (!u || !/^https?:$/.test(u.protocol) || u.origin !== o.replace(/\/$/, ''))
      problems.push(`JARVIS_ASSISTANT_ORIGINS: not an origin (scheme://host[:port]): ${o}`);
    else origins.push(u.origin);
  }

  const siteDir = path('JARVIS_SITE_DIR', 'examples/demo-site');
  if (!existsSync(join(siteDir, 'site.json'))) problems.push(`JARVIS_SITE_DIR: no site.json in ${siteDir}`);

  const policyExplicit = !!get(e, 'JARVIS_ASSISTANT_POLICY');
  const policyPath = policyExplicit ? path('JARVIS_ASSISTANT_POLICY', '') : join(siteDir, 'assistant-policy.yaml');
  if (policyExplicit && !existsSync(policyPath)) problems.push(`JARVIS_ASSISTANT_POLICY: no such file: ${policyPath}`);

  const dataDir = path('JARVIS_ASSISTANT_DATA', 'data');

  const k = get(e, 'JARVIS_ASSISTANT_KNOWLEDGE');
  const knowledgeDir = k ? (isAbsolute(k) ? k : resolve(cwd, k)) : null;
  if (knowledgeDir && !existsSync(knowledgeDir)) problems.push(`JARVIS_ASSISTANT_KNOWLEDGE: no such folder: ${k}`);

  const agent = (get(e, 'JARVIS_ASSISTANT_AGENT') ?? 'sdk') as AgentKind;
  if (agent !== 'sdk' && agent !== 'scripted') problems.push(`JARVIS_ASSISTANT_AGENT: sdk or scripted, not ${agent}`);

  const model = get(e, 'JARVIS_ASSISTANT_MODEL') ?? DEFAULT_MODEL;

  const effort = (get(e, 'JARVIS_ASSISTANT_EFFORT') ?? 'low') as Effort;
  if (!EFFORTS.includes(effort)) problems.push(`JARVIS_ASSISTANT_EFFORT: one of ${EFFORTS.join(', ')}, not ${effort}`);

  const mode = (get(e, 'JARVIS_HA_MODE') ?? 'mock') as 'mock' | 'live';
  const haUrl = get(e, 'JARVIS_HA_URL');
  const haToken = get(e, 'JARVIS_HA_TOKEN');
  if (mode !== 'mock' && mode !== 'live') problems.push(`JARVIS_HA_MODE: mock or live, not ${mode}`);
  if (mode === 'live') {
    if (!haUrl) problems.push('JARVIS_HA_MODE=live needs JARVIS_HA_URL');
    else if (!/^https?:\/\//.test(haUrl)) problems.push(`JARVIS_HA_URL: not an http(s) URL: ${haUrl}`);
    if (!haToken)
      problems.push('JARVIS_HA_MODE=live needs JARVIS_HA_TOKEN (a long-lived token of a non-admin HA user)');
  }

  const sttUrl = get(e, 'JARVIS_STT_URL');
  if (sttUrl && !/^https?:\/\//.test(sttUrl)) problems.push(`JARVIS_STT_URL: not an http(s) URL: ${sttUrl}`);
  const stt: SttConfig | null = sttUrl
    ? {
        url: sttUrl.replace(/\/+$/, ''),
        model: get(e, 'JARVIS_STT_MODEL'),
        key: get(e, 'JARVIS_STT_KEY'),
        language: get(e, 'JARVIS_STT_LANGUAGE'),
      }
    : null;

  if (problems.length) throw new ConfigError(problems);
  return {
    host,
    port,
    base,
    origins,
    siteDir,
    policyPath,
    policyExplicit,
    dataDir,
    knowledgeDir,
    agent,
    model,
    effort,
    ha: { mode, url: haUrl, token: haToken },
    stt,
  };
}

// ------------------------------------------------------------------------------------------------ model credentials

export interface AuthCheck {
  /** error: the sdk agent cannot start; warn: it starts, but not the way the person probably wants */
  level: 'ok' | 'info' | 'warn' | 'error';
  /** which credential the Claude Code process will use */
  uses: 'api-key' | 'auth-token' | 'subscription' | 'none';
  lines: string[];
}

/**
 * Which model credential wins, and what to say about it (design §4). ANTHROPIC_API_KEY is the project default.
 * CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) is for a person's own Pro/Max plan and personal use only; when
 * an API key or ANTHROPIC_AUTH_TOKEN is set too, it silently loses and usage is billed to the API.
 * `loginCredentials`: a `claude login` credentials file exists ($CLAUDE_CONFIG_DIR or ~/.claude/.credentials.json;
 * see loginCredentialsFile), which the bundled Claude Code also uses: personal use too.
 */
export function authWarnings(env: Env, agent: AgentKind = 'sdk', loginCredentials = false): AuthCheck {
  const has = (k: string) => !!env[k]?.trim();
  const apiKey = has('ANTHROPIC_API_KEY');
  const authToken = has('ANTHROPIC_AUTH_TOKEN');
  const oauth = has('CLAUDE_CODE_OAUTH_TOKEN');
  if (agent === 'scripted') return { level: 'ok', uses: 'none', lines: [] };
  if (oauth && (apiKey || authToken)) {
    const winner = apiKey ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
    return {
      level: 'warn',
      uses: apiKey ? 'api-key' : 'auth-token',
      lines: [
        `Both CLAUDE_CODE_OAUTH_TOKEN and ${winner} are set.`,
        `${winner} silently wins: every turn is billed to the API,`,
        'not to your Claude subscription.',
        'Unset one of them: the API key for API billing (the default),',
        'or the other for your own Pro/Max plan (personal use only).',
      ],
    };
  }
  if (apiKey) return { level: 'ok', uses: 'api-key', lines: [] };
  if (authToken) return { level: 'ok', uses: 'auth-token', lines: [] };
  if (oauth)
    return {
      level: 'info',
      uses: 'subscription',
      lines: [
        'Using CLAUDE_CODE_OAUTH_TOKEN: your own Claude plan, for your personal use only (see docs/assistant.md and Anthropic’s terms).',
      ],
    };
  if (loginCredentials)
    return {
      level: 'info',
      uses: 'subscription',
      lines: [
        'Using the `claude login` credentials: your own Claude plan, for your personal use only (see docs/assistant.md and Anthropic’s terms).',
      ],
    };
  return {
    level: 'error',
    uses: 'none',
    lines: [
      'No model credential: set ANTHROPIC_API_KEY (API billing, the default),',
      'or, for personal use on your own Pro/Max plan, CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`.',
      'To run without a model, set JARVIS_ASSISTANT_AGENT=scripted.',
    ],
  };
}

/** where Claude Code keeps `claude login` credentials */
export function loginCredentialsFile(env: Env): string {
  return join(env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), '.claude'), '.credentials.json');
}

/** a box around lines, for warnings that must not scroll past unnoticed */
export function boxed(title: string, lines: string[]): string {
  const all = [title, '', ...lines];
  const w = Math.max(...all.map((l) => l.length));
  const bar = '!'.repeat(w + 4);
  return [bar, ...all.map((l) => `! ${l.padEnd(w)} !`), bar].join('\n');
}
