// Logins and limits (core/auth.ts, core/limits.ts): the clients file's strict validation, access codes, Home Assistant
// tokens through the mock's currentUser, surfaces from the configuration, the failed-login limit, /transcribe tickets
// and the token buckets, all with an injected clock.
import { describe, expect, it } from 'vitest';
import {
  bearer,
  clientAddress,
  createAuthenticator,
  haUserWarnings,
  createTicketStore,
  newClientSecret,
  parseClientsFile,
  sha256Hex,
  type AuthenticatorOptions,
  type AuthResult,
  type ClientsFile,
} from '../src/core/auth.ts';
import { mockCurrentUser } from '../src/core/ha-mock.ts';
import { createRateLimiter, parseRate } from '../src/core/limits.ts';

const HASH = sha256Hex('tablet:s3cret');

describe('the clients file', () => {
  it('takes clients and ha_users, normalising the hashes', () => {
    expect(
      parseClientsFile({
        clients: [
          { name: 'tablet', secret_sha256: HASH.toUpperCase(), surface: 'screen' },
          { name: 'kitchen.speaker', secret_sha256: sha256Hex('x'), surface: 'speaker' },
        ],
        ha_users: [
          { name: 'Ed', surface: 'screen' },
          { id: 'abc123', surface: 'speaker' },
        ],
      }),
    ).toEqual({
      clients: [
        { name: 'tablet', secretSha256: HASH, surface: 'screen' },
        { name: 'kitchen.speaker', secretSha256: sha256Hex('x'), surface: 'speaker' },
      ],
      haUsers: [
        { name: 'Ed', surface: 'screen' },
        { id: 'abc123', surface: 'speaker' },
      ],
    });
    expect(parseClientsFile(null)).toEqual({ clients: [], haUsers: [] });
    expect(parseClientsFile({ clients: [] })).toEqual({ clients: [], haUsers: [] });
  });

  it('is strict, and lists every problem', () => {
    const bad = () =>
      parseClientsFile(
        {
          clients: [
            { name: 'a', secret_sha256: HASH, surface: 'screen' },
            { name: 'a', secret_sha256: HASH, surface: 'screen' }, // twice
            { name: 'b', secret_sha256: 's3cret', surface: 'screen' }, // not a hash
            { name: 'c', secret_sha256: HASH }, // no surface
            { name: 'd e', secret_sha256: HASH, surface: 'tv' },
            { name: 'f', secret_sha256: HASH, surface: 'screen', admin: true },
            'g',
          ],
          ha_users: [{ surface: 'screen' }, { id: 'x', name: 'y', surface: 'screen' }, { name: 'Ed' }],
          extra: 1,
        },
        'clients.yaml',
      );
    expect(bad).toThrow(/^clients\.yaml:/);
    let msg = '';
    try {
      bad();
    } catch (e) {
      msg = (e as Error).message;
    }
    for (const p of [
      'unknown key extra',
      'clients[1]: the name a is used twice',
      'clients[2]: secret_sha256 must be 64 hex digits',
      'clients[3]: surface is required',
      'clients[4]: name must be',
      'clients[4]: surface is required: screen or speaker, not tv',
      'clients[5]: unknown key admin',
      'clients[6]: must be a mapping',
      'ha_users[0]: give exactly one of id or name',
      'ha_users[1]: give exactly one of id or name',
      'ha_users[2]: surface is required',
    ])
      expect(msg).toContain(p);
    expect(() => parseClientsFile([])).toThrow(/must be a mapping/);
    expect(() => parseClientsFile({ clients: {} })).toThrow(/clients must be a list/);
  });

  it('flags the same hash twice (a copied line)', () => {
    expect(() =>
      parseClientsFile({
        clients: [
          { name: 'a', secret_sha256: HASH, surface: 'screen' },
          { name: 'b', secret_sha256: HASH.toUpperCase(), surface: 'speaker' },
        ],
      }),
    ).toThrow('clients[1]: the same secret_sha256 as clients[0]');
  });

  it('warns about ha_users matched by name, and about an empty list when only listed users may log in', () => {
    const c = parseClientsFile({
      ha_users: [
        { name: 'Guest', surface: 'speaker' },
        { id: 'abc', surface: 'screen' },
      ],
    });
    expect(haUserWarnings(c, true)).toEqual([expect.stringMatching(/matches Guest by name.*list people by id/)]);
    expect(haUserWarnings(parseClientsFile({ ha_users: [{ id: 'abc', surface: 'screen' }] }), true)).toEqual([]);
    expect(haUserWarnings(parseClientsFile(null), true)).toEqual([
      expect.stringMatching(/HA_USERS_ONLY is on and the clients file lists no ha_users, so no Home Assistant login/),
    ]);
    expect(haUserWarnings(parseClientsFile(null), false)).toEqual([]);
  });

  it('newClientSecret: a random code that hashes to its entry', () => {
    const a = newClientSecret('hall-tablet', 'speaker');
    const b = newClientSecret('hall-tablet');
    expect(a.code).toMatch(/^hall-tablet:[A-Za-z0-9_-]{32}$/);
    expect(a.code).not.toBe(b.code);
    expect(a.entry).toEqual({ name: 'hall-tablet', secretSha256: sha256Hex(a.code), surface: 'speaker' });
    expect(b.entry.surface).toBe('screen');
    expect(() => newClientSecret('two words')).toThrow(/client name/);
  });
});

describe('the authenticator', () => {
  const clients: ClientsFile = {
    clients: [
      { name: 'tablet', secretSha256: HASH, surface: 'screen' },
      { name: 'kitchen', secretSha256: sha256Hex('kitchen:k'), surface: 'speaker' },
    ],
    haUsers: [
      { id: 'mock-ana', surface: 'speaker' },
      { name: 'Bo', surface: 'screen' },
    ],
  };
  const make = (o: Partial<AuthenticatorOptions> = {}) =>
    createAuthenticator({
      kinds: ['secret', 'ha'],
      clients,
      haSurface: 'screen',
      haUsersOnly: false,
      currentUser: async (t) => mockCurrentUser(t),
      ...o,
    });
  const refused = { ok: false, reason: 'not authorised', code: 4401 };
  const tooMany = { ok: false, reason: 'too many failed attempts; try again in a minute', code: 4429 };
  const down = async (): Promise<null> => {
    throw new Error('ECONNREFUSED');
  };
  /** a currentUser that waits until released, counting the checks that reach it */
  const held = () => {
    const h = { calls: 0, release: () => {} };
    const gate = new Promise<void>((r) => (h.release = r));
    return {
      h,
      currentUser: async (t: string) => {
        h.calls++;
        await gate;
        return mockCurrentUser(t);
      },
    };
  };

  it('an access code: right → the client with its configured surface; wrong or unknown name → refused', async () => {
    const a = make();
    expect(await a.verify({ type: 'secret', secret: 'tablet:s3cret' }, 'r')).toEqual({
      ok: true,
      user: { key: 'secret:tablet', name: 'tablet', via: 'secret', surface: 'screen' },
    });
    expect(await a.verify({ type: 'secret', secret: 'kitchen:k' }, 'r')).toMatchObject({
      ok: true,
      user: { surface: 'speaker' },
    });
    for (const secret of ['tablet:wrong', 'nobody:s3cret', 's3cret', 'tablet:', ':', 'x'.repeat(5000)])
      expect(await a.verify({ type: 'secret', secret }, `r-${secret.length}`)).toEqual(refused);
  });

  it('a Home Assistant token: checked by the backend; refused, or the backend failing, means not authorised', async () => {
    const a = make({ haSurface: 'screen' });
    expect(await a.verify({ type: 'ha', token: 'mock-user:Cy' }, 'r')).toEqual({
      ok: true,
      user: { key: 'ha:mock-cy', name: 'Cy', via: 'ha', surface: 'screen' },
    });
    // per-user surfaces from the clients file, by id or by name
    expect(await a.verify({ type: 'ha', token: 'mock-user:Ana' }, 'r')).toMatchObject({ user: { surface: 'speaker' } });
    expect(await a.verify({ type: 'ha', token: 'mock-user:Bo' }, 'r')).toMatchObject({ user: { surface: 'screen' } });
    expect(await make({ haSurface: 'speaker' }).verify({ type: 'ha', token: 'mock-user:Cy' }, 'r')).toMatchObject({
      user: { surface: 'speaker' },
    });
    for (const token of ['nope', 'mock-user:', 'eyJhbGciOi.real.looking'])
      expect(await a.verify({ type: 'ha', token }, 'r2')).toEqual(refused);
    // Home Assistant down: "couldn't check right now", which the client retries (not 4401, which it doesn't)
    expect(await make({ currentUser: down }).verify({ type: 'ha', token: 'mock-user:Cy' }, 'r')).toEqual({
      ok: false,
      code: 4503,
      reason: 'Home Assistant could not check the login; trying again',
    });
    // an odd answer from HA is refused too
    const odd = make({ currentUser: async () => ({ id: 'a/b', name: 'x', is_admin: false }) });
    expect(await odd.verify({ type: 'ha', token: 't' }, 'r')).toEqual(refused);
  });

  it('only the kinds JARVIS_ASSISTANT_AUTH names; no credential at all is refused', async () => {
    const secretOnly = make({ kinds: ['secret'] });
    expect(await secretOnly.verify({ type: 'ha', token: 'mock-user:Cy' }, 'r')).toEqual(refused);
    const haOnly = make({ kinds: ['ha'] });
    expect(await haOnly.verify({ type: 'secret', secret: 'tablet:s3cret' }, 'r')).toEqual(refused);
    for (const auth of [undefined, null, 'tablet:s3cret', {}, { type: 'secret' }, { type: 'none' }])
      expect(await make().verify(auth, 'r3')).toMatchObject({ ok: false });
  });

  it('5 failures from an address, then its wrong codes and HA tokens are refused unchecked for a while', async () => {
    let t = 0;
    const seen: string[] = [];
    const a = make({ now: () => t, currentUser: async (tok) => (seen.push(tok), mockCurrentUser(tok)) });
    for (let i = 0; i < 5; i++) expect(await a.verify({ type: 'secret', secret: 'tablet:no' }, 'bad')).toEqual(refused);
    const r = (await a.verify({ type: 'secret', secret: 'tablet:no' }, 'bad')) as Extract<AuthResult, { ok: false }>;
    expect(r).toEqual(tooMany);
    expect(await a.verify({ type: 'ha', token: 'mock-user:Cy' }, 'bad')).toEqual(tooMany);
    expect(seen).toEqual([]); // (unchecked: Home Assistant was not asked)
    expect(await a.verify({ type: 'secret', secret: 'nope:x' }, 'elsewhere')).toEqual(refused);
    t += 12_000; // 5 a minute: one more try
    expect((await a.verify({ type: 'ha', token: 'mock-user:Cy' }, 'bad')).ok).toBe(true);
    expect(seen).toEqual(['mock-user:Cy']);
  });

  it('a right access code gets in even while its address is limited (one slow guesser must not lock the house out)', async () => {
    const a = make();
    for (let i = 0; i < 6; i++) await a.verify({ type: 'secret', secret: 'tablet:guess' }, 'proxy');
    expect(await a.verify({ type: 'secret', secret: 'tablet:guess' }, 'proxy')).toEqual(tooMany);
    expect(await a.verify({ type: 'secret', secret: 'tablet:s3cret' }, 'proxy')).toMatchObject({ ok: true });
    expect(await a.verify({ type: 'secret', secret: 'kitchen:k' }, 'proxy')).toMatchObject({ ok: true });
  });

  it('Home Assistant errors count against the address too (but stay retryable)', async () => {
    const a = make({ currentUser: down });
    for (let i = 0; i < 5; i++) expect(await a.verify({ type: 'ha', token: 'x' }, 'lan')).toMatchObject({ code: 4503 });
    expect(await a.verify({ type: 'ha', token: 'x' }, 'lan')).toEqual(tooMany);
    expect(await a.verify({ type: 'ha', token: 'x' }, 'other')).toMatchObject({ code: 4503 });
  });

  it('100 concurrent HA logins from one address: no more than the limit allows reach Home Assistant', async () => {
    const { h, currentUser } = held();
    const a = make({ currentUser });
    const all = Array.from({ length: 100 }, () => a.verify({ type: 'ha', token: 'mock-user:Cy' }, 'flood'));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls).toBeLessThanOrEqual(5);
    expect(h.calls).toBe(2); // (two under way per address)
    h.release();
    const rs = await Promise.all(all);
    expect(rs.filter((r) => r.ok)).toHaveLength(2);
    expect(rs.filter((r) => !r.ok).every((r) => !r.ok && (r.code === 4429 || r.code === 4503))).toBe(true);
    expect(h.calls).toBe(2);
    // the good logins gave their tokens back; the refused-unchecked ones took none for good
    expect((await a.verify({ type: 'ha', token: 'mock-user:Cy' }, 'flood')).ok).toBe(true);
  });

  it('at most 4 HA checks at once in all: more is "busy" (4503) and costs the address nothing', async () => {
    const { h, currentUser } = held();
    const a = make({ currentUser });
    const all = ['a', 'b', 'c', 'd', 'e', 'f'].map((r) => a.verify({ type: 'ha', token: 'mock-user:Cy' }, r));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls).toBe(4);
    h.release();
    const rs = await Promise.all(all);
    expect(rs.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok', 'ok', 'ok', 'ok', 4503, 4503]);
    for (let i = 0; i < 5; i++) expect((await a.verify({ type: 'ha', token: 'mock-user:Cy' }, 'f')).ok).toBe(true);
  });

  it('ha_users only (the default): HA users not listed are refused; listed ones by id or by name get in', async () => {
    const a = make({ haUsersOnly: true });
    expect(await a.verify({ type: 'ha', token: 'mock-user:Cy' }, 'r')).toEqual(refused);
    expect(await a.verify({ type: 'ha', token: 'mock-user:Ana' }, 'r')).toMatchObject({
      ok: true,
      user: { key: 'ha:mock-ana', surface: 'speaker' },
    });
    expect(await a.verify({ type: 'ha', token: 'mock-user:Bo' }, 'r')).toMatchObject({ ok: true });
    const dflt = createAuthenticator({
      kinds: ['ha'],
      clients,
      haSurface: 'screen',
      currentUser: async (t) => mockCurrentUser(t),
    });
    expect(await dflt.verify({ type: 'ha', token: 'mock-user:Cy' }, 'r')).toEqual(refused);
    // an id entry wins over a name entry for the same person
    const both = make({
      clients: {
        clients: [],
        haUsers: [
          { name: 'Ana', surface: 'screen' },
          { id: 'mock-ana', surface: 'speaker' },
        ],
      },
    });
    expect(await both.verify({ type: 'ha', token: 'mock-user:Ana' }, 'r')).toMatchObject({
      user: { surface: 'speaker' },
    });
  });
});

describe('checking a login again', () => {
  const tablet = { key: 'secret:tablet', name: 'tablet', via: 'secret' as const, surface: 'screen' as const };
  const ana = { key: 'ha:mock-ana', name: 'Ana', via: 'ha' as const, surface: 'speaker' as const };
  const code = { type: 'secret' as const, secret: 'tablet:s3cret' };
  const tok = { type: 'ha' as const, token: 'mock-user:Ana' };
  const file = (clients: ClientsFile['clients'], haUsers: ClientsFile['haUsers']): ClientsFile => ({
    clients,
    haUsers,
  });

  it('an access code against the (reloaded) clients file: gone → refused, another surface → changed', async () => {
    const a = createAuthenticator({
      kinds: ['secret'],
      clients: file([{ name: 'tablet', secretSha256: HASH, surface: 'screen' }], []),
      haSurface: 'screen',
    });
    expect(a.recheckLocal(tablet, code)).toBe('ok');
    expect(await a.recheck(tablet, code)).toBe('ok');
    a.setClients(file([{ name: 'tablet', secretSha256: HASH, surface: 'speaker' }], []));
    expect(a.recheckLocal(tablet, code)).toBe('changed');
    a.setClients(file([{ name: 'tablet', secretSha256: sha256Hex('tablet:new'), surface: 'screen' }], []));
    expect(a.recheckLocal(tablet, code)).toBe('refused');
    expect((await a.verify(code, 'r')).ok).toBe(false); // and it can't log in again either
    a.setClients(file([], []));
    expect(await a.recheck(tablet, code)).toBe('refused');
  });

  it('an HA login: asks Home Assistant with the latest token; refused, someone else, unlisted → refused; down → unknown', async () => {
    let answer: (t: string) => Promise<ReturnType<typeof mockCurrentUser>> = async (t) => mockCurrentUser(t);
    const a = createAuthenticator({
      kinds: ['ha'],
      clients: file([], [{ id: 'mock-ana', surface: 'speaker' }]),
      haSurface: 'screen',
      currentUser: (t) => answer(t),
    });
    expect(await a.recheck(ana, tok)).toBe('ok');
    expect(await a.recheck(ana, { type: 'ha', token: 'mock-user:Bo' })).toBe('refused'); // another user's token
    expect(await a.recheck(ana, { type: 'ha', token: 'expired' })).toBe('refused');
    answer = async () => {
      throw new Error('ECONNREFUSED');
    };
    expect(await a.recheck(ana, tok)).toBe('unknown');
    answer = async (t) => mockCurrentUser(t);
    a.setClients(file([], [{ id: 'mock-ana', surface: 'screen' }]));
    expect(await a.recheck(ana, tok)).toBe('changed');
    expect(a.recheckLocal(ana, tok)).toBe('changed');
    a.setClients(file([], []));
    expect(await a.recheck(ana, tok)).toBe('refused');
    expect(a.recheckLocal(ana, tok)).toBe('refused'); // (no Home Assistant call: by the identity it logged in as)
  });
});

describe('the client address behind a trusted proxy', () => {
  it('the TCP peer, unless it is a trusted proxy: then the right-most untrusted X-Forwarded-For entry', () => {
    const proxy = ['10.0.0.1'];
    expect(clientAddress('10.0.0.9', '6.6.6.6', proxy)).toBe('10.0.0.9'); // not from the proxy: the header is ignored
    expect(clientAddress('10.0.0.1', undefined, proxy)).toBe('10.0.0.1');
    expect(clientAddress('10.0.0.1', '192.168.1.20', proxy)).toBe('192.168.1.20');
    expect(clientAddress('::ffff:10.0.0.1', '192.168.1.20', proxy)).toBe('192.168.1.20');
    // a client sending its own X-Forwarded-For can't choose its address: the proxy appends the real one
    expect(clientAddress('10.0.0.1', '1.2.3.4, 192.168.1.20', proxy)).toBe('192.168.1.20');
    expect(clientAddress('10.0.0.1', ['1.2.3.4', '192.168.1.20, 10.0.0.2'], ['10.0.0.1', '10.0.0.2'])).toBe(
      '192.168.1.20',
    );
    expect(clientAddress('10.0.0.1', '10.0.0.1', proxy)).toBe('10.0.0.1');
    expect(clientAddress('10.0.0.1', 'garbage', proxy)).toBe('10.0.0.1');
    expect(clientAddress('10.0.0.1', '2001:db8::7', proxy)).toBe('2001:db8::7');
    expect(clientAddress(undefined, undefined, [])).toBe('unknown');
  });
});

describe('tickets', () => {
  const user = { key: 'secret:tablet', name: 'tablet', via: 'secret' as const, surface: 'screen' as const };

  it('valid for their holder until it closes or they expire; renewals overlap', () => {
    let t = 0;
    const s = createTicketStore({ ttlMs: 1000, now: () => t });
    const h1 = {};
    const h2 = {};
    const a = s.issue(h1, { user, owner: 'secret:tablet/c1' });
    const b = s.issue(h2, { user, owner: 'secret:tablet/c2' });
    expect(a).not.toBe(b);
    expect(s.check(a)).toEqual({ user, owner: 'secret:tablet/c1' });
    t = 600;
    const a2 = s.issue(h1, { user, owner: 'secret:tablet/c1' });
    expect(s.check(a)).not.toBeNull(); // the old one still works until it expires
    t = 1000;
    expect(s.check(a)).toBeNull();
    expect(s.check(a2)).not.toBeNull();
    s.revoke(h1);
    expect(s.check(a2)).toBeNull();
    expect(s.check(b)).toBeNull(); // (expired too by now)
    for (const x of [undefined, null, 1, '', 'x'.repeat(500)]) expect(s.check(x)).toBeNull();
    expect(s.size).toBe(0);
  });

  it('at most two live per connection: issuing a third revokes the oldest', () => {
    const s = createTicketStore({ ttlMs: 60_000, now: () => 0 });
    const h = {};
    const info = { user, owner: 'secret:tablet/c1' };
    const ts = Array.from({ length: 5 }, () => s.issue(h, info));
    expect(ts.map((t) => !!s.check(t))).toEqual([false, false, false, true, true]);
    expect(s.size).toBe(2);
    s.issue({}, info); // another connection's are its own
    expect(s.size).toBe(3);
  });

  it('bearer() reads the header', () => {
    expect(bearer('Bearer abc-_123')).toBe('abc-_123');
    expect(bearer(' Bearer abc ')).toBe('abc');
    for (const h of [undefined, '', 'Basic abc', 'Bearer', 'Bearer a b', 'bearer abc']) expect(bearer(h)).toBeNull();
  });
});

describe('rate limits', () => {
  it('parseRate', () => {
    expect(parseRate('6/20')).toEqual({ burst: 6, perMinute: 20 });
    expect(parseRate(' 1 / 1 ')).toEqual({ burst: 1, perMinute: 1 });
    for (const s of ['', '6', '0/5', '5/0', '-1/5', '1.5/2', 'a/b', '6/20/1']) expect(parseRate(s)).toBeNull();
  });

  it('a token bucket per key: the burst at once, then perMinute', () => {
    let t = 0;
    const l = createRateLimiter({ burst: 3, perMinute: 6 }, () => t);
    expect([1, 2, 3, 4].map(() => l.take('a'))).toEqual([true, true, true, false]);
    expect(l.take('b')).toBe(true); // keys are separate
    expect(l.has('a')).toBe(false);
    t += 9_999;
    expect(l.take('a')).toBe(false);
    t += 1;
    expect(l.take('a')).toBe(true); // one every 10 s
    t += 3_600_000;
    expect(l.has('a', 3)).toBe(true);
    expect(l.has('a', 4)).toBe(false); // never more than the burst
    expect(l.take('a', 2)).toBe(true);
    expect(l.take('a', 2)).toBe(false);
    expect(l.take('a')).toBe(true);
  });

  it('refund gives tokens back, never above the burst', () => {
    const l = createRateLimiter({ burst: 2, perMinute: 1 }, () => 0);
    expect([l.take('a'), l.take('a'), l.take('a')]).toEqual([true, true, false]);
    l.refund('a');
    expect(l.take('a')).toBe(true);
    l.refund('a', 10);
    l.refund('b');
    expect(l.has('a', 2)).toBe(true);
    expect(l.has('a', 3)).toBe(false);
    expect(l.has('b', 3)).toBe(false);
  });
});
