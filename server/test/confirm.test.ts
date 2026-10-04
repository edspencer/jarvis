// The parked-action store: TTL, one-shot ids, client binding, and the fixed spoken yes/no list.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfirmStore, matchSpoken, DEFAULT_TTL_MS } from '../src/core/confirm.ts';
import type { Parked } from '../src/core/confirm.ts';

describe('confirm store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('parks with a random id and a 30 s TTL', () => {
    const s = createConfirmStore<string>();
    const a = s.park('tab-1', 'a');
    const b = s.park('tab-1', 'b');
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.id).not.toBe(b.id);
    expect(DEFAULT_TTL_MS).toBe(30_000);
    expect(a.expiresAt - a.createdAt).toBe(30_000);
    expect(s.list('tab-1').map((e) => e.value)).toEqual(['a', 'b']);
    expect(s.list('tab-2')).toEqual([]);
  });

  it('expires once at the TTL and calls onExpire', () => {
    const expired: Parked<string>[] = [];
    const s = createConfirmStore<string>({ onExpire: (e) => expired.push(e) });
    const a = s.park('tab-1', 'a');
    vi.advanceTimersByTime(29_999);
    expect(s.get(a.id)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(expired.map((e) => e.id)).toEqual([a.id]);
    expect(s.get(a.id)).toBeUndefined();
    expect(s.take(a.id, 'tab-1')).toEqual({ ok: false, reason: 'already expired' });
    vi.advanceTimersByTime(60_000);
    expect(expired).toHaveLength(1);
  });

  it('take is one-shot (replay rejected) and bound to the client', () => {
    const s = createConfirmStore<string>();
    const a = s.park('tab-1', 'a');
    expect(s.take(a.id, 'tab-2')).toEqual({ ok: false, reason: 'not your pending action' });
    const r = s.take(a.id, 'tab-1');
    expect(r.ok && r.entry.value).toBe('a');
    expect(s.take(a.id, 'tab-1')).toEqual({ ok: false, reason: 'already answered' });
    expect(s.take('made-up', 'tab-1')).toEqual({ ok: false, reason: 'no such pending action' });
    expect(s.take(undefined as unknown as string, 'tab-1').ok).toBe(false);
  });

  it('take after expiry is rejected even when the timer has not fired (clock checked too)', () => {
    let t = 1_000;
    const expired: string[] = [];
    const s = createConfirmStore<string>({
      now: () => t,
      setTimeout: () => 0, // a timer that never fires
      clearTimeout: () => {},
      onExpire: (e) => expired.push(e.id),
    });
    const a = s.park('tab-1', 'a');
    t += 30_000;
    expect(s.take(a.id, 'tab-1')).toEqual({ ok: false, reason: 'already expired' });
    expect(expired).toEqual([a.id]);
  });

  it('a settled entry no longer expires', () => {
    const onExpire = vi.fn();
    const s = createConfirmStore<string>({ onExpire });
    const a = s.park('tab-1', 'a');
    s.take(a.id, 'tab-1');
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('drain removes a client’s entries (or all)', () => {
    const s = createConfirmStore<string>();
    s.park('tab-1', 'a');
    s.park('tab-2', 'b');
    s.park('tab-1', 'c');
    expect(s.drain('tab-1').map((e) => e.value)).toEqual(['a', 'c']);
    expect(s.list().map((e) => e.value)).toEqual(['b']);
    const [b] = s.drain();
    expect(s.list()).toEqual([]);
    expect(s.take(b.id, 'tab-2')).toEqual({ ok: false, reason: 'already cancelled' });
  });

  it('entries are frozen', () => {
    const s = createConfirmStore<string>();
    const a = s.park('tab-1', 'a');
    expect(() => {
      (a as { clientId: string }).clientId = 'tab-2';
    }).toThrow();
  });
});

describe('matchSpoken', () => {
  it.each(['yes', 'Yes.', 'YES!', ' yes please ', 'Do it', 'confirm', 'Go ahead.', 'yeah', 'yep'])('%j → yes', (t) =>
    expect(matchSpoken(t)).toBe('yes'),
  );
  it.each(['no', 'No!', 'cancel', "don't", 'Don’t.', 'stop', 'nope', 'never mind', 'no thanks'])('%j → no', (t) =>
    expect(matchSpoken(t)).toBe('no'),
  );
  it.each([
    'yes but turn the lights on',
    'yes, and also unlock the door',
    'yes unlock the front door',
    'no wait yes',
    'I said yes',
    'yesterday',
    'confirmation',
    'do it now and open the garage',
    'stop the music',
    '',
    'ok',
  ])('%j is neither (whole-utterance match only)', (t) => expect(matchSpoken(t)).toBeNull());
  it('handles non-strings', () => {
    expect(matchSpoken(undefined as unknown as string)).toBeNull();
  });
});
