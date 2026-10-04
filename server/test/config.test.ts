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
  mockLoginWarning,
} from '../src/core/config.ts';

const ROOT = resolve(import.meta.dirname, '../..');
/** the one setting without a default */
const A = { JARVIS_ASSISTANT_AUTH: 'ha' };
const DEMO = join(ROOT, 'examples/demo-site');
/** a clients file (its contents are app.ts's business; the config only checks it exists) */
const CLIENTS = join(mkdtempSync(join(tmpdir(), 'jarvis-clients-')), 'clients.yaml');
writeFileSync(CLIENTS, 'clients: []\n');

describe('loadConfig', () => {
  it('has safe defaults: loopback, mock HA, the demo site, transcription off', () => {
    const c = loadConfig({ ...A }, ROOT);
    expect(c).toMatchObject({
      host: '127.0.0.1',
      port: 8787,
      base: '/assistant',
      origins: [],
      siteDir: DEMO,
      // the demo house has no assistant-policy.yaml; as the default site it gets the example written for it
      policyPath: join(ROOT, 'server/policy.example.yaml'),
      policyExplicit: false,
      dataDir: join(ROOT, 'data'),
      knowledgeDir: null,
      agent: 'sdk',
      model: DEFAULT_MODEL,
      effort: 'low',
      ha: { mode: 'mock' },
      web: true,
      turnTimeoutMs: 180_000,
      stt: null,
      auth: ['ha'],
      clientsPath: null,
      haSurface: 'screen',
      haUsersOnly: true,
      helloTimeoutMs: 10_000,
      trustedProxies: [],
      rateSay: { burst: 6, perMinute: 20 },
      rateTranscribe: { burst: 6, perMinute: 20 },
    });
  });

  it('JARVIS_ASSISTANT_HA_USERS_ONLY, JARVIS_ASSISTANT_HELLO_TIMEOUT_S and JARVIS_ASSISTANT_TRUSTED_PROXY', () => {
    const c = loadConfig(
      {
        ...A,
        JARVIS_ASSISTANT_HA_USERS_ONLY: 'false',
        JARVIS_ASSISTANT_HELLO_TIMEOUT_S: '2.5',
        JARVIS_ASSISTANT_TRUSTED_PROXY: '172.18.0.2, ::ffff:10.0.0.1,fd00::1',
      },
      ROOT,
    );
    expect(c).toMatchObject({
      haUsersOnly: false,
      helloTimeoutMs: 2500,
      trustedProxies: ['172.18.0.2', '10.0.0.1', 'fd00::1'],
    });
    expect(loadConfig({ ...A, JARVIS_ASSISTANT_HA_USERS_ONLY: 'true' }, ROOT).haUsersOnly).toBe(true);
    expect(() => loadConfig({ ...A, JARVIS_ASSISTANT_HA_USERS_ONLY: 'no' }, ROOT)).toThrow(
      /HA_USERS_ONLY: true or false/,
    );
    for (const t of ['0', 'never'])
      expect(() => loadConfig({ ...A, JARVIS_ASSISTANT_HELLO_TIMEOUT_S: t }, ROOT)).toThrow(/HELLO_TIMEOUT_S/);
    for (const p of ['nginx', '10.0.0.0/8'])
      expect(() => loadConfig({ ...A, JARVIS_ASSISTANT_TRUSTED_PROXY: p }, ROOT)).toThrow(
        /JARVIS_ASSISTANT_TRUSTED_PROXY: an IP address/,
      );
  });

  it('warns, boxed, when HA logins run against the mock (anyone can be anyone)', () => {
    const w = mockLoginWarning({ auth: ['ha'], ha: { mode: 'mock' } })!;
    expect(w.split('\n')[0]).toMatch(/^!+$/);
    expect(w).toContain('HOME ASSISTANT LOGINS AGAINST THE MOCK');
    expect(w).toMatch(/anyone can log in as\s+!\n! anyone with mock-user:<name>\. For trying it out only/);
    expect(mockLoginWarning({ auth: ['secret'], ha: { mode: 'mock' } })).toBeNull();
    expect(mockLoginWarning({ auth: ['ha', 'secret'], ha: { mode: 'live' } })).toBeNull();
  });

  it('JARVIS_ASSISTANT_AUTH is required (there is no anonymous mode) and must name ha and/or secret', () => {
    for (const v of [undefined, '', '  ', 'none', 'ha,none', 'oauth'])
      expect(() => loadConfig(v === undefined ? {} : { JARVIS_ASSISTANT_AUTH: v }, ROOT)).toThrow(
        v?.trim() ? /JARVIS_ASSISTANT_AUTH: ha and\/or secret, not/ : /JARVIS_ASSISTANT_AUTH is required/,
      );
    expect(
      loadConfig({ JARVIS_ASSISTANT_AUTH: ' secret , ha,secret', JARVIS_ASSISTANT_CLIENTS: CLIENTS }, ROOT).auth,
    ).toEqual(['secret', 'ha']);
  });

  it('secret needs the clients file; JARVIS_ASSISTANT_HA_SURFACE and the rate limits', () => {
    expect(() => loadConfig({ JARVIS_ASSISTANT_AUTH: 'secret' }, ROOT)).toThrow(/needs JARVIS_ASSISTANT_CLIENTS/);
    expect(() => loadConfig({ ...A, JARVIS_ASSISTANT_CLIENTS: '/nonexistent.yaml' }, ROOT)).toThrow(/no such file/);
    const c = loadConfig(
      {
        JARVIS_ASSISTANT_AUTH: 'secret',
        JARVIS_ASSISTANT_CLIENTS: CLIENTS,
        JARVIS_ASSISTANT_HA_SURFACE: 'speaker',
        JARVIS_ASSISTANT_RATE_SAY: '3/10',
        JARVIS_ASSISTANT_RATE_TRANSCRIBE: '2/4',
      },
      ROOT,
    );
    expect(c).toMatchObject({
      clientsPath: CLIENTS,
      haSurface: 'speaker',
      rateSay: { burst: 3, perMinute: 10 },
      rateTranscribe: { burst: 2, perMinute: 4 },
    });
    expect(() => loadConfig({ ...A, JARVIS_ASSISTANT_HA_SURFACE: 'tv' }, ROOT)).toThrow(
      /HA_SURFACE: screen or speaker/,
    );
    for (const r of ['6', '0/5', 'lots'])
      expect(() => loadConfig({ ...A, JARVIS_ASSISTANT_RATE_SAY: r }, ROOT)).toThrow(
        /JARVIS_ASSISTANT_RATE_SAY: burst\/perMinute/,
      );
  });

  it('finds the demo house from any working folder (cd server && npm start)', () => {
    const c = loadConfig({ ...A }, join(ROOT, 'server'));
    expect(c.siteDir).toBe(DEMO);
    expect(c.policyPath).toBe(join(ROOT, 'server/policy.example.yaml'));
    expect(c.dataDir).toBe(join(ROOT, 'server/data'));
  });

  it("a site of one's own: <site>/assistant-policy.yaml (missing: the deny-everything default, not the example)", () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-site-'));
    writeFileSync(join(dir, 'site.json'), '{}');
    expect(loadConfig({ ...A, JARVIS_SITE_DIR: dir }, ROOT).policyPath).toBe(join(dir, 'assistant-policy.yaml'));
    expect(loadConfig({ ...A, JARVIS_SITE_DIR: DEMO }, ROOT).policyPath).toBe(join(DEMO, 'assistant-policy.yaml'));
  });

  it('off loopback, JARVIS_ASSISTANT_ORIGINS is required (DNS rebinding defeats the same-host check)', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost'])
      expect(loadConfig({ ...A, JARVIS_ASSISTANT_HOST: host }, ROOT).origins).toEqual([]);
    for (const host of ['0.0.0.0', '::', '198.51.100.20', 'jarvis.lan'])
      expect(() => loadConfig({ ...A, JARVIS_ASSISTANT_HOST: host }, ROOT)).toThrow(
        /JARVIS_ASSISTANT_ORIGINS: required when JARVIS_ASSISTANT_HOST is not loopback/,
      );
    const c = loadConfig(
      { ...A, JARVIS_ASSISTANT_HOST: '0.0.0.0', JARVIS_ASSISTANT_ORIGINS: 'https://jarvis.lan' },
      ROOT,
    );
    expect(c.origins).toEqual(['https://jarvis.lan']);
  });

  it('JARVIS_ASSISTANT_WEB and JARVIS_ASSISTANT_TURN_TIMEOUT_S', () => {
    const c = loadConfig({ ...A, JARVIS_ASSISTANT_WEB: 'off', JARVIS_ASSISTANT_TURN_TIMEOUT_S: '45' }, ROOT);
    expect(c).toMatchObject({ web: false, turnTimeoutMs: 45_000 });
    expect(() => loadConfig({ ...A, JARVIS_ASSISTANT_WEB: 'no' }, ROOT)).toThrow(/JARVIS_ASSISTANT_WEB: on or off/);
    for (const t of ['0', '-5', 'soon'])
      expect(() => loadConfig({ ...A, JARVIS_ASSISTANT_TURN_TIMEOUT_S: t }, ROOT)).toThrow(/TURN_TIMEOUT_S/);
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
        JARVIS_ASSISTANT_AUTH: 'ha,secret',
        JARVIS_ASSISTANT_CLIENTS: CLIENTS,
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
      auth: ['ha', 'secret'],
      clientsPath: CLIENTS,
    });
  });

  it('reads a JSON file of the same keys, under the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-cfg-'));
    const file = join(dir, 'assistant.json');
    writeFileSync(
      file,
      JSON.stringify({ JARVIS_ASSISTANT_PORT: 9100, JARVIS_ASSISTANT_ORIGINS: ['https://a.example'] }),
    );
    const c = loadConfig({ ...A, JARVIS_ASSISTANT_CONFIG: file, JARVIS_ASSISTANT_PORT: '9200' }, ROOT);
    expect(c.port).toBe(9200);
    expect(c.origins).toEqual(['https://a.example']);
    writeFileSync(file, JSON.stringify({ JARVIS_NOPE: 1 }));
    expect(() => loadConfig({ ...A, JARVIS_ASSISTANT_CONFIG: file }, ROOT)).toThrow(/unknown key JARVIS_NOPE/);
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
          JARVIS_ASSISTANT_AUTH: 'anyone',
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
      'JARVIS_ASSISTANT_AUTH',
    ])
      expect(all).toContain(k);
  });

  it('an explicit policy path must exist', () => {
    expect(() => loadConfig({ ...A, JARVIS_ASSISTANT_POLICY: '/nonexistent.yaml' }, ROOT)).toThrow(/no such file/);
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
