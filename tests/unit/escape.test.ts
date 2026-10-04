// Esc: one thing per press: modal, text field, pointer lock, menu, search, then a plugin's Esc binding (through the
// real key registry; several plugins share Esc by their `when`), then the inspector.
import { describe, expect, it, vi } from 'vitest';
import { handleEscape, type EscapeDeps } from '../../src/core/escape';
import { createKeyRegistry } from '../../src/core/plugin/keys';

function setup(open: Partial<Record<'modal' | 'typing' | 'locked' | 'menu' | 'search' | 'inspector', boolean>> = {}) {
  const state = { ...open };
  const keys = createKeyRegistry({ warn: () => {} });
  const cancel = vi.fn();
  let cancelling = true;
  keys.add('measure', 'Measure', { code: 'Escape', label: 'Stop measuring', when: () => cancelling, run: cancel });
  const esc = { code: 'Escape', key: 'Escape', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false };
  const deps: EscapeDeps = {
    modal: () => !!state.modal,
    closeModal: () => (state.modal = false),
    typing: () => !!state.typing,
    locked: () => !!state.locked,
    unlock: () => (state.locked = false),
    closeMenus: () => (state.menu ? ((state.menu = false), true) : false),
    searchOpen: () => !!state.search,
    closeSearch: () => (state.search = false),
    inspectorOpen: () => !!state.inspector,
    closeInspector: () => (state.inspector = false),
    plugin: () => keys.handle(esc as KeyboardEvent),
  };
  return { press: () => handleEscape(deps), state, cancel, stopCancelling: () => (cancelling = false) };
}

describe('Esc', () => {
  it('closes one thing per press: modal, lock, menu, search, then the active tool, then the inspector', () => {
    const { press, cancel, stopCancelling } = setup({
      modal: true,
      locked: true,
      menu: true,
      search: true,
      inspector: true,
    });
    expect([press(), press(), press(), press()]).toEqual(['modal', 'lock', 'menu', 'search']);
    expect(cancel).not.toHaveBeenCalled();
    expect(press()).toBe('plugin'); // the active tool is cancelled before the inspector closes (CAD convention)
    expect(cancel).toHaveBeenCalledTimes(1);
    stopCancelling(); // (its own run would do this: nothing left to cancel)
    expect(press()).toBe('inspector');
    expect(press()).toBeNull();
  });

  it('several plugins share Esc: the first whose `when` holds runs', () => {
    const keys = createKeyRegistry({ warn: () => {} });
    const ran: string[] = [];
    let a = false;
    const b = true;
    keys.add('a', 'A', { code: 'Escape', label: 'cancel A', when: () => a, run: () => ran.push('a') });
    keys.add('b', 'B', { code: 'Escape', label: 'cancel B', when: () => b, run: () => ran.push('b') });
    expect(keys.conflicts).toEqual([]);
    const esc = { code: 'Escape', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false } as KeyboardEvent;
    keys.handle(esc);
    a = true;
    keys.handle(esc);
    expect(ran).toEqual(['b', 'a']);
    // a binding without `when` still can't take a key that is already bound
    keys.add('c', 'C', { code: 'Escape', label: 'always', run: () => ran.push('c') });
    expect(keys.conflicts).toHaveLength(1);
  });

  it("leaves a text field's Esc to the field (a plugin doesn't get it)", () => {
    const { press, cancel } = setup({ typing: true, inspector: true });
    expect(press()).toBe('field');
    expect(cancel).not.toHaveBeenCalled();
  });

  it("a plugin's binding counts only while its `when` holds; else nothing happens", () => {
    const { press, cancel, stopCancelling } = setup();
    stopCancelling();
    expect(press()).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('the modal goes first even while typing in it, and the mouse lock before any panel', () => {
    expect(setup({ modal: true, typing: true }).press()).toBe('modal');
    expect(setup({ locked: true, inspector: true }).press()).toBe('lock');
    expect(setup({ search: true }).press()).toBe('search'); // the search before the tool
  });
});
