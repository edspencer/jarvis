// Equipment pins: the equipment registry (plugins.pins.registry) drawn in the walkthrough as small category-coloured pins,
// one letter per category.
//
// - One THREE.Points for every pin (one draw call), with a small shader that sizes them in pixels (bigger up close)
//   and picks the category's letter from a one-row atlas. "Through walls" (Shift-P, the HUD) draws the same geometry a
//   second time, dimmer and without the depth test; the selected pin is a third, one-point draw that always shows
//   through walls and pulses. So pins cost 1 to 3 draw calls, whatever their number.
// - A pin placed only by its room (`approx: room-centroid`, or `z-guess`) is drawn hollow.
// - A registry item that is a light fixture in the model (`fixtures`) gets no pin: the fixture is already there. Going
//   to it flies to the fixture and shows the selected-pin marker on it, and the fixture's own inspect panel links back
//   to the registry item.
// - Picking is in screen space: the nearest pin within a few pixels of the click or the crosshair, and, unless
//   through walls is on, only one the camera can see (a ray against the collider).
// - Every pin carries `ha` and `health` (null for now), so faults could later colour them without changing the data.
import * as THREE from 'three';
import { upperFromY, type PinCategory, type PinsConfig, type Site } from '../../site';
import type { DomLookup, Escape, Fixtures, FlyFn, SeenFn, ViewState } from '../../core/types';
import { FT } from '../../core/units';

/** the registry's categories when the site gives none: letter, colour and name per category id */
export const DEFAULT_CATEGORIES: Record<string, PinCategory> = {
  elec: { letter: 'E', colour: '#f2c230', name: 'Electrical' },
  hvac: { letter: 'H', colour: '#4fb3e8', name: 'HVAC' },
  plumb: { letter: 'P', colour: '#4a7fe0', name: 'Plumbing' },
  pool: { letter: '≈', colour: '#2fd0c8', name: 'Pool' },
  gas: { letter: 'G', colour: '#e5533d', name: 'Gas' },
  solar: { letter: 'S', colour: '#ff9a2e', name: 'Solar' },
  site: { letter: 'T', colour: '#6cc25a', name: 'Site' },
  security: { letter: 'C', colour: '#b388f5', name: 'Security' },
  safety: { letter: '!', colour: '#ff5c8a', name: 'Safety' },
  net: { letter: 'N', colour: '#a9b6c8', name: 'Network' },
  appliance: { letter: 'A', colour: '#d39a6a', name: 'Appliances' },
  fixture: { letter: 'L', colour: '#d7e35a', name: 'Fixtures' },
  envelope: { letter: 'B', colour: '#b39b8e', name: 'Envelope' },
};
const CELL = 64;
const HOLLOW = 1,
  HIGHLIGHT = 2;

/** a registry item as the registry file gives it, plus what load() adds */
export interface PinItem {
  id: string;
  name: string;
  category: string;
  status: string;
  conf: string;
  room: string;
  /** three.js metres */
  pos: [number, number, number];
  /** plan feet */
  plan: [number, number, number];
  loc_conf?: string;
  approx: 'room-centroid' | 'z-guess' | null;
  loc_note?: string | null;
  room_centre?: [number, number, number] | null;
  make: string | null;
  model: string | null;
  serial: string | null;
  qty?: string | number | null;
  aliases: string[];
  specs: [string, string][];
  connections: { key: string; text: string; refs: string[] }[];
  documents: { text: string; url?: string | null }[];
  photos: { file: string; label?: string; url?: string | null; t?: string; shows?: string; note?: string }[];
  open_questions: string[];
  fixtures: string[];
  ha: { entities: string[] };
  health: unknown;
  file: string;
  referenced_by: { id: string; key: string }[];
  // added by load()
  at: THREE.Vector3;
  centre: THREE.Vector3 | null;
  hay: string;
}

interface PinsFile {
  pins: PinItem[];
  unplaced: { id: string; name: string; room?: string; note?: string }[];
}

type PinPoints = THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
type PinAttr = 'position' | 'color' | 'glyph' | 'flags';

export interface PinsDeps {
  config: PinsConfig;
  site: Pick<Site, 'storeys' | 'unit'>;
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  fixtures: Fixtures;
  $: DomLookup;
  esc: Escape;
  state: ViewState;
  seen?: SeenFn;
  fly: FlyFn;
  /** a pin panel replaced the inspect panel */
  onShow?: () => void;
}

export function createPins({
  config,
  site,
  scene,
  camera,
  renderer,
  fixtures,
  $,
  esc,
  state,
  seen,
  fly,
  onShow,
}: PinsDeps) {
  const q = new URLSearchParams(location.search);
  const CATS: Record<string, { l: string; c: string; name: string }> = Object.fromEntries(
    Object.entries(config.categories || DEFAULT_CATEGORIES).map(([k, v]) => [
      k,
      { l: v.letter, c: v.colour, name: v.name },
    ]),
  );
  const KEYS = Object.keys(CATS);
  const UPPER_Y = upperFromY(site);
  const pins = {
    data: null as PinsFile | null,
    items: [] as PinItem[],
    byId: {} as Record<string, PinItem>,
    unplaced: {} as Record<string, PinsFile['unplaced'][number]>,
    on: q.has('pins') || q.has('pin'),
    wall: q.has('pinswall'),
    cats: new Set(KEYS),
    query: '',
    drawn: [] as PinItem[],
    selected: null as string | null,
  };

  // ------------------------------------------------------------------ the atlas: one 64-px cell per category
  // R = filled disc, G = ring (a hollow pin), B = the letter, A = the dark outline round either
  function atlas(): THREE.DataTexture {
    const w = CELL * KEYS.length;
    const layer = (draw: (g: CanvasRenderingContext2D, k: string) => void) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = CELL;
      const g = c.getContext('2d')!;
      g.fillStyle = g.strokeStyle = '#fff';
      KEYS.forEach((k, i) => {
        g.save();
        g.translate(i * CELL + CELL / 2, CELL / 2);
        draw(g, k);
        g.restore();
      });
      return g.getImageData(0, 0, w, CELL).data;
    };
    const disc = layer((g) => {
      g.beginPath();
      g.arc(0, 0, 25, 0, 7);
      g.fill();
    });
    const ring = layer((g) => {
      g.lineWidth = 8;
      g.beginPath();
      g.arc(0, 0, 21, 0, 7);
      g.stroke();
    });
    const letter = layer((g, k) => {
      g.font = '700 34px system-ui, -apple-system, "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(CATS[k].l, 0, 2);
    });
    const edge = layer((g) => {
      g.beginPath();
      g.arc(0, 0, 30, 0, 7);
      g.fill();
    });
    const px = new Uint8Array(w * CELL * 4);
    for (let i = 0; i < w * CELL; i++) {
      px[i * 4] = disc[i * 4 + 3];
      px[i * 4 + 1] = ring[i * 4 + 3];
      px[i * 4 + 2] = letter[i * 4 + 3];
      px[i * 4 + 3] = edge[i * 4 + 3];
    }
    const t = new THREE.DataTexture(px, w, CELL, THREE.RGBAFormat);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  const material = (over: boolean, opacity: number) =>
    new THREE.ShaderMaterial({
      uniforms: {
        atlas: { value: tex },
        n: { value: KEYS.length },
        ratio: { value: renderer.getPixelRatio() },
        opacity: { value: opacity },
        time: { value: 0 },
      },
      vertexShader: `
      attribute vec3 color; attribute float glyph; attribute float flags;
      uniform float ratio; uniform float time;
      varying vec3 vColor; varying float vGlyph; varying float vFlags;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        mv.xyz -= normalize(mv.xyz) * min(0.25, -mv.z * 0.5);   // 25 cm towards the eye: a pin on a wall isn't half buried in it
        gl_Position = projectionMatrix * mv;
        float px = clamp(105.0 / max(-mv.z, 0.1), 15.0, 27.0);      // bigger up close, never lost far away
        if (mod(floor(flags / 2.0), 2.0) > 0.5) px = 34.0 + 6.0 * sin(time * 6.0);   // the selected pin pulses
        gl_PointSize = px * ratio;
        vColor = color; vGlyph = glyph; vFlags = flags;
      }`,
      fragmentShader: `
      uniform sampler2D atlas; uniform float n; uniform float opacity;
      varying vec3 vColor; varying float vGlyph; varying float vFlags;
      void main() {
        vec4 t = texture2D(atlas, vec2((vGlyph + gl_PointCoord.x) / n, gl_PointCoord.y));
        bool hollow = mod(vFlags, 2.0) > 0.5, hl = mod(floor(vFlags / 2.0), 2.0) > 0.5;
        vec3 edge = hl ? vec3(1.0) : vec3(0.05, 0.06, 0.08);
        vec3 c; float a;
        if (hollow) {      // a ring in the category's colour, a dark see-through middle, the letter in colour
          c = mix(edge, vColor, max(t.g, t.b));
          a = max(t.a * (hl ? 1.0 : 0.55), max(t.g, t.b));
        } else {           // a filled disc, a dark letter
          c = mix(edge, mix(vColor, vec3(0.06), t.b), t.r);
          a = t.a;
        }
        a *= opacity;
        if (a < 0.03) discard;
        gl_FragColor = vec4(c, a);
      }`,
      transparent: true,
      depthWrite: false,
      depthTest: !over,
    });

  function points(n: number, mat: THREE.ShaderMaterial, order: number, name: string): PinPoints {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('glyph', new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('flags', new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setDrawRange(0, 0);
    const p = new THREE.Points(g, mat);
    p.frustumCulled = false;
    p.renderOrder = order;
    p.name = name;
    p.visible = false;
    scene.add(p);
    return p;
  }
  const tex = atlas();
  let main: PinPoints | null = null,
    xray: PinPoints | null = null,
    sel: PinPoints | null = null;

  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  function write(pts: PinPoints, list: { pos: THREE.Vector3; cat: string; flags: number }[]): void {
    const g = pts.geometry,
      a = g.attributes as Record<PinAttr, THREE.BufferAttribute>;
    const n = Math.min(list.length, a.position.count);
    for (let i = 0; i < n; i++) {
      const it = list[i],
        c = rgb(CATS[it.cat]?.c || '#ffffff');
      a.position.setXYZ(i, it.pos.x, it.pos.y, it.pos.z);
      a.color.setXYZ(i, c[0], c[1], c[2]);
      a.glyph.setX(i, Math.max(0, KEYS.indexOf(it.cat)));
      a.flags.setX(i, it.flags);
    }
    g.setDrawRange(0, n);
    for (const k of ['position', 'color', 'glyph', 'flags'] as const) a[k].needsUpdate = true;
  }

  // ------------------------------------------------------------------ data
  async function load(): Promise<void> {
    const r = await fetch(config.registry);
    if (!r.ok) throw new Error(`${config.registry}: HTTP ${r.status}`);
    const d = (await r.json()) as PinsFile;
    pins.data = d;
    for (const it of d.pins) {
      it.at = new THREE.Vector3(...it.pos);
      it.centre = it.room_centre ? new THREE.Vector3(...it.room_centre) : null;
      it.hay = [it.id, it.name, it.make, it.model, it.room, ...it.aliases].filter(Boolean).join(' ').toLowerCase();
      pins.byId[it.id] = it;
    }
    for (const u of d.unplaced) pins.unplaced[u.id] = u;
    pins.items = d.pins;
    main = points(d.pins.length, material(false, 1), 5, 'Pins');
    xray = points(d.pins.length, material(true, 0.45), 998, 'Pins_through_walls');
    sel = points(1, material(true, 1), 999, 'Pins_selected');
    buildUI();
    refresh();
    if (q.get('pin')) go(q.get('pin')!);
  }

  // where an item shows: its fixture's centre in the model (fixture-linked items), else its pin
  function whereIs(it: PinItem): THREE.Vector3 {
    if (it.fixtures.length) {
      const box = new THREE.Box3();
      for (const f of it.fixtures) if (fixtures[f]) box.expandByObject(fixtures[f]);
      if (!box.isEmpty()) return box.getCenter(new THREE.Vector3());
    }
    return it.at;
  }
  const matches = (it: PinItem) => pins.query.split(/\s+/).every((w) => it.hay.includes(w)); // every word, anywhere
  // which pins are drawn: on, in a chosen category, matching the search, not a model fixture, not upstairs with U
  function refresh(): void {
    if (!main || !xray || !sel) return;
    pins.drawn = pins.on
      ? pins.items.filter(
          (it) =>
            !it.fixtures.length &&
            pins.cats.has(it.category) &&
            matches(it) &&
            !(state.upperHidden && it.at.y > UPPER_Y),
        )
      : [];
    const list = pins.drawn.map((it) => ({ pos: it.at, cat: it.category, flags: it.approx ? HOLLOW : 0 }));
    write(main, list);
    write(xray, list);
    main.visible = pins.on;
    xray.visible = pins.on && pins.wall;
    const s = pins.selected && pins.byId[pins.selected];
    if (s) write(sel, [{ pos: whereIs(s), cat: s.category, flags: HIGHLIGHT | (s.approx ? HOLLOW : 0) }]);
    sel.visible = !!s;
    $<HTMLInputElement>('pinson').checked = pins.on;
    $<HTMLInputElement>('pinswall').checked = pins.wall;
    $('pincats').classList.toggle('hidden', !pins.on);
    $('pincount').textContent = pins.on ? `${pins.drawn.length} shown` : '';
    for (const b of $('pincats').querySelectorAll<HTMLButtonElement>('button'))
      b.classList.toggle('off', !pins.cats.has(b.dataset.cat!));
  }

  // ------------------------------------------------------------------ picking
  const v = new THREE.Vector3();
  // the drawn pin nearest the screen point ndc, within its radius plus a little; null if none
  function at(ndc: THREE.Vector2): PinItem | null {
    if (!pins.on || !pins.drawn.length) return null;
    const w = innerWidth / 2,
      h = innerHeight / 2,
      cam = camera.getWorldPosition(new THREE.Vector3());
    let best: PinItem | null = null,
      bestD = Infinity;
    for (const it of pins.drawn) {
      v.copy(it.at).project(camera);
      if (v.z < -1 || v.z > 1) continue;
      const d = Math.hypot((v.x - ndc.x) * w, (v.y - ndc.y) * h);
      const r = THREE.MathUtils.clamp(105 / Math.max(it.at.distanceTo(cam), 0.1), 15, 27) / 2 + 4;
      if (d > r || d >= bestD) continue;
      if (!pins.wall && seen && !seen(it.at)) continue;
      best = it;
      bestD = d;
    }
    return best;
  }

  // ------------------------------------------------------------------ the inspect panel
  const link = (id: string): string => {
    const it = pins.byId[id];
    if (it) return `<a href="#" data-pin="${esc(id)}" title="${esc(id)}">${esc(it.name)}</a>`;
    const u = pins.unplaced[id];
    return u
      ? `<span title="${esc(id)}: no position in the registry yet">${esc(u.name)} <i>(not placed)</i></span>`
      : esc(id);
  };
  // a connection's text with each registry id in it as a link to that item
  const linkify = (c: PinItem['connections'][number]): string => {
    let s = esc(c.text);
    for (const r of c.refs) s = s.replace(esc(r), link(r));
    return s;
  };
  const a = (url: string | null | undefined, text: string) =>
    url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text);

  function show(id: string): void {
    const it = pins.byId[id],
      el = $('info');
    if (!it) return;
    onShow?.();
    const row = (k: string, v: string | null | undefined, cls = '') =>
      v === null || v === undefined || v === '' ? '' : `<tr class="${cls}"><td>${esc(k)}</td><td>${v}</td></tr>`;
    const rows: string[] = [];
    rows.push(row('id', `<code>${esc(it.id)}</code>`));
    rows.push(row('category', esc(CATS[it.category]?.name || it.category)));
    rows.push(row('status', `${esc(it.status)} · conf ${esc(it.conf)}`));
    const p = it.plan;
    const place =
      it.approx === 'room-centroid'
        ? 'room centroid (registry gives the room only)'
        : it.approx === 'z-guess'
          ? 'height guessed (registry gives x, y only)'
          : `conf ${it.loc_conf}`;
    rows.push(
      row(
        'where',
        `<span title="${esc(it.loc_note || '')}">${esc(String(it.room).replace(/_/g, ' '))} · plan ${p[0]}, ${p[1]}, Z ${p[2]} ft · ${esc(place)}</span>`,
      ),
    );
    if (it.loc_note) rows.push(row('', `<span class="pinnote">${esc(it.loc_note)}</span>`));
    for (const k of ['make', 'model', 'serial'] as const)
      rows.push(row(k, it[k] === null ? '<span class="pinnote">unknown</span>' : esc(it[k])));
    if (it.qty) rows.push(row('qty', esc(it.qty)));
    if (it.aliases.length) rows.push(row('aliases', esc(it.aliases.join(', '))));
    for (const [k, val] of it.specs.slice(0, 10)) rows.push(row(k, esc(val), 'spec'));
    if (it.specs.length > 10)
      rows.push(row('', `<span class="pinnote">+ ${it.specs.length - 10} more specs in the registry file</span>`));
    for (const c of it.connections) rows.push(row(c.key.replace(/_/g, ' '), linkify(c), 'conn'));
    const back = it.referenced_by.filter((r) => !it.connections.some((c) => c.refs.includes(r.id)));
    if (back.length)
      rows.push(
        row(
          'linked from',
          back.map((r) => `${link(r.id)} <span class="pinnote">(${esc(r.key.replace(/_/g, ' '))})</span>`).join('<br>'),
          'conn',
        ),
      );
    if (it.fixtures.length) {
      rows.push(
        row(
          'in the model',
          `<a href="#" data-pinfix="${esc(it.id)}">${it.fixtures.length} light fixture${it.fixtures.length > 1 ? 's' : ''}</a> <span class="pinnote">(${esc(it.fixtures.join(', '))})</span>`,
        ),
      );
    }
    if (it.ha.entities.length) rows.push(row('HA', esc(it.ha.entities.join(', ')), 'ha'));
    if (it.documents.length) rows.push(row('documents', it.documents.map((d) => a(d.url, d.text)).join('<br>')));
    if (it.photos.length) {
      rows.push(
        row(
          'photos',
          it.photos
            .map(
              (ph) =>
                `${a(ph.url, ph.label || ph.file)}${ph.label && ph.label !== ph.file.replace(/\.[^.]+$/, '') ? ` <span class="pinnote">${esc(ph.file)}</span>` : ''}` +
                `${ph.t ? ` <span class="pinnote">t ${esc(ph.t)}</span>` : ''}${ph.shows ? ` <span class="pinnote">· ${esc(ph.shows)}</span>` : ''}`,
            )
            .join('<br>'),
        ),
      );
    }
    if (it.open_questions.length)
      rows.push(
        row(
          'open',
          `<ul>${it.open_questions
            .slice(0, 4)
            .map((x) => `<li>${esc(x)}</li>`)
            .join('')}</ul>` +
            (it.open_questions.length > 4 ? `<span class="pinnote">+ ${it.open_questions.length - 4} more</span>` : ''),
        ),
      );
    // the item's source file: linked if the site gives a link template, shown without the site's path prefix
    const shown =
      config.stripPrefix && it.file.startsWith(config.stripPrefix) ? it.file.slice(config.stripPrefix.length) : it.file;
    rows.push(row('registry', a(config.sourceLink ? config.sourceLink.replace('{file}', it.file) : null, shown)));
    el.innerHTML = `<span class="close" id="infoclose">✕</span><h2><span class="pindot" style="background:${CATS[it.category]?.c}">${esc(CATS[it.category]?.l || '?')}</span>${esc(it.name)}</h2><table>${rows.join('')}</table>`;
    el.style.display = 'block';
    $('infoclose').onclick = () => {
      el.style.display = 'none';
      select(null);
    };
    select(id);
  }

  function select(id: string | null): void {
    pins.selected = id;
    refresh();
  }

  // go to an item: select it, open its panel and fly there (the camera keeps its mode)
  function go(id: string): boolean {
    const it = pins.byId[id];
    if (!it) return false;
    if (!it.fixtures.length && !pins.cats.has(it.category)) {
      pins.cats.add(it.category);
    }
    if (!it.fixtures.length && !pins.on) pins.on = true;
    show(id);
    fly(whereIs(it), it.centre);
    return true;
  }

  // the inspect panel's links (also those added to a fixture's panel by the core)
  $('info').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('a[data-pin], a[data-pinfix]');
    if (!t) return;
    e.preventDefault();
    if (t.dataset.pin) go(t.dataset.pin);
    else {
      const it = pins.byId[t.dataset.pinfix!];
      select(it.id);
      fly(whereIs(it), it.centre);
    }
  });

  // ------------------------------------------------------------------ HUD: on / off, through walls, categories, search
  function buildUI(): void {
    $('pinrow').classList.remove('hidden');
    $('pinsearchrow').classList.remove('hidden');
    const counts: Record<string, number> = {};
    for (const it of pins.items) if (!it.fixtures.length) counts[it.category] = (counts[it.category] || 0) + 1;
    $('pincats').innerHTML = KEYS.filter((k) => counts[k])
      .map(
        (k) =>
          `<button type="button" data-cat="${k}" title="${CATS[k].name}: ${counts[k]} (click to hide / show; double-click for only this)">` +
          `<span class="pindot" style="background:${CATS[k].c}">${CATS[k].l}</span>${counts[k]}</button>`,
      )
      .join('');
    let clickT: ReturnType<typeof setTimeout> | undefined;
    $('pincats').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      b.blur();
      clearTimeout(clickT);
      clickT = setTimeout(() => {
        const k = b.dataset.cat!;
        if (pins.cats.has(k)) pins.cats.delete(k);
        else pins.cats.add(k);
        refresh();
      }, 220);
    });
    $('pincats').addEventListener('dblclick', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      clearTimeout(clickT);
      const only = pins.cats.size === 1 && pins.cats.has(b.dataset.cat!);
      pins.cats = new Set(only ? KEYS : [b.dataset.cat!]);
      refresh();
    });
    $('pinson').addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      setOn(t.checked);
      t.blur();
    });
    $('pinswall').addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      setWall(t.checked);
      t.blur();
    });
    const box = $<HTMLInputElement>('pinsearch'),
      hits = $('pinhits');
    let found: PinItem[] = [];
    const list = () => {
      pins.query = box.value.trim().toLowerCase();
      found = pins.query ? pins.items.filter(matches).slice(0, 8) : [];
      hits.innerHTML =
        found
          .map(
            (it, i) =>
              `<div data-i="${i}"><span class="pindot" style="background:${CATS[it.category]?.c}">${esc(CATS[it.category]?.l)}</span>` +
              `${esc(it.name)} <span class="pinnote">${esc([it.make, it.model].filter(Boolean).join(' ') || String(it.room).replace(/_/g, ' '))}${it.fixtures.length ? ' · light' : ''}</span></div>`,
          )
          .join('') + (pins.query && !found.length ? '<div class="pinnote">no equipment matches</div>' : '');
      hits.classList.toggle('hidden', !pins.query);
      if (pins.query && !pins.on) pins.on = true;
      refresh();
    };
    box.addEventListener('input', list);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && found[0]) {
        go(found[0].id);
        box.blur();
      }
      if (e.key === 'Escape') {
        box.value = '';
        list();
        box.blur();
      }
    });
    hits.addEventListener('click', (e) => {
      const d = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (d) go(found[+d.dataset.i!].id);
    });
  }

  function setOn(on: boolean): void {
    pins.on = on;
    if (!on) pins.selected = null;
    refresh();
  }
  function setWall(on: boolean): void {
    pins.wall = on;
    if (on) pins.on = true;
    refresh();
  }
  function update(dt: number): void {
    if (sel?.visible) sel.material.uniforms.time.value += dt;
  }
  // a light fixture's registry item, for the fixture's own inspect panel
  const byFixture = (fid: string): PinItem | null => pins.items.find((it) => it.fixtures.includes(fid)) || null;

  // mark model fixtures with the selected-pin marker and fly there, as a registry item's "light fixtures" link does;
  // for links from elsewhere (a switch plate's positions). Returns false if none is in the model.
  function markFixtures(fids: string[]): boolean {
    const box = new THREE.Box3();
    for (const f of fids) if (fixtures[f]) box.expandByObject(fixtures[f]);
    if (box.isEmpty()) return false;
    const c = box.getCenter(new THREE.Vector3());
    pins.selected = null;
    refresh();
    write(sel!, [{ pos: c, cat: 'fixture', flags: HIGHLIGHT }]);
    sel!.visible = true;
    const reg = fids.map(byFixture).find(Boolean);
    // stand off towards the registry item's room centre, else towards where the camera is now (4 ft over its floor)
    const here = camera.getWorldPosition(new THREE.Vector3());
    here.y -= 1.5 * FT;
    fly(c, reg?.centre || here);
    return true;
  }

  return Object.assign(pins, {
    load,
    refresh,
    at,
    show,
    go,
    select,
    setOn,
    setWall,
    update,
    byFixture,
    link,
    markFixtures,
    CATS,
  });
}

export type Pins = ReturnType<typeof createPins>;
