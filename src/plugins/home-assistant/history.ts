// Home Assistant's recorder history for the store (store.history): one read-only websocket request,
// history/history_during_period, never a service call, so it doesn't pass through send()'s allow-list (nothing changes).
import type { HistoryPoint } from '../../plugin-api';

/** the websocket message for one entity's states between two times (ms) */
export function historyMessage(entityId: string, from: number, to: number): { type: string; [k: string]: unknown } {
  return {
    type: 'history/history_during_period',
    start_time: new Date(from).toISOString(),
    end_time: new Date(to).toISOString(),
    entity_ids: [entityId],
    minimal_response: true,
    no_attributes: true,
    significant_changes_only: false,
  };
}

/** a compressed state as HA sends it with minimal_response: s = state, lu / lc = last updated / changed (seconds) */
interface Compressed {
  s?: string;
  lu?: number;
  lc?: number;
}

/** HA's answer ({ entity_id: [states] }) as history points, oldest first */
export function parseHistory(resp: unknown, entityId: string): HistoryPoint[] {
  const list = (resp as Record<string, Compressed[] | undefined> | null)?.[entityId];
  if (!Array.isArray(list)) return [];
  const out: HistoryPoint[] = [];
  for (const x of list) {
    const sec = x.lu ?? x.lc;
    if (typeof x.s !== 'string' || typeof sec !== 'number') continue;
    const n = Number(x.s);
    out.push({ t: Math.round(sec * 1000), state: x.s, v: x.s !== '' && Number.isFinite(n) ? n : null });
  }
  return out.sort((a, b) => a.t - b.t);
}
