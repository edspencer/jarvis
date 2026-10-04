// The keybinding registry: every key the viewer answers is registered here (by the core or a plugin), so help and
// tooltips are generated from it and a conflict is reported at load. Pure apart from the console: unit-tested.
import type { Disposable, KeyBinding, KeyEntry, KeySpec } from './types';

/** Letter keys the core itself uses (movement, view, help, navigate). A site layer can't take them; nor the keys the
 * site's plugins declare (src/plugins/registry.ts). */
export const CORE_KEYS = [...'WASDQECXUGHN'] as const;
// (the movement keys, arrows, Space and Shift included, are registered by the core at start-up in every Shift form:
// see MOVEMENT_KEYS in src/core/builtin.ts; a plugin binding one gets a conflict)

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
  /** run the matching binding; true if one ran (key repeat: ignored while that binding's key is held) */
  handle(e: KeyboardEvent): boolean;
  /** a key went up: the release of whatever its press ran */
  release(e: KeyboardEvent): void;
  /** the window lost focus: release every held key */
  releaseAll(): void;
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
    // a clash: the same key already runs something, or the core holds it for movement (help-only entries). Bindings
    // that both have a `when` share the key (Esc to cancel whatever is active): a press runs the first whose `when`
    // holds, in the order they were added.
    const shares = (e: KeyEntry) => !!(e.run && e.when && k.when);
    // Esc goes to a plugin only to cancel something (escape.ts): a binding with no `when` would take every press
    // meant for the inspector, so one is refused
    if (k.run && k.code === 'Escape' && !k.when && owner !== 'core') {
      const m = `keys: Esc (${k.label}, ${owner}) needs a \`when\`: bind Esc only while there is something to cancel; ignored`;
      conflicts.push(m);
      warn(m);
      return { dispose() {} };
    }
    const clash = k.run && entries.find((e) => (e.run || e.owner === 'core') && sig(e) === sig(k) && !shares(e));
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
      warn(
        `keys: ${owner} uses ${letter} but doesn't declare it (src/plugins/registry.ts, or an external plugin's keys)`,
      );
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
    const shifted = entries.some((k) => k.run && k.code === e.code && k.shift && !!k.alt === e.altKey);
    return shifted ? null : find(false);
  }

  /** code -> a hold binding (one with `release`) its press ran, while the key is down */
  const held = new Map<string, KeyEntry>();
  function handle(e: KeyboardEvent): boolean {
    if (held.has(e.code)) return true; // a hold key repeating: once per press
    const k = match(e);
    if (!k) return false;
    if (e.repeat) return true; // key repeat never runs a binding again
    if (k.release) held.set(e.code, k);
    k.run!(e);
    return true;
  }
  function release(e: KeyboardEvent): void {
    const k = held.get(e.code);
    held.delete(e.code);
    k?.release?.(e);
  }
  function releaseAll(): void {
    const ks = [...held.values()];
    held.clear();
    for (const k of ks) k.release?.(null);
  }

  return { add, list: () => [...entries], match, handle, release, releaseAll, conflicts };
}
