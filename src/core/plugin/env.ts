// Small helpers behind ctx.url and ctx.storage.
import type { StorageApi, UrlApi } from './types';

/** the page's query string; set() rewrites the address bar without reloading */
export function createUrl(loc: Pick<Location, 'search' | 'pathname' | 'hash'> = location): UrlApi {
  const q = () => new URLSearchParams(loc.search);
  return {
    has: (k) => q().has(k),
    get: (k) => q().get(k),
    num(k, d) {
      const v = q().get(k);
      const n = v === null || v === '' ? NaN : Number(v);
      return Number.isFinite(n) ? n : d;
    },
    set(k, v) {
      const p = q();
      if (v === null) p.delete(k);
      else p.set(k, v);
      const s = p.toString().replace(/=(?=&|$)/g, ''); // ?pins, not ?pins=
      history.replaceState(history.state, '', loc.pathname + (s ? `?${s}` : '') + loc.hash);
    },
  };
}

/** localStorage under '<prefix>.<key>', JSON-encoded; quietly does nothing in private mode */
export function createStorage(prefix: string, ls: Storage | null = safeLocalStorage()): StorageApi {
  return {
    get<T>(key: string, d: T): T {
      try {
        const v = ls?.getItem(`${prefix}.${key}`);
        return v == null ? d : (JSON.parse(v) as T);
      } catch {
        return d;
      }
    },
    set(key, v) {
      try {
        ls?.setItem(`${prefix}.${key}`, JSON.stringify(v));
      } catch {
        /* private mode, full */
      }
    },
    remove(key) {
      try {
        ls?.removeItem(`${prefix}.${key}`);
      } catch {
        /* private mode */
      }
    },
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
