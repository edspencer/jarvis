// The assistant's HTTP face: GET {base}/health, the WebSocket at {base}/ws (the hub's transport) and
// POST {base}/transcribe (audio → text, design §2.2). Plain node:http plus `ws`; no framework.
//
// LAN-only stance (design §2.3): it binds 127.0.0.1 by default and is meant to sit behind the site's reverse proxy at
// /assistant/*, same origin as the viewer (no CORS; the HTTPS the microphone needs is already there), with the proxy
// refusing non-LAN clients. On the socket and on /transcribe an `Origin` header is required and must be on
// JARVIS_ASSISTANT_ORIGINS (exactly: scheme, host and port); a request without one is refused, so a client that isn't a
// browser (a satellite bridge, a script) sends an allowed Origin itself. Only a loopback bind may leave that list
// empty, and then the request's own Host must match: off loopback a DNS-rebinding page would send a matching Host
// itself, so config.ts insists on the list.
// The Origin only says which page is asking; who is asking is the hello's credential (core/auth.ts, checked by the hub
// before anything else) and, for /transcribe, the ticket that hello earned (`Authorization: Bearer <ticket>`). Both
// are rate-limited per user, and failed logins per remote address.
// TODO(open question 4: where the server runs): next to the static site or on an agent host; the proxy config
// examples follow from that.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SttConfig } from './core/config.ts';
import { bearer } from './core/auth.ts';
import type { Conn, Hub } from './core/hub.ts';
import type { RateLimiter } from './core/limits.ts';
import { MAX_AUDIO_BYTES, TranscribeError, transcribe as transcribeAudio } from './core/transcribe.ts';

/** the WebSocket's max message (a `say` is at most a few KB) */
export const MAX_WS_PAYLOAD = 64 * 1024;

/** a hub Conn over a WebSocket, with the upgrade request kept */
export interface WsConn extends Conn {
  readonly request: IncomingMessage;
}

export interface ServerOptions {
  host: string;
  port: number;
  base: string;
  origins: string[];
  stt: SttConfig | null;
  hub: Hub;
  /** POST /transcribe per user (none: unlimited) */
  transcribeLimit?: RateLimiter;
  health: () => Record<string, unknown>;
  /** tests: the fetch the transcription proxy uses */
  fetchImpl?: typeof fetch;
  /** ms between WebSocket pings (default 30 s) */
  pingMs?: number;
  log?: (msg: string) => void;
}

/** the host names a loopback-only server's own pages may use */
const LOOPBACK_NAME = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/** may a page at `origin` use the socket or /transcribe? No Origin: no. (`allowed` empty: only on a loopback bind,
 * config.ts) */
export function originAllowed(origin: string | undefined, host: string | undefined, allowed: string[]): boolean {
  if (!origin) return false; // every client sends one: browsers do, anything else must
  if (allowed.length) return allowed.includes(origin);
  // no list (loopback only, config.ts enforces that): the page must come from this machine by a loopback name, so a
  // DNS-rebinding page (evil.example resolving to 127.0.0.1: Origin and Host both say evil.example) is refused too
  try {
    const u = new URL(origin);
    return !!host && u.host === host && LOOPBACK_NAME.test(u.hostname);
  } catch {
    return false;
  }
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(s),
  });
  res.end(s);
};

/** the request body, refusing more than `max` bytes (the rest is read and dropped, so the 413 can be sent first) */
function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      if (size > max) return;
      size += c.length;
      if (size > max) {
        chunks.length = 0;
        reject(new TranscribeError(413, `the upload is over ${Math.round(max / 1048576)} MB`));
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createAssistantServer(o: ServerOptions) {
  const log = o.log ?? ((m: string) => console.error(m));
  const path = (p: string) => `${o.base}${p}`;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  const alive = new WeakMap<WebSocket, boolean>();

  /** answer a request whose body we won't read: the response first, then the connection goes */
  function refuseUpload(req: IncomingMessage, res: ServerResponse, status: number, error: string) {
    res.setHeader('connection', 'close');
    json(res, status, { error });
    // the client may still be sending; give it a moment to read the answer, then close whatever is left
    res.once('finish', () => {
      if (req.complete) return;
      req.resume();
      setTimeout(() => req.socket.destroy(), 2000).unref();
    });
  }

  async function onTranscribe(req: IncomingMessage, res: ServerResponse) {
    if (!originAllowed(req.headers.origin, req.headers.host, o.origins)) {
      log(`transcribe: refused origin ${req.headers.origin ?? '(none)'}`);
      return refuseUpload(req, res, 403, 'this origin may not use the assistant');
    }
    // the ticket a logged-in connection got in its welcome: no ticket, no transcription
    const t = o.hub.ticket(bearer(req.headers.authorization));
    if (!t) {
      res.setHeader('www-authenticate', 'Bearer');
      return refuseUpload(req, res, 401, 'not authorised: send the ticket from welcome as Authorization: Bearer');
    }
    if (o.transcribeLimit && !o.transcribeLimit.take(t.user.key))
      return refuseUpload(req, res, 429, 'slow down: too many recordings; try again in a moment');
    if (!o.stt) return json(res, 503, { error: 'transcription is not configured (JARVIS_STT_URL)' });
    const type = String(req.headers['content-type'] ?? '');
    if (!type.startsWith('multipart/form-data'))
      return json(res, 415, { error: 'send multipart/form-data with a file' });
    try {
      const body = await readBody(req, MAX_AUDIO_BYTES + 64 * 1024);
      const form = await new Request('http://local/', {
        method: 'POST',
        headers: { 'content-type': type },
        body,
      }).formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') return json(res, 400, { error: 'no file in the form' });
      const r = await transcribeAudio(file, o.stt, o.fetchImpl);
      json(res, 200, r);
    } catch (e) {
      if (e instanceof TranscribeError && e.status === 413) return refuseUpload(req, res, 413, e.message);
      if (e instanceof TranscribeError) return json(res, e.status, { error: e.message });
      log(`transcribe: ${(e as Error).message}`);
      json(res, 400, { error: 'could not read the upload' });
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === path('/health')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' });
      return json(res, 200, { ok: true, ...o.health() });
    }
    if (url.pathname === path('/transcribe')) {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      return void onTranscribe(req, res);
    }
    json(res, 404, { error: 'not found' });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const refuse = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== path('/ws')) return refuse('404 Not Found');
    if (!originAllowed(req.headers.origin, req.headers.host, o.origins)) {
      log(`ws: refused origin ${req.headers.origin ?? '(none)'}`);
      return refuse('403 Forbidden');
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: WsConn = {
        request: req,
        remote: req.socket.remoteAddress ?? 'unknown',
        send(m) {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
        },
        close(code = 1000, reason) {
          ws.close(code, reason?.slice(0, 120));
        },
      };
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      ws.on('message', (data, isBinary) => {
        if (isBinary) return conn.send({ type: 'error', message: 'text messages only' });
        void o.hub.onMessage(conn, data.toString());
      });
      ws.on('close', () => o.hub.onClose(conn));
      ws.on('error', (e) => log(`ws: ${e.message}`));
    });
  });

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, o.pingMs ?? 30_000);
  ping.unref();

  return {
    server,
    listen(): Promise<AddressInfo> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.port, o.host, () => resolve(server.address() as AddressInfo));
      });
    },
    async close() {
      clearInterval(ping);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
