// Touch in the walk view (hud-panels.md §1, small screens and touch): drag on the view to look around, tap to inspect
// what is under the finger. The thumb-stick that moves is a HUD element (<jv-stick>, ui/shell.ts) feeding the walker's
// analog input. Pointer Events, touch only (pointerType 'touch'): the mouse keeps its pointer lock (input.ts). One
// finger looks at a time; another on the stick moves at once.
import * as THREE from 'three';
import type { Hud } from '../ui/hud';
import type { Picker } from './inspect';
import type { Bus } from './plugin/events';
import type { Player, ViewState } from './types';

/** a touch that travels further than this (CSS px) is a drag (look), not a tap */
export const TAP_SLOP = 10;
/** a touch held longer than this (ms) isn't a tap */
export const TAP_MS = 500;

export function bindTouch({
  canvas,
  state,
  player,
  hud,
  picker,
  bus,
}: {
  canvas: HTMLCanvasElement;
  state: ViewState;
  player: Player;
  hud: Hud;
  picker: Picker;
  bus: Bus;
}): void {
  canvas.style.touchAction = 'none'; // no browser panning or zooming on the view (the overview's controls set it too)
  const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
  // the stick shows for a finger, and goes for a mouse (unless the screen's main pointer is a finger)
  addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch') hud.setTouch(true);
      else if (e.pointerType === 'mouse' && !coarse?.matches) hud.setTouch(false);
    },
    true,
  );

  let look: { id: number; x: number; y: number; x0: number; y0: number; t0: number; moved: boolean } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || state.mode !== 'walk' || look) return;
    look = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, moved: false };
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!look || e.pointerId !== look.id) return;
    if (!look.moved) {
      if (Math.hypot(e.clientX - look.x0, e.clientY - look.y0) <= TAP_SLOP) return;
      look.moved = true; // from here on a drag: turn from this point (no jump by the slop)
      look.x = e.clientX;
      look.y = e.clientY;
      return;
    }
    // as a game's look stick: drag right to turn right, up to look up; across the screen's width turns half way round
    const k = Math.PI / Math.max(innerWidth, 320);
    player.yaw -= (e.clientX - look.x) * k;
    player.pitch = THREE.MathUtils.clamp(player.pitch - (e.clientY - look.y) * k, -1.5, 1.5);
    look.x = e.clientX;
    look.y = e.clientY;
  });
  const end = (e: PointerEvent, cancelled: boolean) => {
    if (!look || e.pointerId !== look.id) return;
    const l = look;
    look = null;
    if (cancelled || l.moved || e.timeStamp - l.t0 > TAP_MS || state.mode !== 'walk') return;
    tap(e.clientX, e.clientY, e.shiftKey);
  };
  canvas.addEventListener('pointerup', (e) => end(e, false));
  canvas.addEventListener('pointercancel', (e) => end(e, true));

  const ndc = new THREE.Vector2();
  /** a tap picks at the finger, as a click does at the mouse in the overview */
  function tap(x: number, y: number, shiftKey: boolean): void {
    ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    const subject = picker.at(ndc);
    const ev = { subject, shiftKey, handled: false };
    bus.emit('click', ev);
    if (ev.handled) return;
    if (!subject) return hud.closeInspector();
    // a phone: the inspector opens as a peek sheet, so the view (and the stick) stay usable; drag it up to read
    if (hud.small && !hud.subject) hud.sheet = 'peek';
    hud.inspect(subject);
  }
}
