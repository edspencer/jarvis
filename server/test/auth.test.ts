// Logins and limits (core/auth.ts, core/limits.ts): the clients file's strict validation, access codes, Home Assistant
// tokens through the mock's currentUser, surfaces from the configuration, the failed-login limit, /transcribe tickets
// and the token buckets, all with an injected clock.
import { describe, expect, it } from 'vitest';
import {
  bearer,
  createAuthenticator,
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
      currentUser: async (t) => mockCurrentUser(t),
      ...o,
    });
  const refused = { ok: false, reason: 'not authorised', code: 4401 };

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
    const down = make({
      currentUser: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await down.verify({ type: 'ha', token: 'mock-user:Cy' }, 'r')).toMatchObject({
      ok: false,
      code: 4401,
      reason: expect.stringMatching(/^not authorised/),
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

  it('5 failures from an address, then that address is refused unchecked until a minute has passed', async () => {
    let t = 0;
    const a = make({ now: () => t });
    const good = { type: 'secret', secret: 'tablet:s3cret' };
    for (let i = 0; i < 5; i++) expect(await a.verify({ type: 'secret', secret: 'tablet:no' }, 'bad')).toEqual(refused);
    const r = (await a.verify(good, 'bad')) as Extract<AuthResult, { ok: false }>;
    expect(r).toEqual({ ok: false, reason: 'too many failed attempts; try again in a minute', code: 4429 });
    expect((await a.verify(good, 'elsewhere')).ok).toBe(true);
    t += 12_000; // 5 a minute: one more try
    expect((await a.verify(good, 'bad')).ok).toBe(true);
    // a backend outage is not counted against the address
    const down = make({
      currentUser: async () => {
        throw new Error('down');
      },
    });
    for (let i = 0; i < 8; i++)
      expect(await down.verify({ type: 'ha', token: 'x' }, 'lan')).toMatchObject({ code: 4401 });
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
});
