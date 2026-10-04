// The live HA client's message framing, against a fake in-process socket (never a real Home Assistant).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLiveHa, websocketUrl } from '../src/ha-live.ts';
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
