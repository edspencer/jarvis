// The core's own contributions, made through the same plugin API as everything else: the movement and view keys,
// the layer chips (cutaway, upper storey, ghost and the site's layers), the place and crouch items, the Navigate panel
// (rooms by storey, viewpoints, a link to this view), the Object section every picked thing gets, and search over
// rooms, viewpoints and light fixtures.
import * as THREE from 'three';
import { storeyAt, storeyOfObject, type Layer, type Site } from '../site';
import type { Hud } from '../ui/hud';
import type { Model } from './model';
import type { Walker } from './player';
import type { Blocks, PluginContext, Subject, SubjectInfo, ViewApi } from './plugin/types';
import { nodeName } from './three-utils';
import { human } from './text';
import type { Player, ViewState } from './types';
import { FT, toPlan } from './units';
import { JUMP } from './player';

/** the keys the walker reads while they are held (KeyboardEvent.code) */
export const MOVEMENT_KEYS = [
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyQ',
  'KeyE',
  'KeyC',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ShiftLeft',
  'ShiftRight',
] as const;

export interface CoreParts {
  resolveRef(ref: string): Subject | null;
  describeObject(s: Extract<Subject, { kind: 'object' }>): SubjectInfo;
  /** the centre of an object's room, 4 ft over its floor (where fly() stands off towards), or null */
  roomCentreOf(node: THREE.Object3D): THREE.Vector3 | null;
}

const PREFIX: [RegExp, string][] = [
  [/^Fixture_/, 'Light fixture'],
  [/^Floor_/, 'Floor'],
  [/^Ceil_/, 'Ceiling'],
  [/^Roof_/, 'Roof'],
  [/^Win(Frame|Mull)?_/, 'Window'],
  [/^Door_/, 'Door'],
  [/^Wall_/, 'Wall'],
  [/^Stair/, 'Stair'],
];

/** a node's name as people read it: 'Fixture_den.fan' -> 'den fan' */
export function cleanName(name: string): string {
  return human(
    name
      .replace(/^(Fixture|Floor|Ceil|Roof|WinFrame|WinMull|Win|Door|Wall|D|Furn|Plant)_/, '')
      .replace(/[_.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || name,
  );
}

export function installCore({
  site,
  view,
  hud,
  state,
  player,
  walker,
  model,
  ctx,
  here,
}: {
  site: Site;
  view: ViewApi;
  hud: Hud;
  state: ViewState;
  player: Player;
  walker: Walker;
  model: Model;
  ctx: PluginContext;
  here: () => string | null;
}): CoreParts {
  const roomName = (id: string | null | undefined) => human(id);

  // ------------------------------------------------------------------ keys (help lists them; movement is held)
  const MOVE = 'Moving';
  const VIEW = 'View';
  for (const k of [
    { code: 'KeyW', label: 'Move (Shift runs)', display: 'W A S D / arrows' },
    { code: 'KeyC', label: 'Crouch and creep (walking) · sink (ghost); hold', display: 'C' },
    { code: 'KeyQ', label: 'Turn without the mouse', display: 'Q / E' },
    {
      code: 'Mouse',
      label: 'Click the view to walk (captures the mouse); click again to inspect what the crosshair is on',
      display: 'Click',
    },
  ])
    ctx.keys.add({ ...k, group: MOVE });
  // Every movement key, alone and with Shift (Shift runs), belongs to the core: they are held and read by the walker,
  // and listed here (hidden in help) so a plugin that binds one gets a conflict instead of firing on every step.
  for (const code of MOVEMENT_KEYS)
    for (const shift of [false, true]) {
      if (!shift && ['KeyW', 'KeyC', 'KeyQ', 'Space'].includes(code)) continue; // listed above / bound below
      ctx.keys.add({ code, shift, label: 'movement', group: MOVE, hidden: true });
    }
  ctx.keys.add({
    code: 'Space',
    label: 'Jump (walking) · rise (ghost)',
    group: MOVE,
    run: () => {
      if (state.mode === 'walk' && !state.ghost && player.onGround && !player.crouched) {
        player.vy = JUMP;
        player.onGround = false;
      }
    },
  });
  ctx.keys.add({
    code: 'Tab',
    label: 'Walk ↔ overview (orbit: drag to rotate, right-drag to pan, wheel to zoom, click to inspect)',
    group: VIEW,
    when: () => !hud.small,
    run: () => view.setMode(state.mode === 'walk' ? 'orbit' : 'walk'),
  });
  ctx.keys.add({ code: 'KeyH', label: 'Keys and help', group: VIEW, run: () => hud.help() });
  ctx.keys.add({
    code: 'Slash',
    shift: true,
    label: 'Keys and help',
    group: VIEW,
    hidden: true,
    run: () => hud.help(),
  });
  ctx.keys.add({
    code: 'Slash',
    label: 'Search: rooms, equipment, plates, devices…',
    group: VIEW,
    run: () => hud.openSearch(),
  });
  const n = site.viewpoints.length;
  site.viewpoints.slice(0, 9).forEach((v, i) =>
    ctx.keys.add({
      code: `Digit${i + 1}`,
      label:
        i === 0
          ? site.viewpoints
              .slice(0, 9)
              .map((x) => x.name)
              .join(' · ')
          : v.name,
      display: n > 1 ? `1 – ${Math.min(n, 9)}` : '1',
      group: VIEW,
      hidden: i > 0,
      run: () => view.teleport(...v.at, v.yaw),
    }),
  );

  // ------------------------------------------------------------------ chips: the view's toggles and the site's layers
  ctx.status.addToggle({
    id: 'core.cutaway',
    label: 'Cutaway',
    title: 'Hide roofs and ceilings',
    order: 10,
    key: { code: 'KeyX', label: 'Cutaway: hide roofs and ceilings', group: VIEW },
    get: () => state.cutaway,
    set: (v) => {
      state.cutaway = v;
      view.applyVisibility();
    },
  });
  if (site.storeys.length > 1)
    ctx.status.addToggle({
      id: 'core.upper',
      label: 'Hide upper',
      overflow: true,
      title: 'Hide the upper storey (and roofs)',
      order: 12,
      key: { code: 'KeyU', label: 'Hide the upper storey (and roofs)', group: VIEW },
      get: () => state.upperHidden,
      set: (v) => {
        state.upperHidden = v;
        view.applyVisibility();
      },
    });
  ctx.status.addToggle({
    id: 'core.ghost',
    label: 'Ghost',
    title: 'Fly through walls (Space up, C down); off: walk with collision',
    order: 14,
    key: { code: 'KeyG', label: 'Ghost: fly through walls (on at start); again to walk with collision', group: VIEW },
    when: () => state.mode === 'walk',
    get: () => state.ghost,
    set: (v) => {
      state.ghost = v;
      player.vy = 0;
      player.crouched = false;
    },
  });
  // a layer's chip: pressed while the layer is shown; an extra model's says when it is loading or missing
  const layerText = (l: Layer) => {
    const x = l.model ? model.extras[l.model] : null;
    if (x?.status === 'loading') return `${l.label}…`;
    if (x?.status === 'failed') return `No ${l.label.toLowerCase()}`;
    return l.label;
  };
  site.layers
    .filter((l) => l.code && !(l.id === 'roof' || l.id === 'ceiling'))
    .forEach((l, i) =>
      ctx.status.addToggle({
        id: `layer.${l.id}`,
        label: l.label,
        title: `Show / hide ${l.help}${l.model ? ' (it loads in the background after the main model)' : ''}`,
        order: l.id === 'door' ? 16 : 60 + i,
        overflow: true,
        key: { code: l.code!, label: `Show / hide ${l.help}`, group: 'Layers' },
        get: () => {
          const x = l.model ? model.extras[l.model] : null;
          return !state.hidden[l.id] && (!x || x.status === 'loaded');
        },
        set: () => view.toggleLayer(l.id),
        text: () => layerText(l),
      }),
    );

  // ------------------------------------------------------------------ status items
  ctx.status.addItem({
    id: 'core.place',
    order: 0,
    render: () => {
      if (state.mode !== 'walk') return { strong: 'Whole site', text: '· overview' };
      const pl = toPlan(player.pos);
      const st = storeyAt(site, pl.Z);
      const r = here();
      return {
        strong: r ? roomName(r) : st.index ? st.storey.name : 'Outside',
        text: r || !st.index ? `· ${st.storey.name}` : '',
        title: `plan X ${pl.X.toFixed(1)}, Y ${pl.Y.toFixed(1)}, floor Z ${pl.Z.toFixed(2)} ${site.units}`,
      };
    },
    onClick: () => navigate.toggle(),
  });
  ctx.status.addItem({
    id: 'core.crouch',
    order: 40,
    render: () =>
      state.mode === 'walk' && player.crouched && !state.ghost ? { text: 'Crouching', dot: 'info' } : null,
  });

  // ------------------------------------------------------------------ rooms
  const storeyIndexOf = (n: THREE.Object3D) =>
    storeyOfObject(site, (n.userData.box as THREE.Box3).min.y / site.unit).index;
  const rooms = () =>
    model.rooms
      .map((node) => ({
        node,
        id: String(node.userData.room),
        label: roomName(node.userData.room as string),
        storey: storeyIndexOf(node),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

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
    const p = toPlan(best);
    view.teleport(p.X, p.Y, p.Z, THREE.MathUtils.radToDeg(player.yaw));
  }

  function roomCentreOf(node: THREE.Object3D): THREE.Vector3 | null {
    const id = node.userData.room;
    const floor = id && model.rooms.find((r) => r.userData.room === id);
    if (!floor) return null;
    const b = floor.userData.box as THREE.Box3;
    return b.getCenter(new THREE.Vector3()).setY(b.max.y + 4 * FT);
  }

  // ------------------------------------------------------------------ the Navigate panel
  let roomQuery = '';
  const viewLink = (): string => {
    const u = new URL(location.href);
    for (const k of ['at', 'view', 'overview', 'auth_callback', 'code', 'state']) u.searchParams.delete(k);
    if (state.mode === 'walk') {
      const p = toPlan(player.pos);
      const yaw = THREE.MathUtils.radToDeg(player.yaw);
      u.searchParams.set('at', [p.X, p.Y, p.Z, yaw].map((v) => +v.toFixed(2)).join(','));
    } else u.searchParams.set('overview', '');
    return u.href.replace(/=(?=&|$)/g, '');
  };
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast({ text: `${what} copied`, tone: 'ok' });
    } catch {
      ctx.toast({ text: `Couldn't copy: ${text}`, tone: 'warn', sticky: true });
    }
  };
  const navigate = ctx.hud.addPanel({
    id: 'core.navigate',
    title: 'Navigate',
    icon: 'nav',
    order: 10,
    key: { code: 'KeyN', label: 'Navigate panel: rooms, viewpoints, a link to this view', group: VIEW },
    render: (body) =>
      body.blocks(() => {
        const q = roomQuery.trim().toLowerCase();
        const list = rooms().filter((r) => !q || r.label.toLowerCase().includes(q));
        const pl = toPlan(player.pos);
        const out: Blocks = [
          {
            type: 'kv',
            rows: [
              [
                'Here',
                state.mode === 'walk'
                  ? `${roomName(here()) || 'outside / unnamed'} · ${storeyAt(site, pl.Z).storey.name}`
                  : 'Overview',
              ],
              state.mode === 'walk' && [
                'Plan',
                { text: `X ${pl.X.toFixed(1)}, Y ${pl.Y.toFixed(1)}, Z ${pl.Z.toFixed(2)} ${site.units}`, mono: true },
              ],
            ],
          },
          {
            type: 'buttons',
            items: [{ label: 'Copy link to this view', onClick: () => copy(viewLink(), 'Link') }],
          },
          { type: 'label', text: 'Viewpoints' },
          {
            type: 'list',
            rows: site.viewpoints.map((v, i) => ({
              id: `vp${i}`,
              text: v.name,
              icon: 'camera',
              value: i < 9 ? String(i + 1) : '',
              run: () => view.teleport(...v.at, v.yaw),
            })),
          },
          { type: 'label', text: 'Rooms' },
          {
            type: 'search',
            id: 'core.rooms',
            value: roomQuery,
            placeholder: 'Filter rooms…',
            onInput: (v) => ((roomQuery = v), navigate.refresh()),
            onEnter: () => list[0] && goToRoom(list[0].node),
          },
        ];
        site.storeys.forEach((st, si) => {
          const rs = list.filter((r) => r.storey === si);
          if (!rs.length) return;
          out.push({
            type: 'group',
            id: `core.rooms.${si}`,
            title: st.name,
            count: rs.length,
            blocks: [
              {
                type: 'list',
                rows: rs.map((r) => ({
                  id: r.id + si,
                  text: r.label,
                  icon: 'room',
                  run: () => goToRoom(r.node),
                  selected: r.id === here(),
                })),
              },
            ],
          });
        });
        if (!list.length)
          out.push({ type: 'empty', text: model.rooms.length ? 'No room matches' : 'The model names no rooms' });
        return out;
      }),
  });
  let navT = 0; // keep the "Here" rows current while the panel is open
  ctx.events.on('frame', ({ dt }) => {
    navT -= dt;
    if (navT > 0 || !navigate.isOpen) return;
    navT = 0.5;
    navigate.refresh();
  });

  // ------------------------------------------------------------------ the Object section (and every object's header)
  const typeOf = (node: THREE.Object3D, part?: { name: string } | null): string => {
    const name = part?.name || nodeName(node);
    const kind =
      PREFIX.find(([re]) => re.test(name))?.[1] || (node.userData.layer ? human(node.userData.layer) : 'Object');
    const room = node.userData.room ? roomName(node.userData.room as string) : '';
    return [kind, room].filter(Boolean).join(' · ');
  };
  function describeObject(s: Extract<Subject, { kind: 'object' }>): SubjectInfo {
    const name = s.part?.name || nodeName(s.node);
    return {
      title: cleanName(name),
      type: typeOf(s.node, s.part),
      icon: s.node.userData.fixture_id
        ? 'bulb'
        : s.node.userData.room && /^Floor_/.test(nodeName(s.node))
          ? 'room'
          : 'cube',
      crumbs: s.node.userData.room ? [roomName(s.node.userData.room as string)] : undefined,
    };
  }
  ctx.inspector.addSection({
    id: 'core.object',
    title: 'Object',
    icon: 'cube',
    order: 90, // last: the developer's view (the spec's "base first" put it at the top; collapsed, it read as clutter)
    defaultCollapsed: true,
    for: (s) => {
      const hitRow = s.hit
        ? (() => {
            const at = toPlan(s.hit.point);
            return {
              text: `X ${at.X.toFixed(2)}, Y ${at.Y.toFixed(2)}, Z ${at.Z.toFixed(2)} ${site.units}`,
              mono: true,
            };
          })()
        : null;
      if (s.kind === 'item') {
        if (!hitRow) return null;
        return { blocks: [{ type: 'kv', rows: [['Hit at', hitRow]] }] };
      }
      const u: Record<string, unknown> = s.part ? { ...s.part.props } : { ...s.node.userData };
      delete u.box;
      delete u.name;
      delete u.merged;
      delete u.plantOwners;
      // the mesh's own material (its name), not an override drawn over it
      const hitMesh = s.hit?.object as THREE.Mesh | undefined;
      const own = hitMesh?.material ? ctx.three.materials.base(hitMesh) : undefined;
      const mat = Array.isArray(own) ? undefined : own;
      const rows: [string, string | { text: string; mono: boolean }][] = [
        ['Node', { text: nodeName(s.node), mono: true }],
      ];
      if (s.part) rows.push(['Part', { text: s.part.name, mono: true }]);
      for (const [k, v] of Object.entries(u))
        rows.push([
          human(k),
          { text: typeof v === 'object' ? JSON.stringify(v) : String(v), mono: typeof v === 'object' },
        ]);
      if (mat?.name) rows.push(['Material', { text: mat.name, mono: true }]);
      if (hitRow) rows.push(['Hit at', hitRow]);
      const p = s.hit ? toPlan(s.hit.point) : null;
      return {
        blocks: [
          { type: 'kv', rows },
          p && {
            type: 'buttons',
            items: [
              {
                label: 'Copy position',
                onClick: () => copy(`${p.X.toFixed(2)}, ${p.Y.toFixed(2)}, ${p.Z.toFixed(2)}`, 'Position'),
              },
            ],
          },
        ],
      };
    },
  });

  // ------------------------------------------------------------------ search: rooms, viewpoints, fixtures
  ctx.search.add({
    id: 'core.rooms',
    label: 'Rooms',
    order: 10,
    search: (q) =>
      rooms()
        .filter((r) => r.label.toLowerCase().includes(q))
        .map((r) => ({
          text: r.label,
          secondary: site.storeys[r.storey]?.name,
          icon: 'room',
          run: () => goToRoom(r.node),
        })),
  });
  ctx.search.add({
    id: 'core.viewpoints',
    label: 'Viewpoints',
    order: 12,
    search: (q) =>
      site.viewpoints
        .map((v, i) => ({ v, i }))
        .filter(({ v }) => v.name.toLowerCase().includes(q))
        .map(({ v, i }) => ({
          text: v.name,
          secondary: i < 9 ? `key ${i + 1}` : undefined,
          icon: 'camera',
          run: () => view.teleport(...v.at, v.yaw),
        })),
  });
  ctx.search.add({
    id: 'core.fixtures',
    label: 'Light fixtures',
    order: 40,
    search: (q) =>
      Object.entries(model.fixtures)
        .filter(([id, n]) =>
          `${id} ${n.userData.room || ''} ${n.userData.fixture_kind || ''}`
            .toLowerCase()
            .replace(/_/g, ' ')
            .includes(q),
        )
        .map(([id, n]) => ({
          text: cleanName(id),
          secondary: [human(n.userData.fixture_kind), roomName(n.userData.room as string)].filter(Boolean).join(' · '),
          icon: 'bulb',
          subject: `fixture:${id}`,
        })),
  });

  function resolveRef(ref: string): Subject | null {
    const i = ref.indexOf(':');
    const kind = ref.slice(0, i),
      id = ref.slice(i + 1);
    if (kind === 'fixture') {
      const node = model.fixtures[id];
      return node ? { kind: 'object', node } : null;
    }
    if (kind === 'room') {
      const node = model.rooms.find((r) => r.userData.room === id);
      return node ? { kind: 'object', node } : null;
    }
    return null;
  }

  return { resolveRef, describeObject, roomCentreOf };
}
