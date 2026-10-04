// Rate limits: a token bucket per key (an authenticated user for `say` and /transcribe, a remote address for failed
// logins). A key starts with `burst` tokens and gets `perMinute` back per minute, up to `burst` again. Pure apart from
// the clock, which tests inject.

export interface Rate {
  /** tokens a key starts with, and the most it saves up */
  burst: number;
  /** tokens it gets back per minute */
  perMinute: number;
}

export interface RateLimiter {
  /** take `n` tokens (default 1) if there are that many: true; else false and nothing is taken */
  take(key: string, n?: number): boolean;
  /** does the key have at least `n` tokens (nothing taken)? */
  has(key: string, n?: number): boolean;
}

/** "6/20" → { burst: 6, perMinute: 20 }; null if it isn't two positive whole numbers */
export function parseRate(s: string): Rate | null {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(s);
  if (!m) return null;
  const burst = Number(m[1]);
  const perMinute = Number(m[2]);
  return burst > 0 && perMinute > 0 ? { burst, perMinute } : null;
}

/** keys kept before the full ones (back at `burst`, so forgetting them changes nothing) are dropped */
const MAX_KEYS = 10_000;

export function createRateLimiter(rate: Rate, now: () => number = Date.now): RateLimiter {
  const perMs = rate.perMinute / 60_000;
  const buckets = new Map<string, { tokens: number; at: number }>();

  const level = (key: string) => {
    const t = now();
    const b = buckets.get(key);
    if (!b) return { tokens: rate.burst, at: t };
    return { tokens: Math.min(rate.burst, b.tokens + Math.max(0, t - b.at) * perMs), at: t };
  };
  const prune = () => {
    if (buckets.size <= MAX_KEYS) return;
    for (const k of [...buckets.keys()]) if (level(k).tokens >= rate.burst) buckets.delete(k);
  };

  return {
    take(key, n = 1) {
      const b = level(key);
      if (b.tokens < n) return false;
      buckets.set(key, { tokens: b.tokens - n, at: b.at });
      prune();
      return true;
    },
    has: (key, n = 1) => level(key).tokens >= n,
  };
}
