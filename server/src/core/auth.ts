// Who is talking (design §2.3). Every connection's `hello` carries a credential, checked here before the hub lets it
// in; there is no anonymous mode. JARVIS_ASSISTANT_AUTH names the kinds the server takes:
//   - `secret`: an access code from the clients file (JARVIS_ASSISTANT_CLIENTS). The code is `<name>:<random>`; the
//     file holds only its SHA-256, compared in constant time. Each client has a fixed surface (screen / speaker);
//   - `ha`: the person's own Home Assistant access token, which the HA backend checks (auth/current_user) and which is
//     never stored. The surface comes from JARVIS_ASSISTANT_HA_SURFACE, or the clients file's ha_users.
// The surface never comes from the client: a speaker's credential gets the speaker's policy whatever it claims.
// Failed logins are rate-limited per remote address. A successful hello gets a ticket (random, short-lived, bound to
// that user and connection) for POST /transcribe, which has no socket to authenticate.
// Pure: the clients file arrives parsed (the server reads the YAML), the HA check is a function, the clock injectable.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { HelloAuth, Surface } from './protocol.ts';
import { createRateLimiter, type Rate, type RateLimiter } from './limits.ts';

export type AuthKind = 'ha' | 'secret';
export const AUTH_KINDS: readonly AuthKind[] = ['ha', 'secret'];

/** a person or device the server let in */
export interface AuthUser {
  /** unique and stable: `secret:<name>` or `ha:<user id>` (never contains '/') */
  key: string;
  /** shown in the panel and written to the audit log */
  name: string;
  via: AuthKind;
  /** from the server's configuration, never from the client */
  surface: Surface;
}

export interface ClientCredential {
  name: string;
  /** lower-case hex SHA-256 of the access code `<name>:<secret>` */
  secretSha256: string;
  surface: Surface;
}

/** a surface for one Home Assistant user, by id or by name */
export interface HaUserSurface {
  id?: string;
  name?: string;
  surface: Surface;
}

export interface ClientsFile {
  clients: ClientCredential[];
  haUsers: HaUserSurface[];
}

/** who an HA token belongs to (HaBackend.currentUser) */
export interface HaIdentity {
  id: string;
  name: string;
  is_admin: boolean;
}

export const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const HA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SURFACES: readonly Surface[] = ['screen', 'speaker'];

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** a fresh access code for `name` and the clients-file entry that goes with it (tools/new-client-secret.ts) */
export function newClientSecret(name: string, surface: Surface = 'screen'): { code: string; entry: ClientCredential } {
  if (!NAME_RE.test(name)) throw new Error(`a client name is 1-64 of A-Z a-z 0-9 . _ -, not ${JSON.stringify(name)}`);
  const code = `${name}:${randomBytes(24).toString('base64url')}`;
  return { code, entry: { name, secretSha256: sha256Hex(code), surface } };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Validate the clients file (already parsed from YAML or JSON); throws listing every problem. An empty file is
 * allowed (no secret clients, no per-user surfaces). */
export function parseClientsFile(raw: unknown, source = 'the clients file'): ClientsFile {
  const problems: string[] = [];
  const out: ClientsFile = { clients: [], haUsers: [] };
  if (raw === null || raw === undefined) return out;
  if (!isObj(raw)) throw new Error(`${source}: must be a mapping with clients and/or ha_users`);
  for (const k of Object.keys(raw))
    if (k !== 'clients' && k !== 'ha_users') problems.push(`unknown key ${k} (clients, ha_users)`);
  const list = (k: string): unknown[] => {
    const v = raw[k];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
      problems.push(`${k} must be a list`);
      return [];
    }
    return v;
  };
  const surfaceOf = (where: string, v: unknown): Surface | null => {
    if (SURFACES.includes(v as Surface)) return v as Surface;
    problems.push(`${where}: surface is required: screen or speaker${v === undefined ? '' : `, not ${String(v)}`}`);
    return null;
  };

  const names = new Set<string>();
  list('clients').forEach((c, i) => {
    const where = `clients[${i}]`;
    if (!isObj(c)) return void problems.push(`${where}: must be a mapping { name, secret_sha256, surface }`);
    for (const k of Object.keys(c))
      if (!['name', 'secret_sha256', 'surface'].includes(k)) problems.push(`${where}: unknown key ${k}`);
    const name = c.name;
    if (typeof name !== 'string' || !NAME_RE.test(name))
      problems.push(`${where}: name must be 1-64 of A-Z a-z 0-9 . _ -`);
    else if (names.has(name)) problems.push(`${where}: the name ${name} is used twice`);
    else names.add(name);
    const hash = c.secret_sha256;
    if (typeof hash !== 'string' || !HEX64.test(hash))
      problems.push(`${where}: secret_sha256 must be 64 hex digits (the SHA-256 of the access code, never the code)`);
    const surface = surfaceOf(where, c.surface);
    if (typeof name === 'string' && typeof hash === 'string' && HEX64.test(hash) && surface)
      out.clients.push({ name, secretSha256: hash.toLowerCase(), surface });
  });

  const seen = new Set<string>();
  list('ha_users').forEach((u, i) => {
    const where = `ha_users[${i}]`;
    if (!isObj(u)) return void problems.push(`${where}: must be a mapping { id or name, surface }`);
    for (const k of Object.keys(u))
      if (!['id', 'name', 'surface'].includes(k)) problems.push(`${where}: unknown key ${k}`);
    const has = (k: string) => typeof u[k] === 'string' && (u[k] as string).length > 0;
    if (has('id') === has('name')) return void problems.push(`${where}: give exactly one of id or name`);
    const key = has('id') ? `id:${u.id as string}` : `name:${u.name as string}`;
    if (seen.has(key)) problems.push(`${where}: ${key.replace(':', ' ')} is listed twice`);
    seen.add(key);
    const surface = surfaceOf(where, u.surface);
    if (surface) out.haUsers.push({ ...(has('id') ? { id: u.id as string } : { name: u.name as string }), surface });
  });

  if (problems.length) throw new Error(`${source}:\n  - ${problems.join('\n  - ')}`);
  return out;
}

// ------------------------------------------------------------------------------------------------ the check

export type AuthResult = { ok: true; user: AuthUser } | { ok: false; reason: string; code: 4401 | 4429 };

export interface Authenticator {
  /** check a hello's credential from `remote` (the peer address) */
  verify(auth: unknown, remote: string): Promise<AuthResult>;
}

export interface AuthenticatorOptions {
  kinds: readonly AuthKind[];
  clients: ClientsFile;
  /** the surface of an HA-authenticated person without an ha_users entry */
  haSurface: Surface;
  /** the HA backend's currentUser: who the token belongs to, null if HA refuses it (throws: HA unreachable) */
  currentUser?: (token: string) => Promise<HaIdentity | null>;
  /** failed logins per remote address before it is refused without a check (default 5 at once, 5 a minute) */
  failures?: Rate;
  now?: () => number;
  log?: (msg: string) => void;
}

export const NOT_AUTHORISED = 'not authorised';
const MAX_CREDENTIAL = 4096;

export function createAuthenticator(o: AuthenticatorOptions): Authenticator {
  const log = o.log ?? (() => {});
  const failures: RateLimiter = createRateLimiter(o.failures ?? { burst: 5, perMinute: 5 }, o.now);
  const byName = new Map(o.clients.clients.map((c) => [c.name, c]));
  const dummy = Buffer.alloc(32);

  const refuse = (remote: string, why: string): AuthResult => {
    failures.take(remote);
    log(`auth: refused ${remote}: ${why}`);
    return { ok: false, reason: NOT_AUTHORISED, code: 4401 };
  };

  function secret(code: string): AuthUser | null {
    const name = code.slice(0, Math.max(0, code.indexOf(':')));
    const c = byName.get(name);
    const got = createHash('sha256').update(code, 'utf8').digest();
    // the same work whether or not the name exists
    const want = c ? Buffer.from(c.secretSha256, 'hex') : dummy;
    const same = timingSafeEqual(got, want);
    return c && same ? { key: `secret:${c.name}`, name: c.name, via: 'secret', surface: c.surface } : null;
  }

  function haSurface(who: HaIdentity): Surface {
    const hit =
      o.clients.haUsers.find((u) => u.id !== undefined && u.id === who.id) ??
      o.clients.haUsers.find((u) => u.name !== undefined && u.name === who.name);
    return hit?.surface ?? o.haSurface;
  }

  return {
    async verify(auth, remote) {
      if (!failures.has(remote)) {
        log(`auth: ${remote} has failed too often; refused unchecked`);
        return { ok: false, reason: 'too many failed attempts; try again in a minute', code: 4429 };
      }
      const a = auth as HelloAuth | undefined;
      if (!isObj(a) || (a.type !== 'secret' && a.type !== 'ha')) return refuse(remote, 'no credential');
      if (!o.kinds.includes(a.type)) return refuse(remote, `${a.type} credentials are not enabled`);
      if (a.type === 'secret') {
        if (typeof a.secret !== 'string' || !a.secret || a.secret.length > MAX_CREDENTIAL)
          return refuse(remote, 'no access code');
        const user = secret(a.secret);
        return user ? { ok: true, user } : refuse(remote, 'wrong access code');
      }
      if (typeof a.token !== 'string' || !a.token || a.token.length > MAX_CREDENTIAL)
        return refuse(remote, 'no Home Assistant token');
      if (!o.currentUser) return refuse(remote, 'no Home Assistant to check the token with');
      let who: HaIdentity | null;
      try {
        who = await o.currentUser(a.token);
      } catch (e) {
        // HA unreachable: not the client's fault, so not counted against its address
        log(`auth: couldn't check a Home Assistant token: ${(e as Error).message}`);
        return { ok: false, reason: `${NOT_AUTHORISED} (Home Assistant could not check the login)`, code: 4401 };
      }
      if (!who) return refuse(remote, 'Home Assistant refused the token');
      if (typeof who.id !== 'string' || !HA_ID.test(who.id) || typeof who.name !== 'string')
        return refuse(remote, 'Home Assistant gave an odd user');
      const name = who.name.slice(0, 100) || who.id;
      return { ok: true, user: { key: `ha:${who.id}`, name, via: 'ha', surface: haSurface(who) } };
    },
  };
}

// ------------------------------------------------------------------------------------------------ tickets

/** what a ticket stands for */
export interface TicketInfo {
  user: AuthUser;
  /** the hub's owner key (user and client id) */
  owner: string;
}

export interface TicketStore {
  /** a new ticket for a connection (`holder`); the holder's older ones stay valid until they expire */
  issue(holder: object, info: TicketInfo): string;
  /** the ticket's user, or null: unknown, expired or its connection closed */
  check(ticket: unknown): TicketInfo | null;
  /** the connection closed: its tickets die */
  revoke(holder: object): void;
}

export const TICKET_TTL_MS = 10 * 60_000;

export function createTicketStore(opts: { ttlMs?: number; now?: () => number; newToken?: () => string } = {}) {
  const ttl = opts.ttlMs ?? TICKET_TTL_MS;
  const now = opts.now ?? Date.now;
  const newToken = opts.newToken ?? (() => randomBytes(32).toString('base64url'));
  // by the ticket's hash, so a lookup's timing says nothing useful about a guess
  const live = new Map<string, TicketInfo & { holder: object; expiresAt: number }>();
  const byHolder = new Map<object, Set<string>>();

  const drop = (h: string) => {
    const t = live.get(h);
    if (!t) return;
    live.delete(h);
    byHolder.get(t.holder)?.delete(h);
  };

  const store: TicketStore & { readonly size: number } = {
    issue(holder, info) {
      const mine = byHolder.get(holder) ?? new Set<string>();
      byHolder.set(holder, mine);
      for (const h of [...mine]) if (live.get(h)!.expiresAt <= now()) drop(h);
      const ticket = newToken();
      const h = sha256Hex(ticket);
      live.set(h, { ...info, holder, expiresAt: now() + ttl });
      mine.add(h);
      return ticket;
    },
    check(ticket) {
      if (typeof ticket !== 'string' || !ticket || ticket.length > 200) return null;
      const h = sha256Hex(ticket);
      const t = live.get(h);
      if (!t) return null;
      if (t.expiresAt <= now()) {
        drop(h);
        return null;
      }
      return { user: t.user, owner: t.owner };
    },
    revoke(holder) {
      for (const h of byHolder.get(holder) ?? []) live.delete(h);
      byHolder.delete(holder);
    },
    get size() {
      return live.size;
    },
  };
  return store;
}

/** the ticket from an `Authorization: Bearer <ticket>` header */
export function bearer(header: string | undefined): string | null {
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header?.trim() ?? '');
  return m ? m[1] : null;
}
