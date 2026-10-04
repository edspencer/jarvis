// The live HA client's message framing and the person-token check (currentUser), against fake in-process sockets
// (never a real Home Assistant).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHaUserCheck, createLiveHa, websocketUrl } from '../src/ha-live.ts';
import type { SocketLike } from '../src/ha-live.ts';

class FakeSocket implements SocketLike {
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.onclose?.({});
  }
  /** a message from "HA" */
  recv(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  last() {
    return this.sent[this.sent.length - 1];
  }
}

function setup(token = 'tok') {
  const sockets: FakeSocket[] = [];
  const ha = createLiveHa({
    url: 'https://ha.example.org:8123',
    token,
    timeoutMs: 1_000,
    backoffMs: [100, 400],
    socket: (u) => {
      const s = new FakeSocket(u);
      sockets.push(s);
      return s;
    },
  });
  const auth = (s = sockets[sockets.length - 1]) => {
    s.recv({ type: 'auth_required' });
    s.recv({ type: 'auth_ok' });
  };
  return { ha, sockets, auth };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ha-live framing', () => {
  it('builds the websocket URL', () => {
    expect(websocketUrl('https://ha.example.org:8123')).toBe('wss://ha.example.org:8123/api/websocket');
    expect(websocketUrl('http://10.0.0.2:8123/')).toBe('ws://10.0.0.2:8123/api/websocket');
    expect(websocketUrl('wss://ha.example.org/api/websocket')).toBe('wss://ha.example.org/api/websocket');
  });

  it('authenticates with the token, then frames requests with ids', async () => {
    const { ha, sockets, auth } = setup();
    expect(sockets[0].url).toBe('wss://ha.example.org:8123/api/websocket');
    sockets[0].recv({ type: 'auth_required' });
    expect(sockets[0].sent).toEqual([{ type: 'auth', access_token: 'tok' }]);
    auth();
    await ha.ready();
    expect(ha.connected).toBe(true);

    const states = ha.states(['light.hall']);
    await vi.advanceTimersByTimeAsync(0);
    const req = sockets[0].last();
    expect(req).toMatchObject({ type: 'get_states' });
    sockets[0].recv({
      id: req.id,
      type: 'result',
      success: true,
      result: [
        { entity_id: 'light.hall', state: 'on', attributes: {} },
        { entity_id: 'lock.front_door', state: 'locked', attributes: {} },
      ],
    });
    expect((await states).map((s) => s.entity_id)).toEqual(['light.hall']);

    const call = ha.callService('light', 'turn_on', { entity_id: ['light.hall'], brightness_pct: 40 });
    await vi.advanceTimersByTimeAsync(0);
    const c = sockets[0].last();
    expect(c).toEqual({
      id: c.id,
      type: 'call_service',
      domain: 'light',
      service: 'turn_on',
      service_data: { brightness_pct: 40 },
      target: { entity_id: ['light.hall'] },
    });
    expect(c.id).not.toBe(req.id);
    sockets[0].recv({ id: c.id, type: 'result', success: true, result: { context: {} } });
    await call;
  });

  it('history: the compressed rows become points', async () => {
    const { ha, sockets, auth } = setup();
    auth();
    const h = ha.history('sensor.t', new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T02:00:00Z'));
    await vi.advanceTimersByTimeAsync(0);
    const r = sockets[0].last();
    expect(r).toMatchObject({
      type: 'history/history_during_period',
      entity_ids: ['sensor.t'],
      start_time: '2026-10-01T00:00:00.000Z',
      end_time: '2026-10-01T02:00:00.000Z',
    });
    const t0 = Date.parse('2026-10-01T00:00:00Z') / 1000;
    sockets[0].recv({
      id: r.id,
      type: 'result',
      success: true,
      result: {
        'sensor.t': [
          { s: '70', lu: t0 },
          { s: '71', lu: t0 + 3600 },
        ],
      },
    });
    expect(await h).toEqual([
      { state: '70', at: '2026-10-01T00:00:00.000Z' },
      { state: '71', at: '2026-10-01T01:00:00.000Z' },
    ]);
  });

  it('errors and timeouts reject', async () => {
    const { ha, sockets, auth } = setup();
    auth();
    const bad = ha.callService('lock', 'unlock', { entity_id: ['lock.front_door'] });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].recv({
      id: sockets[0].last().id,
      type: 'result',
      success: false,
      error: { code: 'unauthorized', message: 'Unauthorized' },
    });
    await expect(bad).rejects.toThrow('Home Assistant: Unauthorized (unauthorized)');

    const slow = ha.states();
    const expectation = expect(slow).rejects.toThrow(/did not answer get_states/);
    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;
  });

  it('a refused token rejects ready()', async () => {
    const { ha, sockets } = setup('wrong');
    const ready = ha.ready();
    const expectation = expect(ready).rejects.toThrow(/refused the token/);
    sockets[0].recv({ type: 'auth_required' });
    sockets[0].recv({ type: 'auth_invalid', message: 'Invalid access token' });
    await expectation;
    ha.close!();
  });

  it('reconnects with backoff; in-flight requests reject on close', async () => {
    const { ha, sockets, auth } = setup();
    auth();
    const p = ha.states();
    const expectation = expect(p).rejects.toThrow(/connection closed/);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].close();
    await expectation;
    expect(ha.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(2);
    sockets[1].close();
    await vi.advanceTimersByTimeAsync(199);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    auth(sockets[2]);
    expect(ha.connected).toBe(true);
    ha.close!();
    expect(sockets[2].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(3);
  });
});

describe("currentUser: a person's own token, on a socket of its own", () => {
  function check(o: { cacheMs?: number; now?: () => number } = {}) {
    const sockets: FakeSocket[] = [];
    const who = createHaUserCheck({
      url: 'https://ha.example.org:8123',
      ownToken: 'assistant-token',
      timeoutMs: 1_000,
      socket: (u) => {
        const s = new FakeSocket(u);
        sockets.push(s);
        return s;
      },
      ...o,
    });
    return { who, sockets };
  }
  /** HA's side of a login with `token` that answers auth/current_user with `user` */
  const answer = (s: FakeSocket, user: Record<string, unknown>) => {
    s.recv({ type: 'auth_required' });
    s.recv({ type: 'auth_ok' });
    expect(s.last()).toEqual({ id: 1, type: 'auth/current_user' });
    s.recv({ id: 1, type: 'result', success: true, result: user });
  };

  it("auth with the person's token, auth/current_user, then close; a good answer is cached a minute", async () => {
    let t = 0;
    const { who, sockets } = check({ now: () => t });
    const p = who('person-token');
    expect(sockets).toHaveLength(1);
    sockets[0].recv({ type: 'auth_required' });
    expect(sockets[0].sent[0]).toEqual({ type: 'auth', access_token: 'person-token' });
    answer(sockets[0], { id: 'abc123', name: 'Ed', is_admin: true });
    expect(await p).toEqual({ id: 'abc123', name: 'Ed', is_admin: true });
    expect(sockets[0].closed).toBe(true);
    expect(await who('person-token')).toEqual({ id: 'abc123', name: 'Ed', is_admin: true });
    expect(sockets).toHaveLength(1); // from the cache
    t += 60_001;
    const again = who('person-token');
    expect(sockets).toHaveLength(2);
    answer(sockets[1], { id: 'abc123', name: 'Ed' });
    expect(await again).toEqual({ id: 'abc123', name: 'Ed', is_admin: false });
  });

  it("a refused token is null and not cached; the assistant's own token is never accepted", async () => {
    const { who, sockets } = check();
    const p = who('bad');
    sockets[0].recv({ type: 'auth_required' });
    sockets[0].recv({ type: 'auth_invalid', message: 'Invalid access token' });
    expect(await p).toBeNull();
    expect(sockets[0].closed).toBe(true);
    const p2 = who('bad');
    expect(sockets).toHaveLength(2);
    sockets[1].recv({ type: 'auth_invalid' });
    expect(await p2).toBeNull();
    expect(await who('assistant-token')).toBeNull();
    expect(await who('')).toBeNull();
    expect(sockets).toHaveLength(2);
  });

  it('HA failing to answer throws (no answer in time, the socket closing, a failed result)', async () => {
    const { who, sockets } = check();
    const slow = who('a');
    const caught = slow.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await caught).toMatch(/did not answer within 1000 ms/);
    expect(sockets[0].closed).toBe(true);
    const dropped = who('b');
    sockets[1].close();
    await expect(dropped).rejects.toThrow(/closed/);
    const failed = who('c');
    sockets[2].recv({ type: 'auth_ok' });
    sockets[2].recv({ id: 1, type: 'result', success: false, error: { code: 'unauthorized' } });
    await expect(failed).rejects.toThrow(/current_user failed/);
  });

  it("createLiveHa answers currentUser on its own socket, never the assistant's connection", async () => {
    const { ha, sockets, auth } = setup('assistant-token');
    auth();
    await ha.ready();
    await vi.advanceTimersByTimeAsync(0);
    // once connected, it asks who it is itself (on its own connection, with its own token)
    const own = sockets[0].last();
    expect(sockets[0].sent).toEqual([
      { type: 'auth', access_token: 'assistant-token' },
      { id: own.id, type: 'auth/current_user' },
    ]);
    sockets[0].recv({ id: own.id, type: 'result', success: true, result: { id: 'jarvis-uid', name: 'JARVIS' } });
    const p = ha.currentUser('person-token');
    expect(sockets).toHaveLength(2);
    sockets[1].recv({ type: 'auth_required' });
    expect(sockets[1].sent[0]).toEqual({ type: 'auth', access_token: 'person-token' });
    answer(sockets[1], { id: 'u1', name: 'Ana' });
    expect(await p).toMatchObject({ id: 'u1', name: 'Ana' });
    expect(await ha.currentUser('assistant-token')).toBeNull();
    expect(await ha.currentUser(' assistant-token\n')).toBeNull(); // (trimmed)
    expect(sockets).toHaveLength(2);
    ha.close!();
  });

  it("any token of the assistant's own HA user is refused, not only its own token string", async () => {
    const { ha, sockets, auth } = setup('assistant-token');
    auth();
    await vi.advanceTimersByTimeAsync(0);
    const own = sockets[0].last();
    expect(own).toMatchObject({ type: 'auth/current_user' });
    // a person's login made while the assistant's id isn't known yet: resolved once it is
    const early = ha.currentUser('another-token-of-the-assistant-user');
    await vi.advanceTimersByTimeAsync(0);
    answer(sockets[1], { id: 'jarvis-uid', name: 'JARVIS' });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].recv({ id: own.id, type: 'result', success: true, result: { id: 'jarvis-uid', name: 'JARVIS' } });
    expect(await early).toBeNull();
    // and from the cache too: a token HA vouched for, but of the assistant's own user
    const again = ha.currentUser('a-third-token');
    answer(sockets[2], { id: 'jarvis-uid', name: 'JARVIS' });
    expect(await again).toBeNull();
    const person = ha.currentUser('person-token');
    answer(sockets[3], { id: 'u1', name: 'Ana' });
    expect(await person).toMatchObject({ id: 'u1' });
    ha.close!();
  });

  it("the assistant's own id unknown (HA not answering it): the person's login can't be checked (throws: retried)", async () => {
    const { ha, sockets, auth } = setup('assistant-token');
    auth();
    await vi.advanceTimersByTimeAsync(0);
    const own = sockets[0].last();
    const p = ha.currentUser('person-token');
    const caught = p.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(0);
    answer(sockets[1], { id: 'u1', name: 'Ana' });
    sockets[0].recv({ id: own.id, type: 'result', success: false, error: { code: 'x', message: 'nope' } });
    expect(await caught).toMatch(/Home Assistant: nope/);
    ha.close!();
  });
});
