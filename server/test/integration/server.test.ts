// The whole server in-process: real HTTP + WebSocket on an ephemeral port, the scripted agent (no model), the mock
// Home Assistant, the example policy, a clients file of access codes, and a fake OpenAI-compatible transcription
// server. Logins (access codes and mock HA tokens), the Origin rule, /transcribe tickets and the rate limits end to
// end. Needs the server's own npm install (ws, yaml): npm --prefix server test.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAssistant, loadClients, promptOptions, type Assistant } from '../../src/app.ts';
import { createScriptedAgent } from '../../src/agent-scripted.ts';
import { newClientSecret } from '../../src/core/auth.ts';
import { loadConfig } from '../../src/core/config.ts';
import { buildSystemPrompt } from '../../src/core/knowledge.ts';
import { createMockHa, mockCurrentUser, type MockHa } from '../../src/core/ha-mock.ts';
import type { ServerMsg } from '../../src/core/protocol.ts';
import { originAllowed } from '../../src/server.ts';

const SERVER_DIR = resolve(import.meta.dirname, '../..');
const ORIGIN = 'http://jarvis.test';

// the clients file: a screen tablet and a voice-only speaker
const TABLET = newClientSecret('tablet', 'screen');
const SPEAKER = newClientSecret('kitchen-speaker', 'speaker');
const TMP = mkdtempSync(join(tmpdir(), 'jarvis-it-'));
const CLIENTS = join(TMP, 'clients.yaml');
writeFileSync(
  CLIENTS,
  [
    'clients:',
    ...[TABLET, SPEAKER].map(
      ({ entry: e }) => `  - { name: ${e.name}, secret_sha256: ${e.secretSha256}, surface: ${e.surface} }`,
    ),
    'ha_users:',
    '  - { id: mock-ana, surface: speaker }',
    '  - { id: mock-ben, surface: screen }',
    '',
  ].join('\n'),
);
const tablet = { type: 'secret', secret: TABLET.code };
const speaker = { type: 'secret', secret: SPEAKER.code };

let app: Assistant;
let base: string;
let stt: Server;
const sttSeen: { auth?: string; type?: string; body: string }[] = [];

beforeAll(async () => {
  // a fake Speaches / faster-whisper
  stt = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      sttSeen.push({
        auth: req.headers.authorization,
        type: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('latin1'),
      });
      if (req.url !== '/v1/audio/transcriptions') return void res.writeHead(404).end();
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ text: 'turn on the hall light' }));
    });
  });
  await new Promise<void>((r) => stt.listen(0, '127.0.0.1', () => r()));
  const sttPort = (stt.address() as AddressInfo).port;

  const config = loadConfig(
    {
      JARVIS_ASSISTANT_PORT: '0',
      JARVIS_ASSISTANT_AGENT: 'scripted',
      JARVIS_ASSISTANT_ORIGINS: ORIGIN,
      JARVIS_ASSISTANT_POLICY: join(SERVER_DIR, 'policy.example.yaml'),
      JARVIS_ASSISTANT_DATA: join(TMP, 'data'),
      JARVIS_ASSISTANT_AUTH: 'secret,ha',
      JARVIS_ASSISTANT_CLIENTS: CLIENTS,
      JARVIS_ASSISTANT_RATE_TRANSCRIBE: '100/100', // (the limits get a server of their own below)
      JARVIS_SITE_DIR: resolve(SERVER_DIR, '../examples/demo-site'),
      JARVIS_STT_URL: `http://127.0.0.1:${sttPort}/v1`,
      JARVIS_STT_KEY: 'stt-key',
      JARVIS_STT_MODEL: 'small',
    },
    SERVER_DIR,
  );
  app = createAssistant(config, { agent: createScriptedAgent({ chunkDelayMs: 0 }), log: () => {} });
  const addr = await app.server.listen();
  base = `127.0.0.1:${addr.port}/assistant`;
});

afterAll(async () => {
  await app?.close();
  stt?.close();
});

/** a ws client that keeps every message and can wait for one */
async function client(origin = ORIGIN, at = base, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://${at}/ws`, { origin, headers });
  const got: ServerMsg[] = [];
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  const closed = new Promise<number>((res) => ws.once('close', (code) => res(code)));
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const wait = async <T extends ServerMsg['type']>(
    type: T,
    pred: (m: Extract<ServerMsg, { type: T }>) => boolean = () => true,
    ms = 3000,
  ) => {
    const end = Date.now() + ms;
    for (;;) {
      const m = got.find((x) => x.type === type && pred(x as never));
      if (m) return m as Extract<ServerMsg, { type: T }>;
      if (Date.now() > end) throw new Error(`no ${type} within ${ms} ms; got ${got.map((x) => x.type).join(', ')}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  /** hello with a credential; resolves with the welcome */
  const login = async (auth: unknown = tablet, clientId = `it-${Math.random().toString(36).slice(2)}`, extra = {}) => {
    send({ type: 'hello', clientId, auth, capabilities: ['viewer'], ...extra });
    return wait('welcome');
  };
  return { ws, got, send, wait, closed, login };
}

/** POST /transcribe with a little audio, from ORIGIN, with a ticket */
const upload = (ticket?: string, at = base, headers: Record<string, string> = { origin: ORIGIN }) => {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(2048)], { type: 'audio/webm' }), 'a.webm');
  return fetch(`http://${at}/transcribe`, {
    method: 'POST',
    body: form,
    headers: { ...headers, ...(ticket ? { authorization: `Bearer ${ticket}` } : {}) },
  });
};

describe('assistant server', () => {
  it('GET /health', async () => {
    const r = await fetch(`http://${base}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, agent: 'scripted', ha: 'mock', transcribe: true });
    expect((await fetch(`http://${base}/nope`)).status).toBe(404);
    expect((await fetch(`http://${base}/health`, { method: 'POST' })).status).toBe(405);
  });

  it('hello → welcome; a light command streams a turn and switches the mock light', async () => {
    const c = await client();
    expect(await c.login(tablet, 'it-1')).toMatchObject({
      agent: 'scripted',
      ha: 'mock',
      transcribe: true,
      status: 'idle',
      user: { name: 'tablet' },
      ticket: expect.any(String),
    });

    c.send({ type: 'say', text: 'Turn on the kitchen pendants', source: 'typed' });
    const start = await c.wait('turn.start');
    const end = await c.wait('turn.end', (m) => m.turnId === start.turnId);
    expect(end.error).toBeUndefined();
    const text = c.got
      .filter((m) => m.type === 'text.delta' && m.turnId === start.turnId)
      .map((m) => (m as { delta: string }).delta)
      .join('');
    expect(text).toMatch(/^Done\./);
    const act = c.got.filter((m) => m.type === 'tool' && m.name === 'ha_act');
    expect(act.at(-1)).toMatchObject({ status: 'done', subject: 'fixture:kitchen.pendant.1' });
    const ha = app.ha as MockHa;
    for (const n of [1, 2, 3]) expect(ha.entities.get(`light.kitchen_pendant_${n}`)!.state).toBe('on');
    c.ws.close();
  });

  it('a confirm-tier command: confirm.request → approve → resolved approved, the thermostat changes', async () => {
    const c = await client();
    await c.login(tablet, 'it-2');
    c.send({ type: 'say', text: 'Set the thermostat to 72', source: 'voice' });
    const req = await c.wait('confirm.request');
    expect(req.summary).toMatch(/Hall thermostat/);
    expect(c.got.some((m) => m.type === 'tool' && m.status === 'pending')).toBe(true);
    const ha = app.ha as MockHa;
    expect(ha.entities.get('climate.hall_thermostat')!.attributes.temperature).toBe(70);
    c.send({ type: 'confirm.reply', id: req.id, approved: true });
    expect(await c.wait('confirm.resolved')).toEqual({ type: 'confirm.resolved', id: req.id, outcome: 'approved' });
    await c.wait('turn.end');
    expect(ha.entities.get('climate.hall_thermostat')!.attributes.temperature).toBe(72);
    c.ws.close();
  });

  it('a refused command says why and changes nothing', async () => {
    const c = await client();
    await c.login(speaker, 'it-3', { capabilities: [] });
    c.send({ type: 'say', text: 'switch off the network rack', source: 'voice' });
    await c.wait('turn.end');
    const text = c.got
      .filter((m) => m.type === 'text.delta')
      .map((m) => (m as { delta: string }).delta)
      .join('');
    expect(text).toMatch(/can't do that: That switch powers the network/);
    expect((app.ha as MockHa).entities.get('switch.network_rack')!.state).toBe('on');
    c.ws.close();
  });

  it('show me: a view.command round trip', async () => {
    const c = await client();
    await c.login(tablet, 'it-4');
    c.send({ type: 'say', text: 'show me the water heater', source: 'typed' });
    const cmd = await c.wait('view.command');
    expect(cmd).toMatchObject({ op: 'fly', args: { subject: 'pins:plumb.water-heater' } });
    c.send({ type: 'view.result', id: cmd.id, ok: true });
    await c.wait('turn.end');
    const text = c.got
      .filter((m) => m.type === 'text.delta')
      .map((m) => (m as { delta: string }).delta)
      .join('');
    expect(text).toBe("Here's the water heater. It's in the kitchen.");
    c.ws.close();
  });

  it('malformed messages after the login get an error and the connection stays up', async () => {
    const c = await client();
    await c.login(tablet, 'it-5');
    c.ws.send('{nope');
    c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    await c.wait('error', (m) => m.message === 'not JSON');
    await c.wait('error', (m) => m.message === 'text messages only');
    c.send({ type: 'say', text: 'what do you remember', source: 'typed' });
    await c.wait('turn.end');
    c.ws.close();
  });

  it('a hello without a credential, or with a wrong one, is refused and the socket closed (4401)', async () => {
    for (const hello of [
      { type: 'hello', clientId: 'x', capabilities: [] },
      { type: 'hello', clientId: 'x', surface: 'screen', capabilities: [] },
      { type: 'say', text: 'turn on the kitchen pendants' },
    ]) {
      const c = await client();
      c.send(hello);
      expect(await c.closed).toBe(4401);
      expect(c.got.map((m) => m.type)).toEqual(['error']);
    }
    for (const auth of [
      { type: 'secret', secret: 'tablet:guess' },
      { type: 'ha', token: 'not-a-mock-user' },
    ]) {
      const c = await client();
      c.send({ type: 'hello', clientId: 'x', auth, capabilities: [] });
      expect(await c.closed).toBe(4401);
      expect(c.got).toEqual([{ type: 'error', message: 'not authorised' }]);
    }
    expect((app.ha as MockHa).entities.get('light.kitchen_pendant_1')).toBeTruthy();
  });

  it("a Home Assistant login (the mock's mock-user:<name>), with the surface the clients file gives that user", async () => {
    const c = await client();
    expect((await c.login({ type: 'ha', token: 'mock-user:Ben' })).user).toEqual({ name: 'Ben' });
    const d = await client();
    expect((await d.login({ type: 'ha', token: 'mock-user:Ana' }, 'ana-tab', { surface: 'screen' })).user).toEqual({
      name: 'Ana',
    });
    d.send({ type: 'say', text: 'what do you remember', source: 'typed' });
    expect((await d.wait('turn.start')).surface).toBe('speaker'); // ha_users: Ana is a speaker
    await d.wait('turn.end');
    c.ws.close();
    d.ws.close();
    // JARVIS_ASSISTANT_HA_USERS_ONLY (the default): someone Home Assistant knows but ha_users doesn't list is refused
    const e = await client();
    e.send({ type: 'hello', clientId: 'cy', auth: { type: 'ha', token: 'mock-user:Cy' }, capabilities: [] });
    expect(await e.closed).toBe(4401);
    expect(e.got).toEqual([{ type: 'error', message: 'not authorised' }]);
  });

  it('the surface comes from the credential: a speaker that says it is a screen is still a speaker', async () => {
    const c = await client();
    await c.login(speaker, 'it-6', { surface: 'screen', capabilities: ['viewer'] });
    c.send({ type: 'say', text: 'what do you remember', source: 'voice' });
    expect((await c.wait('turn.start')).surface).toBe('speaker');
    await c.wait('turn.end');
    c.ws.close();
  });

  it('refuses a WebSocket from another origin, and other paths', async () => {
    const status = (url: string, origin?: string) =>
      new Promise<number>((res) => {
        const ws = new WebSocket(url, origin ? { origin } : {});
        ws.on('unexpected-response', (_req, r) => res(r.statusCode ?? 0));
        ws.on('open', () => {
          ws.close();
          res(101);
        });
        ws.on('error', () => {});
      });
    expect(await status(`ws://${base}/ws`, 'http://evil.example')).toBe(403);
    expect(await status(`ws://${base}/elsewhere`, ORIGIN)).toBe(404);
    expect(await status(`ws://${base}/ws`, ORIGIN)).toBe(101);
    expect(await status(`ws://${base}/ws`)).toBe(403); // no Origin: refused (a non-browser client sends an allowed one)
  });

  it('POST /transcribe forwards the audio to the STT server and returns its text', async () => {
    const c = await client();
    const { ticket } = await c.login();
    const auth = { origin: ORIGIN, authorization: `Bearer ${ticket}` };
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(2048)], { type: 'audio/webm;codecs=opus' }), 'a.webm');
    const r = await fetch(`http://${base}/transcribe`, { method: 'POST', body: form, headers: auth });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: 'turn on the hall light' });
    const seen = sttSeen.at(-1)!;
    expect(seen.auth).toBe('Bearer stt-key');
    expect(seen.type).toMatch(/^multipart\/form-data/);
    expect(seen.body).toContain('name="model"\r\n\r\nsmall');

    const bad = new FormData();
    bad.append('file', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
    expect((await fetch(`http://${base}/transcribe`, { method: 'POST', body: bad, headers: auth })).status).toBe(415);
    expect((await fetch(`http://${base}/transcribe`, { method: 'POST', body: 'x', headers: auth })).status).toBe(415);
    expect((await fetch(`http://${base}/transcribe`)).status).toBe(405);
    c.ws.close();
  });

  it("POST /transcribe needs a live connection's ticket: none, a made-up one or a closed connection's → 401", async () => {
    const n = sttSeen.length;
    const c = await client();
    const { ticket } = await c.login();
    const r = await upload();
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer');
    expect(await r.json()).toEqual({ error: expect.stringMatching(/^not authorised/) });
    expect((await upload('made-up-ticket')).status).toBe(401);
    expect((await upload(ticket)).status).toBe(200);
    // another connection's ticket stops working when that connection closes; a reconnect gets a new one
    c.ws.close();
    await c.closed;
    await new Promise((res) => setTimeout(res, 20));
    expect((await upload(ticket)).status).toBe(401);
    const again = await client();
    const w = await again.login();
    expect(w.ticket).not.toBe(ticket);
    expect((await upload(w.ticket)).status).toBe(200);
    expect(sttSeen.length).toBe(n + 2);
    again.ws.close();
  });

  it('POST /transcribe from another origin, or with none, is refused (a web page must not spend the STT credit)', async () => {
    const n = sttSeen.length;
    const c = await client();
    const { ticket } = await c.login();
    const r = await upload(ticket, base, { origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'this origin may not use the assistant' });
    expect((await upload(ticket, base, { origin: 'http://jarvis.test:8080' })).status).toBe(403); // exact
    expect((await upload(ticket, base, {})).status).toBe(403); // no Origin at all
    expect(sttSeen.length).toBe(n);
    expect((await upload(ticket)).status).toBe(200);
    c.ws.close();
  });

  it('an upload over the cap gets its 413 before the connection closes', async () => {
    const c = await client();
    const { ticket } = await c.login();
    const big = new Uint8Array(11 * 1024 * 1024);
    const form = new FormData();
    form.append('file', new Blob([big], { type: 'audio/webm' }), 'a.webm');
    const r = await fetch(`http://${base}/transcribe`, {
      method: 'POST',
      body: form,
      headers: { origin: ORIGIN, authorization: `Bearer ${ticket}` },
    });
    expect(r.status).toBe(413);
    expect(r.headers.get('connection')).toBe('close');
    expect(((await r.json()) as { error: string }).error).toMatch(/the upload is over 10 MB/);
    c.ws.close();
  });
});

describe('limits (a second server with small ones)', () => {
  let small: Assistant;
  let at: string;
  beforeAll(async () => {
    const config = loadConfig(
      {
        JARVIS_ASSISTANT_PORT: '0',
        JARVIS_ASSISTANT_AGENT: 'scripted',
        JARVIS_ASSISTANT_ORIGINS: ORIGIN,
        JARVIS_ASSISTANT_POLICY: join(SERVER_DIR, 'policy.example.yaml'),
        JARVIS_ASSISTANT_DATA: join(TMP, 'data-small'),
        JARVIS_SITE_DIR: resolve(SERVER_DIR, '../examples/demo-site'),
        JARVIS_STT_URL: `http://127.0.0.1:${(stt.address() as AddressInfo).port}/v1`,
        JARVIS_ASSISTANT_AUTH: 'secret',
        JARVIS_ASSISTANT_CLIENTS: CLIENTS,
        JARVIS_ASSISTANT_RATE_SAY: '2/1',
        JARVIS_ASSISTANT_RATE_TRANSCRIBE: '2/1',
      },
      SERVER_DIR,
    );
    small = createAssistant(config, { agent: createScriptedAgent({ chunkDelayMs: 0 }), log: () => {} });
    at = `127.0.0.1:${(await small.server.listen()).port}/assistant`;
  });
  afterAll(async () => {
    await small?.close();
  });

  it('say and /transcribe per user: over the limit → "slow down" / 429; another user is not affected', async () => {
    const a = await client(ORIGIN, at);
    const { ticket } = await a.login(tablet);
    for (let i = 0; i < 3; i++) a.send({ type: 'say', text: 'what do you remember', source: 'typed' });
    expect((await a.wait('error')).message).toMatch(/^slow down/);
    expect([(await upload(ticket, at)).status, (await upload(ticket, at)).status]).toEqual([200, 200]);
    const r = await upload(ticket, at);
    expect(r.status).toBe(429);
    expect(((await r.json()) as { error: string }).error).toMatch(/^slow down/);
    const b = await client(ORIGIN, at);
    const wb = await b.login(speaker);
    expect((await upload(wb.ticket, at)).status).toBe(200);
    a.ws.close();
    b.ws.close();
  });

  it('5 failed logins from an address, then its guesses are refused unchecked (4429); the right code still works', async () => {
    for (let i = 0; i < 5; i++) {
      const c = await client(ORIGIN, at);
      c.send({ type: 'hello', clientId: 'x', auth: { type: 'secret', secret: `tablet:guess-${i}` }, capabilities: [] });
      expect(await c.closed).toBe(4401);
    }
    const c = await client(ORIGIN, at);
    c.send({ type: 'hello', clientId: 'x', auth: { type: 'secret', secret: 'tablet:guess-5' }, capabilities: [] });
    expect(await c.closed).toBe(4429);
    expect(c.got).toEqual([{ type: 'error', message: 'too many failed attempts; try again in a minute' }]);
    const d = await client(ORIGIN, at);
    expect((await d.login(tablet)).user).toEqual({ name: 'tablet' });
    d.ws.close();
  });
});

describe('logins (a server of their own: a slow mock Home Assistant, a trusted proxy, a short hello deadline)', () => {
  let app3: Assistant;
  let at: string;
  const logs: string[] = [];
  const CLIENTS3 = join(TMP, 'clients3.yaml');
  const writeClients = (lines: string[]) =>
    writeFileSync(
      CLIENTS3,
      ['clients:', ...lines, 'ha_users:', '  - { id: mock-ana, surface: screen }', ''].join('\n'),
    );
  const line = (c: typeof TABLET, surface = c.entry.surface) =>
    `  - { name: ${c.entry.name}, secret_sha256: ${c.entry.secretSha256}, surface: ${surface} }`;
  beforeAll(async () => {
    writeClients([line(TABLET), line(SPEAKER)]);
    const config = loadConfig(
      {
        JARVIS_ASSISTANT_PORT: '0',
        JARVIS_ASSISTANT_AGENT: 'scripted',
        JARVIS_ASSISTANT_ORIGINS: ORIGIN,
        JARVIS_ASSISTANT_POLICY: join(SERVER_DIR, 'policy.example.yaml'),
        JARVIS_ASSISTANT_DATA: join(TMP, 'data-logins'),
        JARVIS_SITE_DIR: resolve(SERVER_DIR, '../examples/demo-site'),
        JARVIS_ASSISTANT_AUTH: 'secret,ha',
        JARVIS_ASSISTANT_CLIENTS: CLIENTS3,
        JARVIS_ASSISTANT_TRUSTED_PROXY: '127.0.0.1',
        JARVIS_ASSISTANT_HELLO_TIMEOUT_S: '0.5',
      },
      SERVER_DIR,
    );
    // the mock's logins, slowly; mock-user:Down is Home Assistant being unreachable
    const ha = Object.assign(createMockHa(), {
      async currentUser(token: string) {
        await new Promise((r) => setTimeout(r, 150));
        if (token === 'mock-user:Down') throw new Error('ECONNREFUSED');
        return mockCurrentUser(token);
      },
    });
    app3 = createAssistant(config, { ha, agent: createScriptedAgent({ chunkDelayMs: 0 }), log: (m) => logs.push(m) });
    at = `127.0.0.1:${(await app3.server.listen()).port}/assistant`;
  });
  afterAll(async () => {
    await app3?.close();
  });
  const hello = (auth: unknown, clientId = 'x') => ({ type: 'hello', clientId, auth, capabilities: [] });
  const status = (headers: Record<string, string> = {}) =>
    new Promise<number>((res) => {
      const ws = new WebSocket(`ws://${at}/ws`, { origin: ORIGIN, headers });
      ws.on('unexpected-response', (_req, r) => res(r.statusCode ?? 0));
      ws.on('open', () => res(101));
      ws.on('error', () => {});
    });

  it('says loudly at start-up that HA logins against the mock let anyone be anyone', () => {
    expect(logs.join('\n')).toMatch(/HOME ASSISTANT LOGINS AGAINST THE MOCK[\s\S]*anyone can log in as/);
  });

  it('a hello still being checked plus a flood: cut off, nothing queued', async () => {
    const c = await client(ORIGIN, at);
    c.send(hello({ type: 'ha', token: 'mock-user:Ana' }));
    for (let i = 0; i < 200; i++) c.send({ type: 'say', text: `flood ${i}`, source: 'typed' });
    expect(await c.closed).toBe(1006); // terminated: no closing handshake
    expect(c.got).toEqual([]);
    await new Promise((r) => setTimeout(r, 250)); // the check finishes: nobody is let in
    expect(app3.hub.clientCount()).toBe(0);
    expect(app3.hub.transcript()).toEqual([]);
  });

  it('a big first message is cut off; a binary one is refused', async () => {
    const c = await client(ORIGIN, at);
    c.ws.send(JSON.stringify({ ...hello({ type: 'secret', secret: TABLET.code }), pad: 'x'.repeat(9000) }));
    expect(await c.closed).toBe(1006);
    const d = await client(ORIGIN, at);
    d.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    expect(await d.closed).toBe(4401);
  });

  it('no hello within JARVIS_ASSISTANT_HELLO_TIMEOUT_S: closed 4401', async () => {
    const c = await client(ORIGIN, at);
    const t0 = Date.now();
    expect(await c.closed).toBe(4401);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });

  it('at most 8 connections from an address wait to log in (behind the trusted proxy: per client address)', async () => {
    const waiting = await Promise.all(
      Array.from({ length: 8 }, () => client(ORIGIN, at, { 'x-forwarded-for': '10.7.7.7' })),
    );
    expect(await status({ 'x-forwarded-for': '10.7.7.7' })).toBe(503);
    expect(await status({ 'x-forwarded-for': '6.6.6.6, 10.7.7.8' })).toBe(101); // another client of the proxy
    for (const w of waiting) w.ws.terminate();
    await new Promise((r) => setTimeout(r, 100));
    expect(await status({ 'x-forwarded-for': '10.7.7.7' })).toBe(101);
    await new Promise((r) => setTimeout(r, 600)); // (the open ones time out)
  });

  it('Home Assistant unreachable is 4503 (the client retries), not 4401', async () => {
    const c = await client(ORIGIN, at, { 'x-forwarded-for': '10.8.0.1' });
    c.send(hello({ type: 'ha', token: 'mock-user:Down' }));
    expect(await c.closed).toBe(4503);
    expect(c.got).toEqual([{ type: 'error', message: 'Home Assistant could not check the login; trying again' }]);
  });

  it('the failed-login limit counts the client behind the proxy, not the proxy', async () => {
    const guess = async (xff: string) => {
      const c = await client(ORIGIN, at, { 'x-forwarded-for': xff });
      c.send(hello({ type: 'secret', secret: 'tablet:guess' }));
      return c.closed;
    };
    for (let i = 0; i < 5; i++) expect(await guess('10.9.0.1')).toBe(4401);
    expect(await guess('10.9.0.1')).toBe(4429);
    expect(await guess('evil, 10.9.0.1')).toBe(4429); // a forged left part changes nothing
    expect(await guess('10.9.0.2')).toBe(4401); // someone else in the house is not locked out
  });

  it('SIGHUP reloads the clients file: a removed code is closed 4401, a changed surface 1012, the rest stay', async () => {
    const t = await client(ORIGIN, at);
    await t.login(tablet);
    const k = await client(ORIGIN, at);
    await k.login(speaker);
    const h = await client(ORIGIN, at);
    await h.login({ type: 'ha', token: 'mock-user:Ana' });
    expect(app3.hub.clientCount()).toBe(3);
    writeClients([line(SPEAKER, 'screen')]);
    expect(app3.reloadClients().closed).toBe(2);
    expect(await t.closed).toBe(4401);
    expect(await k.closed).toBe(1012);
    expect(app3.hub.clientCount()).toBe(1);
    // a broken file keeps the old one
    writeFileSync(CLIENTS3, 'clients: [\n');
    expect(() => app3.reloadClients()).toThrow(/clients3\.yaml/);
    const again = await client(ORIGIN, at);
    expect((await again.login(speaker)).user).toEqual({ name: 'kitchen-speaker' });
    h.send({ type: 'say', text: 'what do you remember', source: 'typed' });
    expect((await h.wait('turn.start')).surface).toBe('screen');
    h.ws.close();
    again.ws.close();
  });
});

describe('the Origin check', () => {
  it('a list is exact; an empty list (loopback binds only) means the request’s own host; none is refused', () => {
    expect(originAllowed(undefined, 'x', ['https://a.example'])).toBe(false);
    expect(originAllowed(undefined, '127.0.0.1:8787', [])).toBe(false);
    expect(originAllowed('', '127.0.0.1:8787', [])).toBe(false);
    expect(originAllowed('https://a.example', 'b.example', ['https://a.example'])).toBe(true);
    expect(originAllowed('https://a.example:8443', 'a.example:8443', ['https://a.example'])).toBe(false);
    expect(originAllowed('http://a.example', 'a.example', ['https://a.example'])).toBe(false);
    expect(originAllowed('http://127.0.0.1:8787', '127.0.0.1:8787', [])).toBe(true);
    expect(originAllowed('http://evil.example', '127.0.0.1:8787', [])).toBe(false);
    expect(originAllowed('http://localhost:8787', 'localhost:8787', [])).toBe(true);
    // DNS rebinding: evil.example resolves to 127.0.0.1, so Origin and Host agree, but neither is a loopback name
    expect(originAllowed('http://evil.example:8787', 'evil.example:8787', [])).toBe(false);
  });
});

describe('assembly', () => {
  it('the system prompt only offers the web tools when JARVIS_ASSISTANT_WEB is on', () => {
    expect(promptOptions({ web: false, knowledgeDir: null })).toEqual({
      web: false,
      knowledge: false,
      escalation: false,
    });
    expect(buildSystemPrompt(app.site, promptOptions({ web: false, knowledgeDir: null }))).not.toMatch(/WebSearch/);
    expect(buildSystemPrompt(app.site, promptOptions({ web: true, knowledgeDir: '/kb' }))).toMatch(
      /WebSearch and WebFetch.*Read, Grep and Glob/,
    );
  });

  it('the system prompt offers think_harder only with escalation on, and never to the scripted agent', () => {
    const esc = { model: 'claude-opus-5-5', effort: 'high' } as const;
    const on = promptOptions({ web: false, knowledgeDir: null, agent: 'sdk', escalation: esc });
    expect(on.escalation).toBe(true);
    expect(buildSystemPrompt(app.site, on)).toMatch(/memory_\*, think_harder\)[\s\S]*call think_harder first/);
    for (const o of [{ escalation: null }, { agent: 'scripted' as const, escalation: esc }])
      expect(buildSystemPrompt(app.site, promptOptions({ web: false, knowledgeDir: null, ...o }))).not.toMatch(
        /think_harder/,
      );
  });

  it('the clients file is read as YAML or JSON and checked strictly: a bad one stops the server', () => {
    expect(loadClients(CLIENTS).clients.map((c) => [c.name, c.surface])).toEqual([
      ['tablet', 'screen'],
      ['kitchen-speaker', 'speaker'],
    ]);
    const json = join(TMP, 'clients.json');
    writeFileSync(json, JSON.stringify({ clients: [{ name: 'a', secret_sha256: 'f'.repeat(64), surface: 'screen' }] }));
    expect(loadClients(json).clients).toHaveLength(1);
    expect(loadClients(null)).toEqual({ clients: [], haUsers: [] });
    const bad = join(TMP, 'bad.yaml');
    writeFileSync(bad, 'clients:\n  - { name: a, secret: hunter2, surface: screen }\n');
    expect(() => loadClients(bad)).toThrow(/unknown key secret/);
    writeFileSync(join(TMP, 'broken.yaml'), 'clients: [\n');
    expect(() => loadClients(join(TMP, 'broken.yaml'))).toThrow(/broken\.yaml/);
    const config = loadConfig(
      { JARVIS_ASSISTANT_AGENT: 'scripted', JARVIS_ASSISTANT_AUTH: 'secret', JARVIS_ASSISTANT_CLIENTS: bad },
      SERVER_DIR,
    );
    expect(() => createAssistant(config, { log: () => {} })).toThrow(/secret_sha256 must be 64 hex digits/);
  });
});
