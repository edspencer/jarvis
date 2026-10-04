// The HUD's rules that don't need a DOM: which sections an inspected subject gets and in what order, and which dock
// panels stay open. Unit-tested.
import type { SectionContent, SectionProvider, Subject } from '../core/plugin/types';

export interface SectionRec {
  provider: SectionProvider;
  /** the plugin that registered it */
  owner: string;
  /** registration order, the tie-break */
  seq: number;
}

export interface ShownSection {
  rec: SectionRec;
  content: SectionContent | { error: string };
  order: number;
}

/** Ask every provider about a subject; keep the answers, ordered by `order` (base 0, owner 10, others 50+; default
 * 50), then by registration. A provider that throws gets an error section instead of breaking the inspector. */
export function sectionsFor(recs: SectionRec[], s: Subject): ShownSection[] {
  const out: ShownSection[] = [];
  for (const rec of recs) {
    let content: ShownSection['content'] | null;
    try {
      content = rec.provider.for(s);
    } catch (err) {
      console.error(`inspector section ${rec.provider.id} (${rec.owner}) failed`, err);
      content = { error: String((err as Error)?.message || err) };
    }
    if (content) out.push({ rec, content, order: rec.provider.order ?? 50 });
  }
  return out.sort((a, b) => a.order - b.order || a.rec.seq - b.rec.seq);
}

/** Open a dock panel: it goes on top; beyond `max` open panels, the oldest unpinned one closes. Returns the new list
 * (oldest first). */
export function openPanel(open: readonly string[], pinned: ReadonlySet<string>, id: string, max: number): string[] {
  const next = [...open.filter((x) => x !== id), id];
  while (next.length > max) {
    const i = next.findIndex((x) => x !== id && !pinned.has(x));
    if (i < 0) break; // everything else is pinned: allow more than max
    next.splice(i, 1);
  }
  return next;
}

/** subjects are the same thing (the history doesn't repeat itself) */
export function sameSubject(a: Subject | null, b: Subject | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'item' && b.kind === 'item') return a.id === b.id;
  if (a.kind === 'object' && b.kind === 'object')
    return a.node === b.node && (a.part?.name ?? null) === (b.part?.name ?? null);
  return false;
}
