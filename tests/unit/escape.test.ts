// Esc: one thing per press, the core's first (modal, text field, pointer lock, menu, search, inspector), then a
// plugin's Esc binding through the real key registry.
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
  it('closes one thing per press, innermost first, and reaches a plugin only when nothing is open', () => {
    const { press, cancel } = setup({ modal: true, locked: true, menu: true, search: true, inspector: true });
    expect([press(), press(), press(), press(), press()]).toEqual(['modal', 'lock', 'menu', 'search', 'inspector']);
    expect(cancel).not.toHaveBeenCalled();
    expect(press()).toBe('plugin');
    expect(cancel).toHaveBeenCalledTimes(1);
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
  });
});
