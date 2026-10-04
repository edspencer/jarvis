// Who is talking (design §2.3). Every connection's `hello` carries a credential, checked here before the hub lets it
// in; there is no anonymous mode. JARVIS_ASSISTANT_AUTH names the kinds the server takes:
//   - `secret`: an access code from the clients file (JARVIS_ASSISTANT_CLIENTS). The code is `<name>:<random>`; the
//     file holds only its SHA-256, compared in constant time. Each client has a fixed surface (screen / speaker);
//   - `ha`: the person's own Home Assistant access token, which the HA backend checks (auth/current_user) and which is
//     never stored. The surface comes from JARVIS_ASSISTANT_HA_SURFACE, or the clients file's ha_users.
// The surface never comes from the client: a speaker's credential gets the speaker's policy whatever it claims.
// Failed logins are rate-limited per remote address (behind a trusted proxy, the client's: clientAddress): an access
// code is checked first (cheap) and the limit applies only when it is wrong, so a guessing script can't lock a valid
// code out; an HA token takes a token of the limit before its (remote, slow) check, so concurrent tries can't slip
// past it, and HA checks are capped per address and in all. "Couldn't check" (HA down) is 4503, retried by the client;
// 4401 is a definite no. A successful hello gets a ticket (random, short-lived, bound to that user and connection) for
// POST /transcribe, which has no socket to authenticate. Logged-in users are checked again (recheck) when the clients
// file is reloaded and, for HA logins, every few minutes (core/hub.ts).
// Pure: the clients file arrives parsed (the server reads the YAML), the HA check is a function, the clock injectable.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
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
  const hashes = new Map<string, number>();
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
    else if (hashes.has(hash.toLowerCase()))
      problems.push(`${where}: the same secret_sha256 as clients[${hashes.get(hash.toLowerCase())}] (a copied line?)`);
    else hashes.set(hash.toLowerCase(), i);
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

/** what to say at start-up about ha_users: entries matched by name (names aren't unique in Home Assistant), and an
 * empty list when only listed users may log in */
export function haUserWarnings(c: ClientsFile, haUsersOnly: boolean): string[] {
  const out: string[] = [];
  const byName = c.haUsers.filter((u) => u.name !== undefined).map((u) => u.name!);
  if (byName.length)
    out.push(
      `auth: ha_users matches ${byName.join(', ')} by name; Home Assistant names aren't unique (anyone renamed to ` +
        "that name gets that entry), so list people by id (Settings > People > Users, or the panel's user id)",
    );
  if (haUsersOnly && !c.haUsers.length)
    out.push(
      'auth: JARVIS_ASSISTANT_HA_USERS_ONLY is on and the clients file lists no ha_users, so no Home Assistant login ' +
        'works (list people under ha_users, or set JARVIS_ASSISTANT_HA_USERS_ONLY=false)',
    );
  return out;
}

/** `::ffff:10.0.0.7` → `10.0.0.7` */
export const plainIp = (a: string) => a.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');

/** The address a connection counts as (the failed-login limit, the unauthenticated-connection caps): the TCP peer, or,
 * only when the peer is one of the trusted proxies (JARVIS_ASSISTANT_TRUSTED_PROXY), the right-most address in
 * X-Forwarded-For that isn't one of them: the part left of it is whatever the client chose to send. */
export function clientAddress(
  peer: string | undefined,
  forwarded: string | string[] | undefined,
  trusted: readonly string[],
): string {
  const p = plainIp(peer ?? '') || 'unknown';
  if (!forwarded || !trusted.includes(p)) return p;
  const hops = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded).split(',').map(plainIp);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (trusted.includes(hops[i])) continue;
    return isIP(hops[i]) ? hops[i] : p; // (garbage there: a misconfigured proxy; the proxy's own address then)
  }
  return p;
}

// ------------------------------------------------------------------------------------------------ the check

/** close codes: a definite no (the client waits for another credential), too many tries from this address, and
 * "couldn't check right now" (Home Assistant down or busy: the client retries with its backoff) */
export const CLOSE_UNAUTHORISED = 4401;
export const CLOSE_TOO_MANY = 4429;
export const CLOSE_RETRY = 4503;
export type RefusalCode = typeof CLOSE_UNAUTHORISED | typeof CLOSE_TOO_MANY | typeof CLOSE_RETRY;

export type AuthResult = { ok: true; user: AuthUser } | { ok: false; reason: string; code: RefusalCode };

/** a logged-in user checked again: still allowed, allowed but with another surface now, refused, or couldn't tell */
export type Recheck = 'ok' | 'changed' | 'refused' | 'unknown';

export interface Authenticator {
  /** check a hello's credential from `remote` (the client's address, clientAddress) */
  verify(auth: unknown, remote: string): Promise<AuthResult>;
  /** check a logged-in user's credential again: an HA token with Home Assistant, an access code with the clients file */
  recheck(user: AuthUser, auth: HelloAuth): Promise<Recheck>;
  /** the same against the clients file only (an HA login by the identity it logged in as; no Home Assistant call) */
  recheckLocal(user: AuthUser, auth: HelloAuth): Exclude<Recheck, 'unknown'>;
  /** the clients file was reloaded */
  setClients(c: ClientsFile): void;
}

export interface AuthenticatorOptions {
  kinds: readonly AuthKind[];
  clients: ClientsFile;
  /** the surface of an HA-authenticated person without an ha_users entry (JARVIS_ASSISTANT_HA_USERS_ONLY=false) */
  haSurface: Surface;
  /** only HA users listed in ha_users may log in (default true) */
  haUsersOnly?: boolean;
  /** the HA backend's currentUser: who the token belongs to, null if HA refuses it (throws: HA unreachable) */
  currentUser?: (token: string) => Promise<HaIdentity | null>;
  /** failed logins per remote address before it is refused without a check (default 5 at once, 5 a minute) */
  failures?: Rate;
  /** HA checks under way at once, per address and in all (default 2 and 4) */
  haChecks?: { perAddress: number; total: number };
  now?: () => number;
  log?: (msg: string) => void;
}

export const NOT_AUTHORISED = 'not authorised';
export const TOO_MANY = 'too many failed attempts; try again in a minute';
const MAX_CREDENTIAL = 4096;

export function createAuthenticator(o: AuthenticatorOptions): Authenticator {
  const log = o.log ?? (() => {});
  const failures: RateLimiter = createRateLimiter(o.failures ?? { burst: 5, perMinute: 5 }, o.now);
  const haOnly = o.haUsersOnly ?? true;
  const cap = o.haChecks ?? { perAddress: 2, total: 4 };
  let clients = o.clients;
  /** each client with its hash as bytes, ready to compare */
  let byName = new Map<string, { c: ClientCredential; hash: Buffer }>();
  const setClients = (f: ClientsFile) => {
    clients = f;
    byName = new Map(f.clients.map((c) => [c.name, { c, hash: Buffer.from(c.secretSha256, 'hex') }]));
  };
  setClients(o.clients);
  const dummy = randomBytes(32);
  /** HA checks under way: per address, and in all */
  const inflight = new Map<string, number>();
  let checks = 0;

  const tooMany = (remote: string): AuthResult => {
    log(`auth: ${remote} has failed too often; refused unchecked`);
    return { ok: false, reason: TOO_MANY, code: CLOSE_TOO_MANY };
  };
  /** a failed login, counted against the address (`counted`: its token was taken before the check) */
  const refuse = (remote: string, why: string, counted = false): AuthResult => {
    if (!counted && !failures.take(remote)) return tooMany(remote);
    log(`auth: refused ${remote}: ${why}`);
    return { ok: false, reason: NOT_AUTHORISED, code: CLOSE_UNAUTHORISED };
  };

  function secret(code: string): ClientCredential | null {
    const i = code.indexOf(':');
    const hit = byName.get(i > 0 ? code.slice(0, i) : '');
    const got = createHash('sha256').update(code, 'utf8').digest();
    // the same work whether or not the name exists
    const same = timingSafeEqual(got, hit ? hit.hash : dummy);
    return hit && same ? hit.c : null;
  }
  const secretOf = (a: HelloAuth) =>
    a.type === 'secret' && typeof a.secret === 'string' && a.secret && a.secret.length <= MAX_CREDENTIAL
      ? secret(a.secret)
      : null;

  /** the user an HA identity logs in as (its ha_users entry: by id, else by name), or why not */
  function haUser(who: { id: string; name: string }): AuthUser | string {
    const entry =
      clients.haUsers.find((u) => u.id !== undefined && u.id === who.id) ??
      clients.haUsers.find((u) => u.name !== undefined && u.name === who.name);
    if (haOnly && !entry) return `Home Assistant user ${who.id} is not on ha_users`;
    const name = who.name.slice(0, 100) || who.id;
    return { key: `ha:${who.id}`, name, via: 'ha', surface: entry?.surface ?? o.haSurface };
  }
  const odd = (who: HaIdentity) => typeof who.id !== 'string' || !HA_ID.test(who.id) || typeof who.name !== 'string';

  /** ask Home Assistant, counting the check under way */
  async function ask(token: string, remote: string): Promise<HaIdentity | null> {
    inflight.set(remote, (inflight.get(remote) ?? 0) + 1);
    checks++;
    try {
      return await o.currentUser!(token);
    } finally {
      checks--;
      const n = inflight.get(remote)! - 1;
      if (n) inflight.set(remote, n);
      else inflight.delete(remote);
    }
  }

  const recheckLocal = (user: AuthUser, auth: HelloAuth): Exclude<Recheck, 'unknown'> => {
    if (user.via === 'secret') {
      const c = secretOf(auth);
      if (!c || `secret:${c.name}` !== user.key) return 'refused';
      return c.surface === user.surface ? 'ok' : 'changed';
    }
    const u = haUser({ id: user.key.slice('ha:'.length), name: user.name });
    if (typeof u === 'string') return 'refused';
    return u.surface === user.surface ? 'ok' : 'changed';
  };

  return {
    async verify(auth, remote) {
      const a = auth as HelloAuth | undefined;
      if (!isObj(a) || (a.type !== 'secret' && a.type !== 'ha')) return refuse(remote, 'no credential');
      if (!o.kinds.includes(a.type)) return refuse(remote, `${a.type} credentials are not enabled`);
      if (a.type === 'secret') {
        // cheap and local: the code first, so a right one gets in even while guesses from its address are limited
        const c = secretOf(a);
        return c
          ? { ok: true, user: { key: `secret:${c.name}`, name: c.name, via: 'secret', surface: c.surface } }
          : refuse(remote, 'wrong access code');
      }
      if (typeof a.token !== 'string' || !a.token || a.token.length > MAX_CREDENTIAL)
        return refuse(remote, 'no Home Assistant token');
      if (!o.currentUser) return refuse(remote, 'no Home Assistant to check the token with');
      // expensive and remote: the limit first, its token taken before the check (given back if the login is good),
      // so a burst of concurrent tries can't all reach Home Assistant
      if (!failures.take(remote)) return tooMany(remote);
      if ((inflight.get(remote) ?? 0) >= cap.perAddress || checks >= cap.total) {
        failures.refund(remote); // (nothing was checked)
        const mine = (inflight.get(remote) ?? 0) >= cap.perAddress;
        log(`auth: ${mine ? `${remote} has too many logins under way` : 'too many Home Assistant checks under way'}`);
        return mine
          ? { ok: false, reason: 'too many logins at once; try again in a moment', code: CLOSE_TOO_MANY }
          : { ok: false, reason: 'busy; try again in a moment', code: CLOSE_RETRY };
      }
      let who: HaIdentity | null;
      try {
        who = await ask(a.token, remote);
      } catch (e) {
        // Home Assistant unreachable: retryable for the client (it may well be allowed), but still counted against
        // the address, so retries can't hammer Home Assistant
        log(`auth: couldn't check a Home Assistant token: ${(e as Error).message}`);
        return { ok: false, reason: 'Home Assistant could not check the login; trying again', code: CLOSE_RETRY };
      }
      if (!who) return refuse(remote, 'Home Assistant refused the token', true);
      if (odd(who)) return refuse(remote, 'Home Assistant gave an odd user', true);
      const user = haUser(who);
      if (typeof user === 'string') return refuse(remote, user, true);
      failures.refund(remote);
      return { ok: true, user };
    },

    async recheck(user, auth) {
      if (user.via === 'secret' || auth.type !== 'ha') return recheckLocal(user, auth);
      if (!o.currentUser || checks >= cap.total) return 'unknown';
      let who: HaIdentity | null;
      try {
        who = await ask(auth.token, `recheck:${user.key}`);
      } catch {
        return 'unknown';
      }
      if (!who || odd(who) || `ha:${who.id}` !== user.key) return 'refused';
      const u = haUser(who);
      if (typeof u === 'string') return 'refused';
      return u.surface === user.surface ? 'ok' : 'changed';
    },

    recheckLocal,
    setClients,
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
  /** a new ticket for a connection (`holder`); the holder's previous one stays valid until it expires, older ones die */
  issue(holder: object, info: TicketInfo): string;
  /** the ticket's user, or null: unknown, expired or its connection closed */
  check(ticket: unknown): TicketInfo | null;
  /** the connection closed: its tickets die */
  revoke(holder: object): void;
}

export const TICKET_TTL_MS = 10 * 60_000;
/** live tickets per connection: the current one and the one before (an upload already under way) */
const TICKETS_PER_HOLDER = 2;

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
      // the oldest go (a Set keeps the order they were issued in)
      for (const h of [...mine].slice(0, Math.max(0, mine.size - TICKETS_PER_HOLDER + 1))) drop(h);
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
