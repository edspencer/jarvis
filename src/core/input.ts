// Keyboard and mouse. Every key that does something is in the key registry (help is generated from it); this file
// holds the held movement keys, the pointer lock, the mouse look, clicks (inspect) and the HUD's keyboard rules:
// F6 cycles the regions, Esc closes the innermost thing, else goes to a plugin (escape.ts), and while a
// HUD control has focus, Space, Enter, Tab and the arrows belong to it.
import * as THREE from 'three';
import type { Hud } from '../ui/hud';
import type { JvHud } from '../ui/shell';
import { handleEscape } from './escape';
import type { Picker } from './inspect';
import type { Bus } from './plugin/events';
import type { KeyRegistry } from './plugin/keys';
import type { Keys, Player, ViewState } from './types';

export interface OrbitHolder {
  /** created on the first switch to the overview */
  controls: import('three/addons/controls/OrbitControls.js').OrbitControls | null;
  /** the mouse moved with a button down since the last pointerdown (so the click is a drag, not an inspect) */
  dragged: boolean;
}

export interface Pointer {
  /** the mouse, NDC */
  mouse: THREE.Vector2;
  /** countdown to the next hover pick; -1 = the mouse moved */
  hoverT: number;
  /** the mouse, CSS px (overview hover label) */
  hoverAt: { x: number; y: number } | null;
}

export const CENTRE_NDC = new THREE.Vector2(0, 0);

const CONTROL_KEYS = ['Space', 'Enter', 'NumpadEnter', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

export function bindInput({
  canvas,
  state,
  keys,
  player,
  keyReg,
  hud,
  hudEl,
  picker,
  bus,
  orbit,
  pointer,
}: {
  canvas: HTMLCanvasElement;
  state: ViewState;
  keys: Keys;
  player: Player;
  keyReg: KeyRegistry;
  hud: Hud;
  hudEl: JvHud;
  picker: Picker;
  bus: Bus;
  orbit: OrbitHolder;
  pointer: Pointer;
}): void {
  const { mouse } = pointer;
  // was the HUD control that has focus reached from the keyboard (Tab, F6) or clicked? A clicked one doesn't keep the
  // game's keys: Tab still switches the mode after clicking a chip. (Chrome's :focus-visible turns on at the first key
  // press, so it can't tell.)
  let pointerAt = 0,
    keyboardFocus = false;
  addEventListener('pointerdown', () => (pointerAt = performance.now()), true);
  hudEl.addEventListener('focusin', () => (keyboardFocus = performance.now() - pointerAt > 300));

  addEventListener('keydown', (e) => {
    const path = e.composedPath();
    const t = path[0] as HTMLElement | undefined;
    // Alt-← / Alt-→: the inspector's history, never the browser's (which would leave the app)
    if (e.altKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      e.preventDefault();
      if (hud.modals.length) return;
      if (e.code === 'ArrowLeft') hud.back();
      else hud.forward();
      return;
    }
    if (e.code === 'F6') {
      e.preventDefault();
      hudEl.cycle(e.shiftKey);
      return;
    }
    const tag = t?.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || !!t?.isContentEditable;
    if (e.key === 'Escape') {
      // one thing per press, the core's first (escape.ts): the modal, the field, the lock, a menu, the search, the
      // inspector; then a plugin's Esc binding
      const to = handleEscape({
        modal: () => hud.modals.length > 0,
        closeModal: () => hud.closeModal(hud.modals.at(-1)!, false),
        typing: () => typing,
        locked: () => document.pointerLockElement === canvas,
        unlock: () => document.exitPointerLock(),
        closeMenus: () => hudEl.closeMenus(),
        searchOpen: () => hud.searchOpen,
        closeSearch: () => hud.closeSearch(),
        inspectorOpen: () => !!hud.subject,
        closeInspector: () => hud.closeInspector(),
        plugin: () => keyReg.handle(e),
      });
      if (to === 'plugin') e.preventDefault();
      return;
    }
    // a modal is open: no key reaches the view (the modal handles its keys itself; this catches focus that left it)
    if (hud.modals.length) return;
    if (typing) return;
    // a HUD control focused from the keyboard wants these; one focused by a mouse click doesn't keep the keys
    const inHud = path.includes(hudEl) && t !== hudEl;
    if (inHud && CONTROL_KEYS.includes(e.code) && keyboardFocus) return;
    keys[e.code] = true;
    if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (keyReg.handle(e)) e.preventDefault(); // (the registry runs a binding once per press: repeats are ignored)
  });
  addEventListener('keyup', (e) => {
    keys[e.code] = false;
    keyReg.release(e);
  });
  addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    keyReg.releaseAll();
  });

  const toNdc = (e: MouseEvent) => mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);

  canvas.addEventListener('click', (e) => {
    const locked = document.pointerLockElement === canvas;
    if (state.mode === 'walk' && !locked) {
      if (!hud.small) canvas.requestPointerLock?.();
      return;
    }
    if (state.mode !== 'walk') {
      toNdc(e);
      if (orbit.dragged) return;
    }
    const ndc = state.mode === 'walk' ? CENTRE_NDC : mouse;
    const subject = picker.at(ndc);
    const ev = { subject, shiftKey: e.shiftKey, handled: false };
    bus.emit('click', ev);
    if (ev.handled) return;
    if (subject) hud.inspect(subject);
    else hud.closeInspector();
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas) {
      player.yaw -= e.movementX * 0.0022;
      player.pitch = THREE.MathUtils.clamp(player.pitch - e.movementY * 0.0022, -1.5, 1.5);
    } else if (state.mode === 'orbit') {
      toNdc(e);
      if (e.buttons) orbit.dragged = true;
      if (e.target === canvas) {
        pointer.hoverT = -1;
        pointer.hoverAt = { x: e.clientX, y: e.clientY };
      } else if (pointer.hoverAt) {
        pointer.hoverAt = null; // over the HUD: no label
        hud.setHover(null, null);
      }
    } else toNdc(e);
  });
  canvas.addEventListener('pointerdown', () => {
    if (orbit.controls) orbit.dragged = false;
  });
}
