// Keyboard and mouse.
import * as THREE from 'three';
import type { Site } from '../site';
import type { Blueprints } from './blueprints';
import type { Hud } from './hud';
import type { Inspect } from './inspect';
import type { Model } from './model';
import { JUMP, type Walker } from './player';
import type { DomLookup, Keys, Mode, Player, PluginSlots, ViewState } from './types';

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

export function bindInput({
  site,
  canvas,
  state,
  keys,
  player,
  model,
  walker,
  hud,
  inspect,
  blueprints,
  plugins,
  orbit,
  pointer,
  $,
  setMode,
  applyVisibility,
}: {
  site: Site;
  canvas: HTMLCanvasElement;
  state: ViewState;
  keys: Keys;
  player: Player;
  model: Model;
  walker: Walker;
  hud: Hud;
  inspect: Inspect;
  blueprints: Blueprints;
  plugins: PluginSlots;
  orbit: OrbitHolder;
  pointer: Pointer;
  $: DomLookup;
  setMode: (mode: Mode) => void;
  applyVisibility: () => void;
}): void {
  const { mouse } = pointer;
  const layerByCode = new Map(site.layers.filter((l) => l.code).map((l) => [l.code!, l]));

  // a site layer's key: show / hide it; an extra model's layer loads its model first (if it was left with ?noextra,
  // or is still on its way)
  function toggleLayer(id: string): void {
    const l = site.layers.find((x) => x.id === id)!;
    const x = l.model ? model.extras[l.model] : null;
    if (x && x.status !== 'loaded') {
      state.hidden[id] = false;
      model.loadExtra(x.model.id);
      return;
    }
    state.hidden[id] = !state.hidden[id];
    applyVisibility();
  }

  // Home Assistant: switch the light under the crosshair (walking) or the mouse (overview): T, or Shift-click. A plain
  // click stays "inspect", so looking at a light never switches it. During a blink test it answers "this one blinked".
  function switchAt(ndc: THREE.Vector2): void {
    const ha = plugins.ha;
    const p = inspect.pick(ndc);
    const fid = p?.node.userData.fixture_id as string | undefined;
    if (!fid || !ha?.engaged) return;
    if (ha.blink.active) ha.blinkAnswer(fid);
    else ha.toggleFixture(fid);
    inspect.showInfo(p);
  }

  addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'SELECT' || tag === 'INPUT') return;
    keys[e.code] = true;
    if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    const { ha, faults, pins, switches } = plugins;
    switch (e.code) {
      case 'Tab':
        setMode(state.mode === 'walk' ? 'orbit' : 'walk');
        break;
      case 'KeyX': // C is crouch (held), as in games
        state.cutaway = !state.cutaway;
        applyVisibility();
        break;
      case 'KeyU':
        state.upperHidden = !state.upperHidden;
        applyVisibility();
        break;
      case 'KeyB': // the last sheet shown, or the default the first time
        blueprints.toggle();
        break;
      case 'KeyG':
        state.ghost = !state.ghost;
        player.vy = 0;
        player.crouched = false;
        hud.flags();
        break;
      case 'KeyH':
        hud.help(hud.helpHidden());
        break;
      case 'KeyV': // Home Assistant: faults through walls (every device); Shift-V: healthy devices too
        if (ha?.engaged) {
          if (e.shiftKey && faults) {
            faults.setAll(!faults.all);
            if (!ha.wallhack) ha.setWallhack(true);
          } else ha.setWallhack(!ha.wallhack);
        }
        break;
      case 'KeyL': // wall plates
        if (switches) {
          if (e.shiftKey) switches.setWall(!switches.wall);
          else switches.setOn(!switches.on);
          hud.flags();
        }
        break;
      case 'KeyP': // equipment pins
        if (pins) {
          if (e.shiftKey) pins.setWall(!pins.wall);
          else pins.setOn(!pins.on);
          hud.flags();
        }
        break;
      case 'Slash':
        if (pins) {
          e.preventDefault();
          if (document.pointerLockElement) document.exitPointerLock();
          $('pinsearch').focus();
        }
        break;
      case 'KeyT': // Home Assistant: switch a light
        switchAt(state.mode === 'walk' && document.pointerLockElement ? CENTRE_NDC : mouse);
        break;
      case 'Space':
        if (state.mode === 'walk' && !state.ghost && player.onGround && !player.crouched) {
          player.vy = JUMP;
          player.onGround = false;
        }
        break;
      default: {
        const layer = layerByCode.get(e.code);
        if (layer) {
          toggleLayer(layer.id);
          break;
        }
        const k = /^Digit([1-9])$/.exec(e.code);
        const v = k && site.viewpoints[+k[1] - 1];
        if (v) {
          if (state.mode !== 'walk') setMode('walk');
          walker.teleport(...v.at, v.yaw);
        }
      }
    }
  });
  addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });
  addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
  });

  const toNdc = (e: MouseEvent) => mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);

  canvas.addEventListener('click', (e) => {
    const { ha, faults, pins } = plugins;
    if (e.shiftKey && ha?.engaged && (state.mode !== 'walk' || document.pointerLockElement)) {
      if (state.mode !== 'walk') toNdc(e);
      if (state.mode === 'walk' || !orbit.dragged) switchAt(state.mode === 'walk' ? CENTRE_NDC : mouse);
      return;
    }
    // a device fault marker, then an equipment pin, under the crosshair / mouse wins over the model behind it
    const inspectAt = (ndc: THREE.Vector2) => {
      const dev = faults?.at(ndc);
      if (dev) {
        faults!.show(dev);
        return;
      }
      const pin = pins?.at(ndc);
      if (pin) pins!.show(pin.id);
      else inspect.showInfo(inspect.pick(ndc));
    };
    if (state.mode === 'walk') {
      if (document.pointerLockElement) inspectAt(CENTRE_NDC);
      else canvas.requestPointerLock?.();
    } else {
      toNdc(e);
      if (!orbit.dragged) inspectAt(mouse);
    }
  });
  $('helpbtn').addEventListener('click', (e) => {
    (e.target as HTMLElement).blur();
    hud.help(hud.helpHidden());
  });
  $('help').addEventListener('click', () => hud.help(false)); // closes it; a click on the view starts walking
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    if (locked) hud.help(false);
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas) {
      player.yaw -= e.movementX * 0.0022;
      player.pitch = THREE.MathUtils.clamp(player.pitch - e.movementY * 0.0022, -1.5, 1.5);
    } else if (state.mode === 'orbit') {
      toNdc(e);
      if (e.buttons) orbit.dragged = true;
      pointer.hoverT = -1;
      pointer.hoverAt = { x: e.clientX, y: e.clientY };
    }
  });
  canvas.addEventListener('pointerdown', () => {
    if (orbit.controls) orbit.dragged = false;
  });
}
