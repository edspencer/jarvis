// Wall plates (switches and outlets). The model puts every plate in the main model as its own node under one group
// (extras layer: switches): Switch_<box_id> (or Switch_unknown_<room>_<n>) with extras {plate_id, box_id, room, kind,
// gangs, style, devices, conf, id_conf, notes, positions: [{pos, role, breaker, fixture_ids, ha_entity, link}]}, and a
// child per device (paddle, dial, button, lever…). Parts with the same shape share one glTF mesh.
//
// - Drawing: the glb's plate nodes are taken out of the scene and every (geometry, material) pair becomes one
//   THREE.InstancedMesh, with each part's world matrix as an instance. A few dozen plates cost one draw call per shape
//   instead of one per part. instanceId -> plate (`owner` arrays) keeps per-plate picking.
// - Picking: the core's pick() finds the instanced mesh like any other mesh; plateOf(hit) turns the hit into a plate
//   (with a proxy Object3D carrying the plate's extras), and showInfo() hands plates to info() here.
// - Highlight (L, the HUD; filter switches / outlets / both): plates are tinted (instance colour: amber switches, blue
//   outlets) and get a marker each (one THREE.Points); Shift-L draws the markers through walls. The selected plate is
//   tinted and keeps a pulsing marker through walls.
// - Links in the panel: a position's fixtures fly to the fixture and mark it (the pins layer's markFixtures, the same
//   marker an equipment pin's "light fixtures" link uses); a box-to-box link selects and flies to that plate, or says
//   it is not located; box ids written in roles and notes are links too, and a plate named in another plate's notes is
//   listed on that plate ("see:", "named in"); a position with an ha_entity shows its state and, in ?ha=mock only, a
//   toggle through the HA layer's allowlist (togglePlateEntity). Live Home Assistant is never switched from a plate.
import * as THREE from 'three';
import { storeyOfObject, type Site, type SwitchesConfig } from '../../site';
import type { DomLookup, Escape, Fixtures, FlyFn } from '../../core/types';
import { isMesh } from '../../core/three-utils';
import { FT } from '../../core/units';
import type { HA } from '../home-assistant/ha';
import type { Pins } from '../pins/pins';

const MARK_KNOWN = '#ffb43c',
  MARK_OUTLET = '#4fd3ff',
  MARK_UNKNOWN = '#e055ff',
  SELECT = '#ff7a1a';
const TINT = { switch: '#ffd27a', outlet: '#9fe6ff' }; // highlighted plates (instance colour multiplies the plate's own)

export interface PlatePosition {
  pos: string | number;
  role?: string;
  breaker?: string;
  fixture_ids?: string[];
  ha_entity?: string;
  ha_group?: string;
  link?: { box?: string; pos?: string | number; dir?: 'to' | 'from' | 'with' };
}

/** a plate node's extras */
export interface PlateExtras {
  plate_id: string;
  box_id?: string | null;
  room?: string;
  kind?: 'switch' | 'outlet' | string;
  gangs?: number;
  gangs_note?: string;
  style?: string;
  colour?: string;
  mount?: string;
  devices?: string[];
  conf?: string;
  id_conf?: string;
  notes?: string;
  wall?: string;
  file?: string;
  z?: number;
  positions?: PlatePosition[];
  [key: string]: unknown;
}

export interface Plate {
  id: string;
  box: string | null;
  d: PlateExtras;
  /** a stand-in node carrying the plate's extras (for the inspect panel) */
  node: THREE.Object3D;
  centre: THREE.Vector3;
  /** out of the wall */
  normal: THREE.Vector3;
  /** [instanced mesh, instance index] for each of its parts */
  parts: [THREE.InstancedMesh, number][];
}

type Markers = THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
type Kind = 'switch' | 'outlet' | 'both';

export interface SwitchesDeps {
  config: SwitchesConfig;
  site: Pick<Site, 'storeys' | 'unit'>;
  scene: THREE.Scene;
  root: THREE.Object3D;
  camera: THREE.Camera;
  fixtures: Fixtures;
  $: DomLookup;
  esc: Escape;
  fly: FlyFn;
  getPins: () => Pins | null;
  getHA: () => HA | null;
  /** the panel closed (null) */
  showPanel?: (p: Plate | null) => void;
}

export function createSwitches({
  config,
  site,
  scene,
  root,
  camera,
  fixtures,
  $,
  esc,
  fly,
  getPins,
  getHA,
  showPanel,
}: SwitchesDeps) {
  const q = new URLSearchParams(location.search);
  const qk = q.get('plates');
  /** box ids in notes and roles (set once the plates are in) */
  let boxRe: RegExp | null = null;
  const sw = {
    plates: [] as Plate[],
    byBox: {} as Record<string, Plate>,
    byId: {} as Record<string, Plate>,
    meshes: [] as THREE.InstancedMesh[],
    raw: null as THREE.Object3D | null,
    on: q.has('plates'),
    wall: q.has('plateswall'),
    kind: (qk === 'switch' || qk === 'outlet' ? qk : 'both') as Kind,
    selected: null as Plate | null,
    group: null as THREE.Group | null,
    glow: [] as THREE.Material[],
    /** box id (or box#pos) -> [plates whose notes or roles name it] */
    mentions: {} as Record<string, Plate[]>,
  };
  const kindOf = (p: Plate): 'switch' | 'outlet' => (p.d.kind === 'outlet' ? 'outlet' : 'switch');
  const shownKind = (p: Plate) => sw.kind === 'both' || kindOf(p) === sw.kind;

  // ------------------------------------------------------------------ from the glb's nodes to instanced meshes
  function adopt(plateRoot: THREE.Object3D): THREE.Group {
    sw.raw = plateRoot;
    plateRoot.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert();
    const plateNodes: THREE.Object3D[] = [];
    plateRoot.traverse((o) => {
      if (o.userData?.plate_id) plateNodes.push(o);
    });
    for (const n of plateNodes) {
      const d = n.userData as PlateExtras;
      const proxy = new THREE.Object3D();
      proxy.name = n.name;
      proxy.userData = { ...d };
      const box = new THREE.Box3().setFromObject(n);
      const p: Plate = {
        id: d.plate_id,
        box: d.box_id || null,
        d,
        node: proxy,
        centre: box.getCenter(new THREE.Vector3()),
        // the source's local -y (out of the wall) = glTF +z
        normal: new THREE.Vector3(0, 0, 1).transformDirection(n.matrixWorld).normalize(),
        parts: [],
      };
      proxy.userData.plate = p;
      sw.plates.push(p);
      sw.byId[p.id] = p;
      if (p.box) sw.byBox[p.box] = p;
    }
    // Box ids written in notes and roles: the site's pattern (group 1 the box, group 2 an optional position), else the
    // plates' own box ids as they are written, each optionally followed by #<position>
    const known = Object.keys(sw.byBox).sort((x, y) => y.length - x.length);
    const reEsc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    boxRe = config.boxIdPattern
      ? new RegExp(config.boxIdPattern, 'g')
      : known.length
        ? new RegExp(`(?<![\\w-])(${known.map(reEsc).join('|')})(?:#([0-9]+[A-Z]?))?(?![\\w-])`, 'g')
        : null;
    // text references: the sheet's own links are structured (positions[].link), but many relations are only written
    // in a role or a note ("a duplex underneath <box>", "it is <box>#5B"); index every box id named
    for (const p of sw.plates) {
      if (!boxRe) break;
      const text = [p.d.notes, p.d.gangs_note, ...(p.d.positions || []).map((x) => x.role)].filter(Boolean).join(' ');
      for (const m of text.matchAll(boxRe)) {
        if (m[1] === p.box) continue;
        for (const k of m[2] ? [m[1], `${m[1]}#${m[2]}`] : [m[1]]) {
          const list = (sw.mentions[k] ||= []);
          if (!list.includes(p)) list.push(p);
        }
      }
    }
    // group every mesh under a plate by (geometry, material): one InstancedMesh each
    const groups = new Map<
      string,
      { geometry: THREE.BufferGeometry; material: THREE.Material; items: { m: THREE.Matrix4; plate: Plate }[] }
    >();
    for (const p of sw.plates) {
      const n = plateNodes[sw.plates.indexOf(p)];
      n.traverse((o) => {
        if (!isMesh(o)) return;
        let owner: THREE.Object3D | null = o;
        while (owner && !owner.userData?.plate_id) owner = owner.parent;
        if (owner !== n) return; // (a plate's own subtree only)
        const material = o.material as THREE.Material;
        const k = `${o.geometry.uuid}|${material.uuid}`;
        if (!groups.has(k)) groups.set(k, { geometry: o.geometry, material, items: [] });
        groups.get(k)!.items.push({ m: inv.clone().multiply(o.matrixWorld), plate: p });
      });
    }
    const g = new THREE.Group();
    g.name = 'Switches_instanced';
    g.userData.layer = 'switches';
    for (const { geometry, material, items } of groups.values()) {
      const mat = material.clone(); // own copy (the viewer may restyle it; the glb stays untouched)
      sw.glow.push(mat);
      const im = new THREE.InstancedMesh(geometry, mat, items.length);
      items.forEach((it, i) => {
        im.setMatrixAt(i, it.m);
        im.setColorAt(i, new THREE.Color(1, 1, 1));
        it.plate.parts.push([im, i]);
      });
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor!.needsUpdate = true;
      im.computeBoundingBox();
      im.computeBoundingSphere();
      im.userData.switchOwners = items.map((it) => it.plate);
      im.castShadow = false;
      im.receiveShadow = true;
      im.name = `Switches_${geometry.name || sw.meshes.length}`;
      sw.meshes.push(im);
      g.add(im);
    }
    plateRoot.parent?.remove(plateRoot);
    root.add(g);
    sw.group = g;
    marks();
    refresh();
    return g;
  }

  // the plate behind a raycast hit on one of the instanced meshes (or null)
  function plateOf(hit: THREE.Intersection | null | undefined): Plate | null {
    const o = hit?.object;
    const owners = o?.userData.switchOwners as Plate[] | undefined;
    if (!owners || hit!.instanceId == null) return null;
    return owners[hit!.instanceId] || null;
  }

  // ------------------------------------------------------------------ markers (highlight and the selected plate)
  let main: Markers | null = null,
    xray: Markers | null = null,
    sel: Markers | null = null;
  function pointsMat(over: boolean, size: number): THREE.PointsMaterial {
    return new THREE.PointsMaterial({
      size,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      depthTest: !over,
      toneMapped: false,
      map: dot(),
      alphaTest: 0.05,
    });
  }
  let dotTex: THREE.CanvasTexture | null = null;
  function dot(): THREE.CanvasTexture {
    if (dotTex) return dotTex;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d')!;
    x.fillStyle = '#111';
    x.beginPath();
    x.arc(16, 16, 15, 0, 7);
    x.fill();
    x.fillStyle = '#fff';
    x.beginPath();
    x.arc(16, 16, 11, 0, 7);
    x.fill();
    x.fillStyle = '#111';
    x.fillRect(13, 9, 6, 14); // a rocker
    dotTex = new THREE.CanvasTexture(c);
    return dotTex;
  }
  function pts(n: number, mat: THREE.PointsMaterial, order: number, name: string): Markers {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const p = new THREE.Points(g, mat);
    p.frustumCulled = false;
    p.renderOrder = order;
    p.name = name;
    p.visible = false;
    scene.add(p);
    return p;
  }
  const at = (p: Plate) => p.centre.clone().addScaledVector(p.normal, 0.04); // 4 cm off the wall
  function write(points: Markers, list: Plate[]): void {
    const a = points.geometry.attributes as Record<'position' | 'color', THREE.BufferAttribute>,
      c = new THREE.Color();
    list.forEach((p, i) => {
      const v = at(p);
      a.position.setXYZ(i, v.x, v.y, v.z);
      c.set(!p.box ? MARK_UNKNOWN : kindOf(p) === 'outlet' ? MARK_OUTLET : MARK_KNOWN);
      a.color.setXYZ(i, c.r, c.g, c.b);
    });
    points.geometry.setDrawRange(0, list.length);
    a.position.needsUpdate = a.color.needsUpdate = true;
  }
  function marks(): void {
    main = pts(sw.plates.length, pointsMat(false, 16), 6, 'Switches_marks');
    xray = pts(sw.plates.length, pointsMat(true, 14), 997, 'Switches_marks_through_walls');
    xray.material.opacity = 0.7;
    sel = pts(1, pointsMat(true, 22), 999, 'Switches_selected');
  }

  function refresh(): void {
    const shown = sw.group && sw.group.visible !== false;
    const lit = sw.plates.filter(shownKind);
    if (main && xray) {
      write(main, lit);
      write(xray, lit);
      main.visible = !!(sw.on && shown);
      xray.visible = !!(sw.on && sw.wall && shown);
    }
    const s = sw.selected;
    for (const p of sw.plates) {
      const c = p === s ? SELECT : sw.on && shownKind(p) ? TINT[kindOf(p)] : '#ffffff';
      for (const [im, i] of p.parts) im.setColorAt(i, new THREE.Color(c));
    }
    for (const im of sw.meshes) im.instanceColor!.needsUpdate = true;
    if (sel) {
      if (s) write(sel, [s]);
      sel.visible = !!s;
    }
    if ($('plateson')) {
      $<HTMLInputElement>('plateson').checked = sw.on;
      $<HTMLInputElement>('plateswall').checked = sw.wall;
      $<HTMLSelectElement>('platekind').value = sw.kind;
    }
    if ($('platecount'))
      $('platecount').textContent = sw.on ? `${lit.length} (${lit.filter((p) => !p.box).length} unknown)` : '';
  }
  function setOn(on: boolean): void {
    sw.on = on;
    refresh();
  }
  function setKind(k: string): void {
    sw.kind = k === 'switch' || k === 'outlet' ? k : 'both';
    refresh();
  }
  function setWall(on: boolean): void {
    sw.wall = on;
    if (on) sw.on = true;
    refresh();
  }
  let t = 0;
  function update(dt: number): void {
    if (!sel?.visible) return;
    t += dt;
    sel.material.size = 22 + 6 * Math.sin(t * 6);
  }

  // ------------------------------------------------------------------ the inspect panel
  const title = (p: Plate) => p.box || 'unknown plate';
  const human = (s: unknown) => String(s ?? '').replace(/_/g, ' ');
  function fixtureLinks(fids: string[] | undefined): string {
    if (!fids?.length) return '';
    const ha = getHA?.();
    return (
      fids
        .map((f) => {
          const known = !!fixtures[f];
          const st = ha && known ? ha.hoverSuffix(f) : '';
          return known
            ? `<a href="#" data-swfix="${esc(f)}" title="fly to ${esc(f)}">${esc(f)}</a>${st ? `<span class="pinnote">${esc(st)}</span>` : ''}`
            : `<span title="not a fixture in this model">${esc(f)} <i>(not in model)</i></span>`;
        })
        .join(', ') +
      (fids.length > 1 && fids.every((f) => fixtures[f])
        ? ` <a href="#" data-swfix="${esc(fids.join(' '))}">(all)</a>`
        : '')
    );
  }
  function boxLink(l: PlatePosition['link']): string {
    if (!l?.box) return '';
    const label = `${l.dir === 'from' ? 'From' : l.dir === 'with' ? 'With' : 'To'} ${l.box}${l.pos ? `#${l.pos}` : ''}`;
    return sw.byBox[l.box]
      ? `<a href="#" data-swbox="${esc(l.box)}" title="fly to ${esc(l.box)}">${esc(label)}</a>`
      : `${esc(label)} <span class="pinnote">(not located)</span>`;
  }
  function haCell(e: string | undefined): string {
    const ha = getHA?.();
    if (!e) return '';
    let s = `<code>${esc(e)}</code>`;
    const st = ha?.engaged ? ha.entities[e]?.state : null;
    if (st) s += ` <span class="pinnote">${esc(st)}</span>`;
    if (ha?.mode === 'mock' && ha.engaged)
      s += ` <button type="button" class="swtoggle" data-swha="${esc(e)}">Toggle (mock)</button>`;
    else s += ' <span class="pinnote">(switching from a plate: ?ha=mock only)</span>';
    return s;
  }
  // a note or role with every box id in it as a link (to that plate, or marked not located)
  function linkText(t: string): string {
    if (!boxRe) return esc(t);
    return esc(t).replace(boxRe, (all, box: string) =>
      sw.byBox[box]
        ? `<a href="#" data-swbox="${esc(box)}" title="fly to ${esc(box)}">${all}</a>`
        : `${all}<span class="pinnote"> (not located)</span>`,
    );
  }
  const plateLink = (o: Plate) =>
    `<a href="#" data-swplate="${esc(o.id)}" title="fly to it">${esc(o.box || o.id.replace(/_/g, ' '))}</a>` +
    ` <span class="pinnote">(${kindOf(o)}${o.box ? '' : ', unknown plate'})</span>`;
  function info(p: Plate, extraRows: string[] = []): void {
    const d = p.d,
      el = $('info');
    const row = (k: string, v: string | null | undefined, cls = '') =>
      v === null || v === undefined || v === '' ? '' : `<tr class="${cls}"><td>${esc(k)}</td><td>${v}</td></tr>`;
    const rows: string[] = [];
    rows.push(row('kind', esc(kindOf(p))));
    rows.push(row('room', esc(human(d.room))));
    rows.push(
      row(
        'plate',
        esc(
          `${d.gangs}-gang ${d.style || 'decora'}${d.colour && d.colour !== 'white' ? `, ${d.colour}` : ''}${d.mount && d.mount !== 'wall' ? `, on ${d.mount}` : ''}`,
        ) + (d.devices?.length ? ` <span class="pinnote">(${esc(d.devices.join(', '))})</span>` : ''),
      ),
    );
    rows.push(row('conf', esc(`position ${d.conf || '?'} · identity ${d.id_conf || '?'}`)));
    if (d.wall) rows.push(row('wall', `<code>${esc(d.wall)}</code>`));
    if (d.notes) rows.push(row('notes', `<span class="pinnote">${linkText(d.notes)}</span>`));
    if (d.gangs_note) rows.push(row('gangs', `<span class="pinnote">${esc(d.gangs_note)}</span>`));
    for (const ps of d.positions || []) {
      const parts: string[] = [];
      parts.push(
        `<b>${ps.role ? linkText(ps.role) : 'role unknown'}</b>${ps.breaker ? ` · breaker ${esc(ps.breaker)}` : ''}`,
      );
      const named = p.box && sw.mentions[`${p.box}#${ps.pos}`]; // a plate whose notes say it is this position
      // an outlet first when the role speaks of an outlet / duplex
      const wantOutlet = /outlet|duplex|receptacle/i.test(ps.role || '');
      const rank = (x: Plate) => ((kindOf(x) === 'outlet') === wantOutlet ? 0 : 1);
      if (named && named.length)
        parts.push(
          `see: ${[...named]
            .sort((x, y) => rank(x) - rank(y))
            .map(plateLink)
            .join(', ')}`,
        );
      if (ps.fixture_ids?.length) parts.push(`fixtures: ${fixtureLinks(ps.fixture_ids)}`);
      if (ps.ha_group) parts.push(`<span class="pinnote">HA group ${esc(ps.ha_group)}</span>`);
      if (ps.ha_entity) parts.push(`HA: ${haCell(ps.ha_entity)}`);
      if (ps.link) parts.push(`link: ${boxLink(ps.link)}`);
      rows.push(row(`#${ps.pos}`, parts.join('<br>'), 'conn swpos'));
    }
    if (!d.positions?.length) rows.push(row('positions', '<span class="pinnote">none accounted for</span>'));
    // other plates whose links point here
    const back = sw.plates.filter(
      (o) => o !== p && p.box && (o.d.positions || []).some((ps) => ps.link?.box === p.box),
    );
    if (back.length)
      rows.push(
        row(
          'linked from',
          back.map((o) => `<a href="#" data-swbox="${esc(o.box)}">${esc(o.box)}</a>`).join(', '),
          'conn',
        ),
      );
    const named = ((p.box && sw.mentions[p.box]) || []).filter((o) => !back.includes(o));
    if (named.length) rows.push(row('named in', named.map(plateLink).join(', '), 'conn'));
    // where the plate comes from: the site's template with the plate's `file` extra
    if (d.file && config.source)
      rows.push(row('source', `<code>${esc(config.source.replace('{file}', d.file))}</code>`));
    el.innerHTML = `<span class="close" id="infoclose">✕</span><h2>${esc(title(p))}</h2><table>${rows.join('')}${extraRows.join('')}</table>`;
    el.style.display = 'block';
    $('infoclose').onclick = () => {
      el.style.display = 'none';
      select(null);
      showPanel?.(null);
    };
    select(p);
  }

  function select(p: Plate | null): void {
    sw.selected = p;
    refresh();
  }

  // go to a plate by box id or plate id: select, open its panel, fly there (standing off the wall along its normal)
  function go(id: string): boolean {
    const p = sw.byBox[id] || sw.byId[id];
    if (!p) return false;
    info(p);
    // fly() stands off towards `centre` (a room centroid 4 ft over its floor): here, 2 m out from the plate's face
    const floorY = storeyOfObject(site, p.d.z ?? 0).storey.z * site.unit;
    fly(
      p.centre.clone(),
      p.centre
        .clone()
        .addScaledVector(p.normal, 2.0)
        .setY(floorY + 4 * FT),
    );
    return true;
  }

  function markFixtures(fids: string[]): boolean {
    const pins = getPins?.();
    if (pins?.markFixtures) return pins.markFixtures(fids);
    const box = new THREE.Box3();
    for (const f of fids) if (fixtures[f]) box.expandByObject(fixtures[f]);
    const here = camera.getWorldPosition(new THREE.Vector3());
    here.y -= 1.5 * FT;
    if (!box.isEmpty()) fly(box.getCenter(new THREE.Vector3()), here);
    return !box.isEmpty();
  }

  $('info').addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>(
      'a[data-swfix], a[data-swbox], a[data-swplate], button[data-swha]',
    );
    if (!a) return;
    e.preventDefault();
    if (a.dataset.swfix) markFixtures(a.dataset.swfix.split(' '));
    else if (a.dataset.swbox) go(a.dataset.swbox);
    else if (a.dataset.swplate) go(a.dataset.swplate);
    else if (a.dataset.swha) {
      a.blur();
      const ha = getHA?.();
      (a as HTMLButtonElement).disabled = true;
      ha?.togglePlateEntity(a.dataset.swha).finally(() => {
        if (sw.selected) setTimeout(() => info(sw.selected!), 400);
      });
    }
  });

  // ------------------------------------------------------------------ HUD
  function buildUI(): void {
    $('platerow')?.classList.remove('hidden');
    $('plateson')?.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      setOn(t.checked);
      t.blur();
    });
    $('plateswall')?.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      setWall(t.checked);
      t.blur();
    });
    $('platekind')?.addEventListener('change', (e) => {
      const t = e.target as HTMLSelectElement;
      setKind(t.value);
      if (!sw.on) setOn(true);
      t.blur();
    });
    refresh();
  }

  // draw calls test hook: put the glb's own plate nodes back instead of the instanced meshes (twin.switches.useRaw)
  function useRaw(on: boolean): void {
    if (on) {
      root.remove(sw.group!);
      root.add(sw.raw!);
    } else {
      root.remove(sw.raw!);
      root.add(sw.group!);
    }
  }

  return Object.assign(sw, {
    adopt,
    plateOf,
    info,
    go,
    select,
    setOn,
    setWall,
    setKind,
    kindOf,
    refresh,
    update,
    buildUI,
    markFixtures,
    useRaw,
  });
}

export type Switches = ReturnType<typeof createSwitches>;
