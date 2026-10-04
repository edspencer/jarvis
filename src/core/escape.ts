// What Esc does: one thing per press, the first that applies, the core's before a plugin's. A plugin can bind Esc
// (keys.add({ code: 'Escape', when, run })) to cancel something of its own; it gets the key only when the core has
// nothing to close. Pure: input.ts supplies the state, tests/unit/escape.test.ts checks the order.

/** what an Esc press went to */
export type EscapeTarget = 'modal' | 'field' | 'lock' | 'menu' | 'search' | 'inspector' | 'plugin' | null;

export interface EscapeDeps {
  /** a modal is open (the topmost closes) */
  modal(): boolean;
  closeModal(): void;
  /** focus is in a text field: Esc is the field's (a search box clears itself) */
  typing(): boolean;
  /** the mouse is captured (walking): Esc releases it. The browser usually does that itself, before the page sees
   * the key; this covers a browser that passes it on. */
  locked(): boolean;
  unlock(): void;
  /** close an open menu; true if one was open */
  closeMenus(): boolean;
  searchOpen(): boolean;
  closeSearch(): void;
  inspectorOpen(): boolean;
  closeInspector(): void;
  /** run a plugin's Esc binding (the key registry: the first whose `when` holds); true if one ran */
  plugin(): boolean;
}

/** Handle an Esc press: modal, text field, pointer lock, menu, search, inspector, then a plugin's binding. */
export function handleEscape(d: EscapeDeps): EscapeTarget {
  if (d.modal()) return (d.closeModal(), 'modal');
  if (d.typing()) return 'field';
  if (d.locked()) return (d.unlock(), 'lock');
  if (d.closeMenus()) return 'menu';
  if (d.searchOpen()) return (d.closeSearch(), 'search');
  if (d.inspectorOpen()) return (d.closeInspector(), 'inspector');
  if (d.plugin()) return 'plugin';
  return null;
}
