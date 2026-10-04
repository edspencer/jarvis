// The parked actions waiting for a person's yes (design §5.3, "Confirmation is server-side"). A `confirm` action gets
// a random id and a short life; only a reply from the client the request came from, once, before it expires, settles
// it. Ids are random UUIDs (not counters) so one client can't guess another's; a settled id is gone, so a second
// reply on it (a replay, a double click) is rejected rather than run twice. The clock and the timer functions are
// injectable so tests use fake time.
//
// matchSpoken() is the voice-only path: the server (never the model) matches the person's next utterance against a
// short fixed list, as a whole utterance. "yes but turn the lights on" is not a yes: anything that says more than
// yes/no goes to the model as a new request, and the pending action stays pending (or expires).
import { randomUUID } from 'node:crypto';

export const DEFAULT_TTL_MS = 30_000;

export interface Parked<T> {
  readonly id: string;
  readonly clientId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly value: T;
}

export interface ConfirmStoreOptions<T> {
  ttlMs?: number;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** called once when an entry's TTL passes unanswered (it has already been removed) */
  onExpire?: (entry: Parked<T>) => void;
  /** id generator (tests); crypto.randomUUID by default */
  newId?: () => string;
}

export type TakeResult<T> = { ok: true; entry: Parked<T> } | { ok: false; reason: string };

export interface ConfirmStore<T> {
  /** park a value for `clientId`; it expires after the TTL */
  park(clientId: string, value: T): Parked<T>;
  /** settle an entry (remove it and return it): only for its own client, only once, only before expiry */
  take(id: string, clientId: string): TakeResult<T>;
  /** remove a client's entries (all without a client id) and return them, e.g. on interrupt or disconnect */
  drain(clientId?: string): Parked<T>[];
  list(clientId?: string): Parked<T>[];
  get(id: string): Parked<T> | undefined;
}

/** how many settled ids to remember, to say "already answered" rather than "unknown" */
const SETTLED_MEMORY = 500;

export function createConfirmStore<T>(opts: ConfirmStoreOptions<T> = {}): ConfirmStore<T> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const setT = opts.setTimeout ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
  const newId = opts.newId ?? randomUUID;
  const live = new Map<string, { entry: Parked<T>; timer: unknown }>();
  const settled = new Map<string, string>(); // id → what happened

  const settle = (id: string, how: string) => {
    const it = live.get(id);
    if (!it) return undefined;
    live.delete(id);
    clearT(it.timer);
    settled.set(id, how);
    if (settled.size > SETTLED_MEMORY) settled.delete(settled.keys().next().value as string);
    return it.entry;
  };

  const expire = (id: string) => {
    const entry = settle(id, 'expired');
    if (entry) opts.onExpire?.(entry);
  };

  return {
    park(clientId, value) {
      let id = newId();
      while (live.has(id) || settled.has(id)) id = newId();
      const createdAt = now();
      const entry: Parked<T> = Object.freeze({ id, clientId, createdAt, expiresAt: createdAt + ttl, value });
      live.set(id, { entry, timer: setT(() => expire(id), ttl) });
      return entry;
    },
    take(id, clientId) {
      const it = typeof id === 'string' ? live.get(id) : undefined;
      if (!it) {
        const how = typeof id === 'string' ? settled.get(id) : undefined;
        return { ok: false, reason: how ? `already ${how}` : 'no such pending action' };
      }
      // checked before expiry, so another client can't learn or cause anything about this id
      if (it.entry.clientId !== clientId) return { ok: false, reason: 'not your pending action' };
      if (now() >= it.entry.expiresAt) {
        expire(id); // the timer hasn't fired yet (a slow event loop): it's expired all the same
        return { ok: false, reason: 'already expired' };
      }
      return { ok: true, entry: settle(id, 'answered')! };
    },
    drain(clientId) {
      const out: Parked<T>[] = [];
      for (const { entry } of [...live.values()])
        if (clientId === undefined || entry.clientId === clientId) out.push(settle(entry.id, 'cancelled')!);
      return out;
    },
    list(clientId) {
      return [...live.values()].map((x) => x.entry).filter((e) => clientId === undefined || e.clientId === clientId);
    },
    get(id) {
      return live.get(id)?.entry;
    },
  };
}

// ------------------------------------------------------------------------------------------------ spoken replies

/** the whole utterances that mean yes / no; deliberately short (anything longer goes to the model, unconfirmed) */
export const SPOKEN_YES: readonly string[] = [
  'yes',
  'yes please',
  'yeah',
  'yep',
  'do it',
  'confirm',
  'confirmed',
  'go ahead',
];
export const SPOKEN_NO: readonly string[] = [
  'no',
  'no thanks',
  'no thank you',
  'nope',
  'cancel',
  'dont',
  'do not',
  'stop',
  'never mind',
  'nevermind',
];

/** lower case, apostrophes dropped ("don't" → "dont"), other punctuation → space, spaces collapsed */
export function normaliseUtterance(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** 'yes' / 'no' if the whole utterance is one of the fixed phrases, else null (never a substring match) */
export function matchSpoken(text: string): 'yes' | 'no' | null {
  const t = normaliseUtterance(text);
  if (SPOKEN_YES.includes(t)) return 'yes';
  if (SPOKEN_NO.includes(t)) return 'no';
  return null;
}
