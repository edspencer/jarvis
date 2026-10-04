// The whole server in-process: real HTTP + WebSocket on an ephemeral port, the scripted agent (no model), the mock
// Home Assistant, the example policy, and a fake OpenAI-compatible transcription server. Needs the server's own
// npm install (ws, yaml): npm --prefix server test.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAssistant, type Assistant } from '../../src/app.ts';
import { createScriptedAgent } from '../../src/agent-scripted.ts';
import { loadConfig } from '../../src/core/config.ts';
import type { MockHa } from '../../src/core/ha-mock.ts';
import type { ServerMsg } from '../../src/core/protocol.ts';
import { originAllowed } from '../../src/server.ts';

const SERVER_DIR = resolve(import.meta.dirname, '../..');
const ORIGIN = 'http://jarvis.test';

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
      JARVIS_ASSISTANT_DATA: mkdtempSync(join(tmpdir(), 'jarvis-it-')),
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
async function client(origin = ORIGIN) {
  const ws = new WebSocket(`ws://${base}/ws`, { origin });
  const got: ServerMsg[] = [];
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
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
  return { ws, got, send, wait };
}

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
    c.send({ type: 'hello', clientId: 'it-1', surface: 'screen', capabilities: ['viewer'] });
    expect(await c.wait('welcome')).toMatchObject({ agent: 'scripted', ha: 'mock', transcribe: true, status: 'idle' });

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
    c.send({ type: 'hello', clientId: 'it-2', surface: 'screen', capabilities: ['viewer'] });
    await c.wait('welcome');
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
    c.send({ type: 'hello', clientId: 'it-3', surface: 'speaker', capabilities: [] });
    await c.wait('welcome');
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
    c.send({ type: 'hello', clientId: 'it-4', surface: 'screen', capabilities: ['viewer'] });
    await c.wait('welcome');
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

  it('malformed messages get an error and the connection stays up', async () => {
    const c = await client();
    c.ws.send('{nope');
    c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    await c.wait('error', (m) => m.message === 'not JSON');
    await c.wait('error', (m) => m.message === 'text messages only');
    c.send({ type: 'hello', clientId: 'it-5', surface: 'screen', capabilities: [] });
    await c.wait('welcome');
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
    expect(await status(`ws://${base}/ws`)).toBe(101); // no Origin: not a browser
  });

  it('POST /transcribe forwards the audio to the STT server and returns its text', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(2048)], { type: 'audio/webm;codecs=opus' }), 'a.webm');
    const r = await fetch(`http://${base}/transcribe`, { method: 'POST', body: form });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: 'turn on the hall light' });
    const seen = sttSeen.at(-1)!;
    expect(seen.auth).toBe('Bearer stt-key');
    expect(seen.type).toMatch(/^multipart\/form-data/);
    expect(seen.body).toContain('name="model"\r\n\r\nsmall');

    const bad = new FormData();
    bad.append('file', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
    expect((await fetch(`http://${base}/transcribe`, { method: 'POST', body: bad })).status).toBe(415);
    expect((await fetch(`http://${base}/transcribe`, { method: 'POST', body: 'x' })).status).toBe(415);
    expect((await fetch(`http://${base}/transcribe`)).status).toBe(405);
  });

  it('POST /transcribe from another origin is refused (a web page must not spend the STT credit)', async () => {
    const n = sttSeen.length;
    const post = (origin: string) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(2048)], { type: 'audio/webm' }), 'a.webm');
      return fetch(`http://${base}/transcribe`, { method: 'POST', body: form, headers: { origin } });
    };
    const r = await post('http://evil.example');
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'this origin may not use the assistant' });
    expect((await post('http://jarvis.test:8080')).status).toBe(403); // exact: scheme, host and port
    expect(sttSeen.length).toBe(n);
    expect((await post(ORIGIN)).status).toBe(200);
  });

  it('an upload over the cap gets its 413 before the connection closes', async () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    const form = new FormData();
    form.append('file', new Blob([big], { type: 'audio/webm' }), 'a.webm');
    const r = await fetch(`http://${base}/transcribe`, { method: 'POST', body: form });
    expect(r.status).toBe(413);
    expect(r.headers.get('connection')).toBe('close');
    expect(((await r.json()) as { error: string }).error).toMatch(/the upload is over 10 MB/);
  });
});

describe('the Origin check', () => {
  it('a list is exact; an empty list (loopback binds only) means the request’s own host', () => {
    expect(originAllowed(undefined, 'x', ['https://a.example'])).toBe(true); // not a browser
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
