// Configuration from the environment (and the optional JSON file), and the model-credential warnings.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  authWarnings,
  boxed,
  ConfigError,
  DEFAULT_MODEL,
  loadConfig,
  loginCredentialsFile,
} from '../src/core/config.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const DEMO = join(ROOT, 'examples/demo-site');

describe('loadConfig', () => {
  it('has safe defaults: loopback, mock HA, the demo site, transcription off', () => {
    const c = loadConfig({}, ROOT);
    expect(c).toMatchObject({
      host: '127.0.0.1',
      port: 8787,
      base: '/assistant',
      origins: [],
      siteDir: DEMO,
      policyPath: join(DEMO, 'assistant-policy.yaml'),
      policyExplicit: false,
      dataDir: join(ROOT, 'data'),
      knowledgeDir: null,
      agent: 'sdk',
      model: DEFAULT_MODEL,
      effort: 'low',
      ha: { mode: 'mock' },
      stt: null,
    });
  });

  it('reads every variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-cfg-'));
    mkdirSync(join(dir, 'kb'));
    writeFileSync(join(dir, 'p.yaml'), 'version: 1\n');
    const c = loadConfig(
      {
        JARVIS_ASSISTANT_HOST: '0.0.0.0',
        JARVIS_ASSISTANT_PORT: '9000',
        JARVIS_ASSISTANT_BASE: '/jarvis/assistant/',
        JARVIS_ASSISTANT_ORIGINS: 'https://jarvis.example.org, http://localhost:5173',
        JARVIS_SITE_DIR: DEMO,
        JARVIS_ASSISTANT_POLICY: join(dir, 'p.yaml'),
        JARVIS_ASSISTANT_DATA: join(dir, 'data'),
        JARVIS_ASSISTANT_KNOWLEDGE: join(dir, 'kb'),
        JARVIS_ASSISTANT_AGENT: 'scripted',
        JARVIS_ASSISTANT_MODEL: 'claude-haiku-5',
        JARVIS_ASSISTANT_EFFORT: 'medium',
        JARVIS_HA_MODE: 'live',
        JARVIS_HA_URL: 'https://ha.example.org',
        JARVIS_HA_TOKEN: 'tok',
        JARVIS_STT_URL: 'http://speaches:8000/v1/',
        JARVIS_STT_MODEL: 'Systran/faster-whisper-small',
        JARVIS_STT_KEY: 'k',
        JARVIS_STT_LANGUAGE: 'en',
      },
      ROOT,
    );
    expect(c).toMatchObject({
      host: '0.0.0.0',
      port: 9000,
      base: '/jarvis/assistant',
      origins: ['https://jarvis.example.org', 'http://localhost:5173'],
      policyPath: join(dir, 'p.yaml'),
      policyExplicit: true,
      knowledgeDir: join(dir, 'kb'),
      agent: 'scripted',
      model: 'claude-haiku-5',
      effort: 'medium',
      ha: { mode: 'live', url: 'https://ha.example.org', token: 'tok' },
      stt: { url: 'http://speaches:8000/v1', model: 'Systran/faster-whisper-small', key: 'k', language: 'en' },
    });
  });

  it('reads a JSON file of the same keys, under the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-cfg-'));
    const file = join(dir, 'assistant.json');
    writeFileSync(
      file,
      JSON.stringify({ JARVIS_ASSISTANT_PORT: 9100, JARVIS_ASSISTANT_ORIGINS: ['https://a.example'] }),
    );
    const c = loadConfig({ JARVIS_ASSISTANT_CONFIG: file, JARVIS_ASSISTANT_PORT: '9200' }, ROOT);
    expect(c.port).toBe(9200);
    expect(c.origins).toEqual(['https://a.example']);
    writeFileSync(file, JSON.stringify({ JARVIS_NOPE: 1 }));
    expect(() => loadConfig({ JARVIS_ASSISTANT_CONFIG: file }, ROOT)).toThrow(/unknown key JARVIS_NOPE/);
  });

  it('lists every problem at once', () => {
    let err: ConfigError | null = null;
    try {
      loadConfig(
        {
          JARVIS_ASSISTANT_PORT: 'eighty',
          JARVIS_ASSISTANT_ORIGINS: 'jarvis.example.org',
          JARVIS_SITE_DIR: '/nonexistent',
          JARVIS_ASSISTANT_AGENT: 'gpt',
          JARVIS_ASSISTANT_EFFORT: 'extreme',
          JARVIS_HA_MODE: 'live',
          JARVIS_STT_URL: 'speaches:8000',
        },
        ROOT,
      );
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const all = err!.problems.join('\n');
    for (const k of [
      'JARVIS_ASSISTANT_PORT',
      'JARVIS_ASSISTANT_ORIGINS',
      'JARVIS_SITE_DIR',
      'JARVIS_ASSISTANT_AGENT',
      'JARVIS_ASSISTANT_EFFORT',
      'JARVIS_HA_URL',
      'JARVIS_HA_TOKEN',
      'JARVIS_STT_URL',
    ])
      expect(all).toContain(k);
  });

  it('an explicit policy path must exist', () => {
    expect(() => loadConfig({ JARVIS_ASSISTANT_POLICY: '/nonexistent.yaml' }, ROOT)).toThrow(/no such file/);
  });
});

describe('authWarnings', () => {
  it('the API key alone is the default, silently fine', () => {
    expect(authWarnings({ ANTHROPIC_API_KEY: 'sk' })).toEqual({ level: 'ok', uses: 'api-key', lines: [] });
  });

  it('the OAuth token alone: a one-line personal-use notice', () => {
    const r = authWarnings({ CLAUDE_CODE_OAUTH_TOKEN: 'oat' });
    expect(r.level).toBe('info');
    expect(r.uses).toBe('subscription');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/personal use only/);
  });

  it('both: warns loudly that the API key wins and bills the API', () => {
    const r = authWarnings({ CLAUDE_CODE_OAUTH_TOKEN: 'oat', ANTHROPIC_API_KEY: 'sk' });
    expect(r.level).toBe('warn');
    expect(r.uses).toBe('api-key');
    expect(r.lines.join(' ')).toMatch(/ANTHROPIC_API_KEY silently wins.*billed to the API/);
    const r2 = authWarnings({ CLAUDE_CODE_OAUTH_TOKEN: 'oat', ANTHROPIC_AUTH_TOKEN: 'x' });
    expect(r2.level).toBe('warn');
    expect(r2.lines[0]).toContain('ANTHROPIC_AUTH_TOKEN');
  });

  it('neither: an error with instructions for the sdk agent, nothing for the scripted one', () => {
    const r = authWarnings({ ANTHROPIC_API_KEY: '  ' });
    expect(r.level).toBe('error');
    expect(r.lines.join(' ')).toMatch(/ANTHROPIC_API_KEY.*CLAUDE_CODE_OAUTH_TOKEN.*scripted/);
    expect(authWarnings({}, 'scripted').level).toBe('ok');
  });

  it('`claude login` credentials alone: the personal-use notice; the env vars still take precedence', () => {
    expect(authWarnings({}, 'sdk', true)).toMatchObject({ level: 'info', uses: 'subscription' });
    expect(authWarnings({ ANTHROPIC_API_KEY: 'sk' }, 'sdk', true).uses).toBe('api-key');
    expect(loginCredentialsFile({ CLAUDE_CONFIG_DIR: '/cfg' })).toBe('/cfg/.credentials.json');
    expect(loginCredentialsFile({ HOME: '/home/me' })).toBe('/home/me/.claude/.credentials.json');
  });

  it('boxes a warning', () => {
    const b = boxed('TITLE', ['one', 'three']).split('\n');
    expect(b[0]).toMatch(/^!+$/);
    expect(b.at(-1)).toBe(b[0]);
    expect(new Set(b.map((l) => l.length)).size).toBe(1);
    expect(b[1]).toBe('! TITLE !');
  });
});
