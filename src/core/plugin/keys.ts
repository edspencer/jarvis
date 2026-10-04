// The keybinding registry: every key the viewer answers is registered here (by the core or a plugin), so help and
// tooltips are generated from it and a conflict is reported at load. Pure apart from the console: unit-tested.
import type { Disposable, KeyBinding, KeyEntry, KeySpec } from './types';

/** Letter keys the core itself uses (movement, view, help, navigate). A site layer can't take them; nor the keys the
 * site's plugins declare (src/plugins/registry.ts). */
export const CORE_KEYS = [...'WASDQECXUGHN'] as const;

const NAMES: Record<string, string> = {
  Slash: '/',
  Space: 'Space',
  Tab: 'Tab',
  Escape: 'Esc',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Comma: ',',
  Period: '.',
  F6: 'F6',
};

/** 'Shift-P', '?', '/' */
export function keyName(k: Pick<KeySpec, 'code' | 'shift' | 'alt'>): string {
  if (k.code === 'Slash' && k.shift) return '?';
  const base = NAMES[k.code] ?? k.code.replace(/^Key|^Digit/, '');
  return `${k.alt ? 'Alt-' : ''}${k.shift ? 'Shift-' : ''}${base}`;
}

const sig = (k: Pick<KeySpec, 'code' | 'shift' | 'alt'>) => `${k.code}|${!!k.shift}|${!!k.alt}`;

export interface KeyRegistry {
  add(owner: string, ownerName: string, k: KeyBinding): Disposable;
  list(): KeyEntry[];
  /** the binding a key event runs (not for typing in a field: the caller checks that), or null */
  match(e: Pick<KeyboardEvent, 'code' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>): KeyEntry | null;
  /** run the matching binding; true if one ran */
  handle(e: KeyboardEvent): boolean;
  /** the conflicts reported so far ('Shift-P: pins and other') */
  conflicts: string[];
}

export function createKeyRegistry(
  opts: { declared?: (owner: string) => readonly string[] | null; warn?: (msg: string) => void } = {},
): KeyRegistry {
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const entries: KeyEntry[] = [];
  const conflicts: string[] = [];

  function add(owner: string, ownerName: string, k: KeyBinding): Disposable {
    // a clash: the same key already runs something, or the core holds it for movement (help-only entries)
    const clash = k.run && entries.find((e) => (e.run || e.owner === 'core') && sig(e) === sig(k));
    if (clash) {
      const m = `keys: ${keyName(k)} (${k.label}, ${owner}) is already ${clash.owner}'s (${clash.label}); ignored`;
      conflicts.push(m);
      warn(m);
      return { dispose() {} };
    }
    // a plugin's letter key should be one it declares, so the site validator can keep site layers off it
    const letter = /^Key([A-Z])$/.exec(k.code)?.[1];
    const declared = opts.declared?.(owner);
    if (letter && k.run && declared && !declared.includes(letter))
      warn(`keys: ${owner} uses ${letter} but doesn't declare it (src/plugins/registry.ts)`);
    const e: KeyEntry = { ...k, owner, ownerName };
    entries.push(e);
    return {
      dispose() {
        const i = entries.indexOf(e);
        if (i >= 0) entries.splice(i, 1);
      },
    };
  }

  function match(e: Pick<KeyboardEvent, 'code' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>): KeyEntry | null {
    if (e.ctrlKey || e.metaKey) return null; // the browser's shortcuts
    const find = (shift: boolean) =>
      entries.find(
        (k) => k.run && k.code === e.code && !!k.shift === shift && !!k.alt === e.altKey && (!k.when || k.when()),
      ) ?? null;
    const exact = find(e.shiftKey);
    if (exact || !e.shiftKey) return exact;
    // Shift held to run: a key with no Shift binding of its own still works (Space jumps, X cuts away)
    const shifted = entries.some((k) => k.code === e.code && k.shift && !!k.alt === e.altKey);
    return shifted ? null : find(false);
  }

  function handle(e: KeyboardEvent): boolean {
    const k = match(e);
    if (!k) return false;
    k.run!(e);
    return true;
  }

  return { add, list: () => [...entries], match, handle, conflicts };
}
