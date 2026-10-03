// The HUD: help, the flag row, the room list ("Go to"), and where you are.
import * as THREE from 'three';
import { storeyAt, storeyOfObject, type Layer, type Site } from '../site';
import type { Model } from './model';
import type { Walker } from './player';
import { esc } from './dom';
import { nodeName } from './three-utils';
import type { DomLookup, Mode, Player, PluginSlots, ViewState } from './types';
import { toPlan } from './units';

export interface Hud {
  help(show: boolean): void;
  helpHidden(): boolean;
  flags(): void;
  buildRoomMenu(): void;
  updateWhere(): void;
  /** the room id under the camera (walk mode), or null */
  hereRoom(): string | null;
}

export function createHud({
  site,
  state,
  player,
  model,
  walker,
  plugins,
  $,
  setMode,
}: {
  site: Site;
  state: ViewState;
  player: Player;
  model: Model;
  walker: Walker;
  plugins: PluginSlots;
  $: DomLookup;
  setMode: (mode: Mode) => void;
}): Hud {
  // Help: the key list, shown only on request (H, or the ? button in the top-left corner), and once on a browser's first
  // visit, so it doesn't cover the view and the HUD while the HUD's lists are in use.
  function help(show: boolean): void {
    $('help').classList.toggle('hidden', !show);
    if (show)
      try {
        localStorage.setItem('twin.helpSeen', '1');
      } catch {
        /* private mode */
      }
  }
  const helpHidden = () => $('help').classList.contains('hidden');

  // A layer's flag: one that starts hidden is named and lit while shown ('Doors'); any other is '<label> hidden', lit
  // while hidden. An extra model's layer also says when its model is loading or missing.
  function layerFlag(l: Layer): [string, boolean] {
    const hidden = !!state.hidden[l.id];
    const x = l.model ? model.extras[l.model] : null;
    if (x?.status === 'loading') return [`${l.label} loading…`, true];
    if (x?.status === 'failed') return [`No ${l.label.toLowerCase()} file`, hidden];
    return l.hidden ? [l.label, !hidden] : [`${l.label} hidden`, hidden];
  }
  // the layers with a flag: those with a key (the door layer among the viewer's own flags, extra models' at the end)
  const keyed = site.layers.filter((l) => l.code);
  const doorFlag = keyed.filter((l) => l.id === 'door');
  const siteFlags = keyed.filter((l) => l.id !== 'door' && !l.model);
  const modelFlags = keyed.filter((l) => l.id !== 'door' && l.model);

  function flags(): void {
    const { ha, faults, pins, switches } = plugins;
    const f: [string, boolean][] = [
      ['Walk', state.mode === 'walk'],
      ['Overview', state.mode === 'orbit'],
      ['Cutaway', state.cutaway],
      ['Upper hidden', state.upperHidden],
      ...doorFlag.map(layerFlag),
      ['Ghost', state.ghost],
      ['Crouch', player.crouched && !state.ghost],
      ...siteFlags.map(layerFlag),
      ...(ha?.engaged ? ([['HA faults through walls', ha.wallhack]] as [string, boolean][]) : []),
      ...(faults && ha?.engaged ? ([['All devices', faults.all]] as [string, boolean][]) : []),
      ...(pins ? ([[pins.on && pins.wall ? 'Pins through walls' : 'Pins', pins.on]] as [string, boolean][]) : []),
      ...(switches
        ? ([[switches.on && switches.wall ? 'Plates through walls' : 'Plates', switches.on]] as [string, boolean][])
        : []),
      ...modelFlags.map(layerFlag),
    ];
    $('flags').innerHTML = f.map(([n, on]) => `<span class="${on ? 'on' : ''}">${n}</span>`).join('');
    $('cross').classList.toggle('hidden', state.mode !== 'walk');
  }

  function goToRoom(node: THREE.Object3D): void {
    // the floor's bounding-box centre may miss an L-shaped room: search a grid for a point on this floor
    const b = node.userData.box as THREE.Box3,
      c = b.getCenter(new THREE.Vector3());
    const ray = walker.ray;
    const DOWN = new THREE.Vector3(0, -1, 0),
      tmp = new THREE.Vector3();
    let best: THREE.Vector3 | null = null;
    for (let r = 0; r <= 6 && !best; r++) {
      for (let i = -r; i <= r && !best; i++) {
        for (let j = -r; j <= r && !best; j++) {
          const x = c.x + ((i / 6) * (b.max.x - b.min.x)) / 2,
            z = c.z + ((j / 6) * (b.max.z - b.min.z)) / 2;
          ray.set(tmp.set(x, b.max.y + 1.5, z), DOWN);
          ray.far = 10;
          const h = ray.intersectObject(node, true)[0];
          const g = walker.castDown(x, b.max.y + 0.3, z);
          if (h && g && Math.abs(g.point.y - h.point.y) < 0.05) best = new THREE.Vector3(x, h.point.y, z);
        }
      }
    }
    if (!best) best = c.setY(b.max.y);
    if (state.mode !== 'walk') setMode('walk');
    const p = toPlan(best);
    walker.teleport(p.X, p.Y, p.Z, THREE.MathUtils.radToDeg(player.yaw));
  }

  function buildRoomMenu(): void {
    const sel = $<HTMLSelectElement>('rooms');
    // a room above the first storey is labelled with its storey's short name, e.g. 'Loft (upstairs)'
    const storeyNote = (n: THREE.Object3D) => {
      const s = storeyOfObject(site, (n.userData.box as THREE.Box3).min.y / site.unit);
      return s.index > 0 ? ` (${s.storey.short})` : '';
    };
    const list = model.rooms
      .map((n) => ({ n, label: String(n.userData.room).replace(/_/g, ' ') + storeyNote(n) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    for (const { n, label } of list) {
      const o = document.createElement('option');
      o.value = nodeName(n);
      o.textContent = label;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      const n = model.rooms.find((r) => nodeName(r) === sel.value);
      sel.value = '';
      sel.blur();
      if (n) goToRoom(n);
    });
  }

  let here: string | null = null;
  const DOWN = new THREE.Vector3(0, -1, 0),
    tmp = new THREE.Vector3();
  function updateWhere(): void {
    const pl = toPlan(player.pos);
    const g = walker.castDown(player.pos.x, player.pos.y + 0.3, player.pos.z);
    let room = '';
    if (g) {
      // collider triangles don't know their object; find the floor under the feet among the visible model
      const ray = walker.ray;
      ray.set(tmp.set(player.pos.x, player.pos.y + 0.3, player.pos.z), DOWN);
      ray.far = 1;
      const h = ray.intersectObjects(model.rooms, true)[0];
      if (h) room = String(model.ownerOf(h.object).userData.room).replace(/_/g, ' ');
    }
    here = state.mode === 'walk' && g && room ? room.replace(/ /g, '_') : null; // for the light pool
    const st = storeyAt(site, pl.Z);
    $('where').innerHTML =
      state.mode === 'walk'
        ? `<b>${esc(room || (st.index ? '' : 'outside / unnamed'))}</b> · ${esc(st.storey.name)}<br>plan X ${pl.X.toFixed(1)}, Y ${pl.Y.toFixed(1)}, floor Z ${pl.Z.toFixed(2)} ${site.units}`
        : 'Overview: drag to orbit, right-drag to pan, wheel to zoom';
  }

  return { help, helpHidden, flags, buildRoomMenu, updateWhere, hereRoom: () => here };
}
