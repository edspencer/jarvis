// Faults through walls for every Home Assistant device, not only the lights: a game-style wall hack. Anything in HA
// that is broken or needs attention gets a marker drawn over everything, so one look round the building shows what is
// wrong and where.
//
// - The devices and where they are: the site's device map (plugins.faults.devices). A device's place is a registry item, a switch plate, a light
//   fixture (resolved here from the model, so a lamp in an extra model lands on the lamp) or its HA area's room centroid
//   (approx: drawn hollow).
// - Health (health.ts), from the live state stream the HA layer already subscribes to (read-only; this file never calls
//   a service).
// - Drawing: one THREE.Points for every marker (one draw call), no depth test, after everything else. A small shader
//   sizes them in pixels, picks the glyph (! fault, ↑ update, ✓ ok) from a one-row atlas, pulses red ones and the
//   selected one. Hollow = placed by its area only.
// - The fault list (top left, while V is on): counts by severity (click to filter), the devices grouped by room, click
//   to fly there and open the inspect panel; devices with no place are listed at the end (panel only).
// - Off when Home Assistant isn't connected (no states: nothing to show). ?ha=mock adds made-up healthy states for
//   every device entity the light mock lacks, then a fixed set of faults to test with (dead Z-Wave nodes, low
//   batteries, stale and weak Zigbee devices, offline devices, updates, a bulb off at its wall switch); ?hamock=<seed>
//   varies them.
// URL: ?haall shows every device; ?habatt=30 sets the battery threshold; ?hastale=12 the stale hours.
import * as THREE from 'three';
import { storeyOfObject, upperFromY, type FaultsConfig, type Site } from '../../site';
import type { DomLookup, Escape, Fixtures, FlyFn, ViewState } from '../../core/types';
import { FT } from '../../core/units';
import type { HA } from '../home-assistant/ha';
import type { Entities, EntityState } from '../home-assistant/types';
import type { Pins } from '../pins/pins';
import type { Switches } from '../switches/switches';
import {
  SEV,
  health,
  healthEntities,
  hours,
  type DeviceSpec,
  type Reason,
  type Severity,
  type Thresholds,
} from './health';

const COL: Record<Severity, string> = { red: '#ff3b30', amber: '#ffb020', blue: '#4ea3ff', ok: '#57d17a' };
const NAME: Record<Severity, string> = { red: 'faulty', amber: 'needs attention', blue: 'update', ok: 'ok' };
const GLYPHS = ['!', '↑', '✓'];
const GLYPH: Record<Severity, number> = { red: 0, amber: 0, blue: 1, ok: 2 };
const HOLLOW = 1,
  PULSE = 2,
  SELECTED = 4;
const CELL = 64;

/** a device with its live health and resolved position */
export interface Device extends DeviceSpec {
  sev: Severity;
  why: Reason[];
  off?: string | null;
  known?: boolean;
  /** world position, once resolved */
  at?: THREE.Vector3;
  /** its position won't improve (the model part it hangs on is in, or it has none) */
  final?: boolean;
  /** the room centre to fly from */
  centre?: THREE.Vector3 | null;
  mocked?: boolean;
}

interface DevicesFile {
  thresholds: Thresholds;
  devices: Device[];
}

type Counts = Record<Severity | 'off', number>;
type MarkerAttr = 'position' | 'color' | 'glyph' | 'flags';

export interface FaultsDeps {
  config: FaultsConfig;
  site: Pick<Site, 'storeys' | 'unit'>;
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  fixtures: Fixtures;
  $: DomLookup;
  esc: Escape;
  state: ViewState;
  fly: FlyFn;
  getHA: () => HA | null;
  getPins: () => Pins | null;
  getSwitches: () => Switches | null;
  /** a device panel replaced the inspect panel */
  onShow?: () => void;
  onChange?: () => void;
}

export function createFaults({
  config,
  site,
  scene,
  camera,
  renderer,
  fixtures,
  $,
  esc,
  state,
  fly,
  getHA,
  getPins,
  getSwitches,
  onShow,
  onChange,
}: FaultsDeps) {
  const q = new URLSearchParams(location.search);
  const F = {
    data: null as DevicesFile | null,
    devices: [] as Device[],
    byId: {} as Record<string, Device>,
    byEntity: {} as Record<string, Device[]>,
    all: q.has('haall'),
    sevs: new Set<Severity>(['red', 'amber', 'blue']),
    selected: null as Device | null,
    drawn: [] as Device[],
    counts: { red: 0, amber: 0, blue: 0, ok: 0, off: 0 } as Counts,
    th: null as Thresholds | null,
    open: true,
    active: false,
  };
  let pts: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null,
    dirty = true,
    listT = 0,
    resolveT = 0,
    healthT = 0,
    resolveUntil = 0,
    drawnOn = false; // whether the last redraw had the wall hack on
  const ha = () => getHA?.();
  const UPPER_Y = upperFromY(site);
  /** the floor (world Y) of the storey a point at world Y belongs to */
  const floorYOf = (y: number) => storeyOfObject(site, y / site.unit).storey.z * site.unit;

  // ------------------------------------------------------------------ the atlas: one cell per glyph
  // R = filled disc, G = ring (hollow), B = the glyph, A = the dark outline
  function atlas(): THREE.DataTexture {
    const w = CELL * GLYPHS.length;
    const layer = (draw: (g: CanvasRenderingContext2D, k: string) => void) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = CELL;
      const g = c.getContext('2d')!;
      g.fillStyle = g.strokeStyle = '#fff';
      GLYPHS.forEach((k, i) => {
        g.save();
        g.translate(i * CELL + CELL / 2, CELL / 2);
        draw(g, k);
        g.restore();
      });
      return g.getImageData(0, 0, w, CELL).data;
    };
    const disc = layer((g) => {
      g.beginPath();
      g.arc(0, 0, 24, 0, 7);
      g.fill();
    });
    const ring = layer((g) => {
      g.lineWidth = 8;
      g.beginPath();
      g.arc(0, 0, 20, 0, 7);
      g.stroke();
    });
    const glyph = layer((g, k) => {
      g.font = '800 36px system-ui, -apple-system, "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(k, 0, 2);
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
      px[i * 4 + 2] = glyph[i * 4 + 3];
      px[i * 4 + 3] = edge[i * 4 + 3];
    }
    const t = new THREE.DataTexture(px, w, CELL, THREE.RGBAFormat);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  function makePoints(n: number) {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        atlas: { value: atlas() },
        n: { value: GLYPHS.length },
        ratio: { value: renderer.getPixelRatio() },
        time: { value: 0 },
      },
      vertexShader: `
        attribute vec3 color; attribute float glyph; attribute float flags;
        uniform float ratio; uniform float time;
        varying vec3 vColor; varying float vGlyph; varying float vFlags; varying float vPulse;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          mv.xyz -= normalize(mv.xyz) * min(0.25, -mv.z * 0.5);       // a little towards the eye, off the wall or ceiling
          gl_Position = projectionMatrix * mv;
          float px = clamp(120.0 / max(-mv.z, 0.1), 14.0, 30.0);
          float pulse = mod(floor(flags / 2.0), 2.0) > 0.5 ? 0.5 + 0.5 * sin(time * 5.0) : 0.0;
          bool sel = mod(floor(flags / 4.0), 2.0) > 0.5;
          px *= 1.0 + 0.3 * pulse;
          if (sel) px = 38.0 + 7.0 * sin(time * 6.0);
          gl_PointSize = px * ratio;
          vColor = color; vGlyph = glyph; vFlags = flags; vPulse = pulse;
        }`,
      fragmentShader: `
        uniform sampler2D atlas; uniform float n;
        varying vec3 vColor; varying float vGlyph; varying float vFlags; varying float vPulse;
        void main() {
          vec4 t = texture2D(atlas, vec2((vGlyph + gl_PointCoord.x) / n, gl_PointCoord.y));
          bool hollow = mod(vFlags, 2.0) > 0.5, sel = mod(floor(vFlags / 4.0), 2.0) > 0.5;
          vec3 edge = sel ? vec3(1.0) : vec3(0.04, 0.05, 0.07);
          vec3 c; float a;
          if (hollow) { c = mix(edge, vColor, max(t.g, t.b)); a = max(t.a * 0.6, max(t.g, t.b)); }
          else { c = mix(edge, mix(vColor, vec3(0.05), t.b), t.r); a = t.a; }
          c += vColor * 0.35 * vPulse * t.r;                            // red ones glow as they pulse
          if (a < 0.03) discard;
          gl_FragColor = vec4(c, a);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('glyph', new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('flags', new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setDrawRange(0, 0);
    const p = new THREE.Points(g, mat);
    p.frustumCulled = false;
    p.renderOrder = 1001;
    p.name = 'HA_device_faults';
    p.visible = false;
    scene.add(p);
    return p;
  }

  // ------------------------------------------------------------------ data
  async function load(): Promise<void> {
    const r = await fetch(config.devices);
    if (!r.ok) throw new Error(`${config.devices}: HTTP ${r.status}`);
    F.data = (await r.json()) as DevicesFile;
    F.th = { ...F.data.thresholds, stale_h: { ...F.data.thresholds.stale_h } };
    if (q.get('habatt')) F.th.battery_pct = +q.get('habatt')!;
    if (q.get('hastale')) for (const k of Object.keys(F.th.stale_h)) F.th.stale_h[k] = +q.get('hastale')!;
    F.devices = F.data.devices;
    for (const d of F.devices) {
      F.byId[d.id] = d;
      d.sev = 'ok';
      d.why = [];
    }
    index();
    pts = makePoints(F.devices.length);
    resolveUntil = performance.now() + 90e3; // an extra model's lamps and the plates arrive after this
    buildUI();
  }
  function index(): void {
    F.byEntity = {};
    for (const d of F.devices) for (const e of healthEntities(d)) (F.byEntity[e] ||= []).push(d);
  }
  // the entities the HA layer should leave to this layer (no duplicate fixture fault marker): any a device watches
  const covers = (e: string): boolean => !!F.byEntity[e];

  // ------------------------------------------------------------------ where a device is
  const box = new THREE.Box3();
  const refs = (r: string | string[] | undefined): string[] => (Array.isArray(r) ? r : r ? [r] : []);
  function resolve(d: Device): void {
    const pl = d.place;
    if (!pl) return;
    let at: THREE.Vector3 | null = null,
      final = false;
    if (pl.src === 'fixture') {
      box.makeEmpty();
      for (const f of refs(pl.ref)) if (fixtures[f]) box.expandByObject(fixtures[f]);
      if (!box.isEmpty()) {
        at = box.getCenter(new THREE.Vector3());
        at.y = Math.max(box.min.y, at.y - 0.05);
        final = true;
      }
    } else if (pl.src === 'plate') {
      const p = getSwitches?.()?.byId[pl.ref as string];
      if (p) {
        at = p.centre.clone().addScaledVector(p.normal, 0.06);
        final = true;
      }
    } else if (pl.src === 'registry') {
      const it = getPins?.()?.byId[pl.ref as string];
      if (it) {
        box.makeEmpty();
        for (const f of it.fixtures) if (fixtures[f]) box.expandByObject(fixtures[f]);
        at = box.isEmpty() ? it.at.clone() : box.getCenter(new THREE.Vector3());
        final = !it.fixtures.length || !box.isEmpty();
      }
    } else final = true;
    if (!at && pl.pos) at = new THREE.Vector3(...pl.pos);
    if (at && (!d.at || !d.at.equals(at))) {
      d.at = at;
      dirty = true;
    }
    d.final = final;
    d.centre = pl.centre ? new THREE.Vector3(...pl.centre) : null;
  }

  // ------------------------------------------------------------------ health
  const ago = (t: number | null) => (t ? `${hours(Date.now() - t)} ago` : '');

  function recompute(list: Iterable<Device>): void {
    const h = ha();
    const ents = h?.entities || {},
      now = Date.now();
    for (const d of list) {
      const r = health(d, ents, now, F.th!);
      if (
        r.sev !== d.sev ||
        JSON.stringify(r.why.map((x) => x.text)) !== JSON.stringify(d.why.map((x) => x.text)) ||
        r.off !== d.off
      ) {
        Object.assign(d, r);
        dirty = true;
      }
    }
  }
  // the state stream: only the devices watching a changed entity
  function onEntities(ents: Entities, old: Entities): void {
    const touched = new Set<Device>();
    for (const [e, ds] of Object.entries(F.byEntity)) if (ents[e] !== old[e]) for (const d of ds) touched.add(d);
    if (touched.size) recompute(touched);
  }

  // ------------------------------------------------------------------ drawing
  const rgb = (hex: string): [number, number, number] =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const isActive = (h: HA | null | undefined): boolean =>
    !!(h?.engaged && (h.status === 'live' || h.status === 'mock') && Object.keys(h.entities).length);
  function redraw(): void {
    dirty = false;
    const h = ha();
    F.active = isActive(h);
    const c: Counts = { red: 0, amber: 0, blue: 0, ok: 0, off: 0 };
    for (const d of F.devices) {
      if (d.off) c.off++;
      c[d.sev]++;
    }
    F.counts = c;
    const on = F.active && !!h?.wallhack;
    drawnOn = on;
    F.drawn = on
      ? F.devices.filter(
          (d) => d.at && (F.sevs.has(d.sev) || (F.all && d.sev === 'ok')) && !(state.upperHidden && d.at.y > UPPER_Y),
        )
      : [];
    F.drawn.sort((a, b) => SEV[a.sev] - SEV[b.sev]); // the worst drawn last, on top
    const a = pts!.geometry.attributes as Record<MarkerAttr, THREE.BufferAttribute>;
    F.drawn.forEach((d, i) => {
      const col = rgb(d.off && d.sev === 'ok' ? '#8a93a3' : COL[d.sev]);
      a.position.setXYZ(i, d.at!.x, d.at!.y, d.at!.z);
      a.color.setXYZ(i, ...col);
      a.glyph.setX(i, GLYPH[d.sev]);
      a.flags.setX(
        i,
        (d.place?.approx ? HOLLOW : 0) | (d.sev === 'red' ? PULSE : 0) | (d === F.selected ? SELECTED : 0),
      );
    });
    pts!.geometry.setDrawRange(0, F.drawn.length);
    for (const k of ['position', 'color', 'glyph', 'flags'] as const) a[k].needsUpdate = true;
    pts!.visible = on && F.drawn.length > 0;
    listT = 0;
  }

  // ------------------------------------------------------------------ picking (screen space, like pins; always through walls)
  const v = new THREE.Vector3();
  function at(ndc: THREE.Vector2): Device | null {
    if (!pts?.visible) return null;
    const w = innerWidth / 2,
      hh = innerHeight / 2,
      cam = camera.getWorldPosition(new THREE.Vector3());
    let best: Device | null = null,
      bestD = Infinity;
    for (const d of F.drawn) {
      v.copy(d.at!).project(camera);
      if (v.z < -1 || v.z > 1) continue;
      const dist = Math.hypot((v.x - ndc.x) * w, (v.y - ndc.y) * hh);
      const r = Math.min(30, Math.max(14, 120 / Math.max(d.at!.distanceTo(cam), 0.1))) / 2 + 4;
      if (dist > r) continue;
      // nearest on screen; between overlapping markers, the worse one (drawn on top)
      const score = dist - SEV[d.sev] * 3;
      if (score < bestD) {
        best = d;
        bestD = score;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ the inspect panel
  const human = (s: unknown) => String(s ?? '').replace(/_/g, ' ');
  const dot = (sev: Severity, off?: string | null | boolean) =>
    `<span class="fdot" style="background:${off && sev === 'ok' ? '#8a93a3' : COL[sev]}"></span>`;
  function placeText(d: Device): string {
    const pl = d.place;
    if (!pl) return '<span class="pinnote">not placed (no HA area, no placement hint)</span>';
    const how = (
      {
        registry: 'at its registry item',
        plate: 'at its wall plate',
        fixture: 'at the light fixture it is in',
        area: "its HA area's room centroid (approx)",
      } as Record<string, string>
    )[pl.src];
    return (
      `${esc(human(pl.room))} · ${esc(how)}${pl.approx && pl.src !== 'area' ? ' (approx)' : ''} · conf ${esc(pl.conf || '?')}` +
      (pl.why ? `<br><span class="pinnote">${esc(pl.why)}</span>` : '')
    );
  }
  function links(d: Device): string {
    const pl = d.place || ({} as NonNullable<Device['place']>),
      out: string[] = [];
    const pins = getPins?.(),
      sw = getSwitches?.();
    if (pl.src === 'registry') out.push(pins?.link ? pins.link(pl.ref as string) : `<code>${esc(pl.ref)}</code>`);
    if (pl.src === 'plate') {
      const ref = pl.ref as string;
      const p = sw?.byId[ref];
      out.push(
        p
          ? `<a href="#" data-swplate="${esc(ref)}" title="fly to the plate and open it">plate ${esc(p.box || ref.replace(/_/g, ' '))}</a>`
          : `plate <code>${esc(ref)}</code>`,
      );
    }
    const fx = pl.src === 'fixture' ? refs(pl.ref) : d.fixtures || [];
    if (fx.length) {
      const known = fx.filter((f) => fixtures[f]);
      out.push(
        `${known.length ? `<a href="#" data-swfix="${esc(known.join(' '))}" title="fly to the fixture${known.length > 1 ? 's' : ''}">` : ''}` +
          `${fx.length} fixture${fx.length > 1 ? 's' : ''}${known.length ? '</a>' : ''} <span class="pinnote">(${esc(fx.join(', '))})</span>`,
      );
    }
    const reg = fx.map((f) => pins?.byFixture?.(f)).find(Boolean);
    if (reg && pl.src !== 'registry') out.push(pins!.link(reg.id));
    // a link to the device's page in the site's Home Assistant
    const hass = ha()?.hassUrl;
    if (hass)
      out.push(
        `<a href="${esc(hass)}/config/devices/device/${esc(d.id)}" target="_blank" rel="noopener">open in Home Assistant</a>`,
      );
    return out.join('<br>');
  }
  function show(d: Device | null): void {
    const el = $('info'),
      h = ha();
    if (!d) return;
    onShow?.();
    getPins?.()?.select(null);
    getSwitches?.()?.select(null);
    const ents = h?.entities || {};
    const row = (k: string, val: string | null | undefined, cls = '') =>
      val === null || val === undefined || val === ''
        ? ''
        : `<tr class="${cls}"><td>${esc(k)}</td><td>${val}</td></tr>`;
    const rows: string[] = [];
    const status = !F.active
      ? '<span class="pinnote">not connected to Home Assistant</span>'
      : d.why.length
        ? d.why
            .map(
              (r) =>
                `${dot(r.sev)}<b>${esc(r.text)}</b>${r.since ? ` <span class="pinnote">since ${esc(new Date(r.since).toLocaleString('en-GB'))} (${esc(ago(r.since))})</span>` : ''}`,
            )
            .join('<br>')
        : d.off
          ? `${dot('ok', true)}${esc(d.off)}`
          : d.known
            ? `${dot('ok')}ok`
            : '<span class="pinnote">no state for its entities</span>';
    rows.push(row('status', status, 'ha'));
    rows.push(row('model', esc([d.make, d.model].filter(Boolean).join(' ') || 'unknown')));
    rows.push(row('integration', esc(d.integration)));
    rows.push(row('HA area', esc(d.area || 'none')));
    rows.push(row('where', placeText(d)));
    rows.push(row('links', links(d), 'conn'));
    // its health entities, failing ones first, with their live state
    const failing = new Set(d.why.flatMap((r) => r.entities || []));
    const list = [...new Set(healthEntities(d))]
      .sort((x, y) => Number(failing.has(y)) - Number(failing.has(x)))
      .slice(0, 14);
    const ent = (e: string) => {
      const s: EntityState | undefined = ents[e];
      const val = s
        ? `${s.state}${s.attributes?.unit_of_measurement ? ` ${s.attributes.unit_of_measurement}` : ''}`
        : F.active
          ? 'no state'
          : '';
      return `<code${failing.has(e) ? ' class="fbad"' : ''}>${esc(e)}</code>${val ? ` <span class="pinnote">${esc(val)}</span>` : ''}`;
    };
    rows.push(
      row(
        'entities',
        list.map(ent).join('<br>') +
          (healthEntities(d).length > list.length
            ? `<br><span class="pinnote">+ ${healthEntities(d).length - list.length} more</span>`
            : ''),
        'ha',
      ),
    );
    if (d.unavailable_means)
      rows.push(
        row(
          'unavailable',
          `<span class="pinnote">means off: ${esc(d.unavailable_means.off)}${d.unavailable_means.unless_on ? `; a fault if any of ${d.unavailable_means.unless_on.length} bulb(s) on the same switch answers` : ''}</span>`,
        ),
      );
    if (d.powered_by) rows.push(row('powered by', `<code>${esc(d.powered_by)}</code>`));
    // where the device map comes from (the site says, if it wants to)
    if (config.source) rows.push(row('source', `<code>${esc(config.source)}</code>`));
    el.innerHTML = `<span class="close" id="infoclose">✕</span><h2>${dot(d.sev, d.off)}${esc(d.name)}</h2><table>${rows.join('')}</table>`;
    el.style.display = 'block';
    $('infoclose').onclick = () => {
      el.style.display = 'none';
      select(null);
    };
    select(d);
  }
  function select(d: Device | null): void {
    F.selected = d;
    dirty = true;
  }

  // fly there, open the panel; a device with no place only opens the panel
  function go(idOrDev: string | Device): boolean {
    const d = typeof idOrDev === 'string' ? F.byId[idOrDev] : idOrDev;
    if (!d) return false;
    show(d);
    if (!d.at) return true;
    if (d.place?.src === 'plate') {
      const p = getSwitches?.()?.byId[d.place.ref as string];
      if (p) {
        // 1.1 m out from the plate: a backsplash or a passage can be narrower than the pins' 2 m
        const floorY = floorYOf(p.centre.y);
        fly(
          d.at.clone(),
          p.centre
            .clone()
            .addScaledVector(p.normal, 1.1)
            .setY(floorY + 4 * FT),
        );
        return true;
      }
    }
    fly(d.at.clone(), d.centre || d.at.clone());
    return true;
  }

  // ------------------------------------------------------------------ the fault list (top left)
  function buildUI(): void {
    const el = $('faultlist');
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const s = target.closest<HTMLElement>('[data-sev]'),
        it = target.closest<HTMLElement>('[data-dev]'),
        t = target.closest('[data-ftoggle]');
      if (t) {
        F.open = !F.open;
        listT = 0;
        return;
      }
      if (s) {
        const k = s.dataset.sev as Severity;
        if (F.sevs.has(k)) F.sevs.delete(k);
        else F.sevs.add(k);
        dirty = true;
        return;
      }
      if (it) go(it.dataset.dev!);
    });
    el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'faultall') {
        setAll(t.checked);
        t.blur();
      }
    });
  }
  function drawList(): void {
    const el = $('faultlist'),
      h = ha();
    const on = F.active && h?.wallhack;
    el.classList.toggle('hidden', !on);
    if (!on) return;
    const c = F.counts;
    const chip = (k: Severity) =>
      `<span class="fchip${F.sevs.has(k) ? '' : ' off'}" data-sev="${k}" title="${NAME[k]}: click to hide / show">${dot(k)}${c[k]} ${k}</span>`;
    const listed = F.devices.filter((d) => F.sevs.has(d.sev) || (F.all && d.sev === 'ok'));
    const rooms: Record<string, Device[]> = {};
    for (const d of listed) (rooms[d.at ? human(d.place?.room || '?') : 'not placed'] ||= []).push(d);
    const worst = (ds: Device[]) => ds.reduce((m, d) => Math.max(m, SEV[d.sev]), 0);
    const reds = (ds: Device[]) => ds.filter((d) => d.sev === 'red').length;
    const order = Object.keys(rooms).sort(
      (a, b) =>
        Number(a === 'not placed') - Number(b === 'not placed') ||
        worst(rooms[b]) - worst(rooms[a]) ||
        reds(rooms[b]) - reds(rooms[a]) ||
        a.localeCompare(b),
    );
    const item = (d: Device) =>
      `<div class="fitem" data-dev="${esc(d.id)}" title="${esc(d.why.map((r) => r.text).join('; ') || d.off || 'ok')}${d.at ? ' · click to fly there' : ''}">` +
      `${dot(d.sev, d.off)}${esc(d.name)}${d.place?.approx ? '<span class="pinnote"> ◌</span>' : ''} <span class="pinnote">${esc(d.why[0]?.text || d.off || '')}</span></div>`;
    el.innerHTML =
      `<div class="fhead"><b>Device faults</b> ${(['red', 'amber', 'blue'] as const).map(chip).join(' ')}` +
      ` <span class="ftog" data-ftoggle="1" title="fold / unfold the list">${F.open ? '▾' : '▸'}</span></div>` +
      `<div class="frow"><label title="Show healthy devices too (Shift-V)"><input type="checkbox" id="faultall" ${F.all ? 'checked' : ''}> show all ${F.devices.length}</label>` +
      ` <span class="pinnote">${c.ok} ok${c.off ? `, ${c.off} off at a switch` : ''} · ◌ = placed by room only</span></div>` +
      (F.open
        ? `<div class="fbody">${
            order
              .map((r) => {
                const ds = rooms[r].sort((a, b) => SEV[b.sev] - SEV[a.sev] || a.name.localeCompare(b.name));
                return `<div class="froom">${esc(r)} <span class="pinnote">${ds.length}</span></div>${ds.map(item).join('')}`;
              })
              .join('') || '<div class="pinnote">nothing to show</div>'
          }</div>`
        : '');
  }

  // ------------------------------------------------------------------ mock (?ha=mock): states for every device entity, and faults to test with
  function mock(): void {
    const h = ha();
    if (!h?.mock) return;
    let seed = ((+(q.get('hamock') as string) || 7) * 7919) % 2147483647;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const now = Date.now(),
      iso0 = (ms: number) => new Date(ms).toISOString();
    const ents: Entities = {};
    const put = (
      e: string,
      state: string | number,
      attributes: Record<string, unknown> = {},
      age = rnd() * 6 * 3600e3,
    ) => {
      ents[e] = {
        entity_id: e,
        state: String(state),
        attributes,
        last_changed: iso0(now - age),
        last_updated: iso0(now - Math.min(age, rnd() * 600e3)),
      };
    };
    const have = (e: string) => h.entities[e] || ents[e];
    for (const d of F.devices) {
      // a healthy building first
      const hh = d.health;
      for (const e of hh.avail)
        if (!have(e)) {
          const dom = e.split('.')[0];
          put(
            e,
            dom === 'light' || dom === 'switch' || dom === 'fan'
              ? rnd() < 0.5
                ? 'on'
                : 'off'
              : dom === 'sensor'
                ? (rnd() * 100).toFixed(1)
                : dom === 'binary_sensor'
                  ? 'off'
                  : dom === 'climate'
                    ? 'heat_cool'
                    : dom === 'camera'
                      ? 'idle'
                      : dom === 'cover'
                        ? 'closed'
                        : 'on',
          );
        }
      for (const e of hh.node_status || []) put(e, 'alive');
      for (const e of hh.last_seen || []) put(e, iso0(now - rnd() * 3600e3), { device_class: 'timestamp' });
      for (const e of hh.battery || [])
        put(e, Math.round(35 + rnd() * 65), { unit_of_measurement: '%', device_class: 'battery' });
      for (const e of hh.battery_low || []) put(e, 'off');
      for (const s of hh.signal || [])
        put(
          s.entity,
          s.kind === 'lqi'
            ? Math.round(120 + rnd() * 130)
            : s.kind === 'wifi'
              ? Math.round(60 + rnd() * 40)
              : Math.round(-70 + rnd() * 20),
        );
      for (const e of hh.update || []) put(e, 'off', { installed_version: '1.2.0', latest_version: '1.2.0' });
    }
    // then the faults: a fixed recipe over a seeded shuffle, so every kind shows up
    const pool = F.devices
      .filter((d) => d.place)
      .map((d) => [rnd(), d] as const)
      .sort((a, b) => a[0] - b[0])
      .map((x) => x[1]);
    const take = (n: number, ok: (d: Device) => unknown) => {
      const out: Device[] = [];
      for (const d of pool) {
        if (out.length >= n) break;
        if (!d.mocked && ok(d)) {
          d.mocked = true;
          out.push(d);
        }
      }
      return out;
    };
    const offline = (d: Device, age: number) => {
      for (const e of d.health.avail) put(e, 'unavailable', {}, age);
    };
    for (const d of take(2, (x) => x.health.node_status)) {
      for (const e of d.health.node_status!) put(e, 'dead', {}, 3 * 86400e3);
      offline(d, 3 * 86400e3);
    }
    for (const d of take(5, (x) => x.health.battery))
      for (const e of d.health.battery!)
        put(e, Math.round(3 + rnd() * 15), { unit_of_measurement: '%', device_class: 'battery' }, 86400e3);
    for (const d of take(3, (x) => x.integration === 'zha' && !x.health.battery)) {
      // stale: no word for two days
      d.health.seen = [...(d.health.seen || []), `sensor.mock_${d.id.slice(0, 8)}_lqi`];
      const e = d.health.seen.at(-1)!;
      put(e, 140, {}, 2 * 86400e3);
      ents[e].last_updated = iso0(now - 2 * 86400e3);
    }
    for (const d of take(2, (x) => x.integration === 'zha')) {
      // weak link
      const e = `sensor.mock_${d.id.slice(0, 8)}_lqi`;
      d.health.signal = [...(d.health.signal || []), { entity: e, kind: 'lqi' }];
      put(e, Math.round(18 + rnd() * 20));
    }
    for (const d of take(5, (x) => !x.unavailable_means && x.health.avail.length)) offline(d, rnd() * 5 * 86400e3);
    for (const d of take(3, (x) => x.health.update))
      for (const e of d.health.update!)
        put(e, 'on', { installed_version: '1.2.0', latest_version: '1.3.1' }, 2 * 86400e3);
    // a switched set of bulbs: all silent = off at the wall (no fault); one silent while a mate answers = a fault
    const sets: Record<string, Device[]> = {};
    for (const d of F.devices)
      if (d.unavailable_means?.unless_on && !d.mocked) (sets[(d.groups || []).join()] ||= []).push(d);
    const multi = Object.values(sets).filter((s) => s.length >= 2);
    if (multi[0])
      for (const d of multi[0]) {
        d.mocked = true;
        offline(d, 3600e3);
      }
    if (multi[1]) {
      multi[1][0].mocked = true;
      offline(multi[1][0], 7200e3);
      for (const d of multi[1].slice(1)) for (const e of d.health.avail) put(e, 'on', { brightness: 200 });
    }
    index();
    h.mock.load(Object.values(ents));
    recompute(F.devices);
  }

  // ------------------------------------------------------------------ per frame
  function update(dt: number): void {
    if (!pts) return;
    const h = ha();
    resolveT -= dt;
    healthT -= dt;
    listT -= dt;
    if (resolveT <= 0) {
      // positions: until every model-backed one is found (or 90 s)
      resolveT = 1;
      for (const d of F.devices) if (!d.final || d.at === undefined) resolve(d);
      if (performance.now() > resolveUntil) for (const d of F.devices) d.final = true;
    }
    if (healthT <= 0) {
      healthT = 30;
      recompute(F.devices);
    } // staleness moves with the clock
    const active = isActive(h);
    // redraw when the wall hack is switched (the prototype compared against pts.visible, which stays false while
    // nothing is drawn, so V never drew the markers once loading had settled)
    if (active !== F.active || drawnOn !== (active && !!h?.wallhack)) dirty = true;
    if (dirty) redraw();
    if (pts.visible) pts.material.uniforms.time.value += dt;
    if (listT <= 0) {
      listT = 0.5;
      drawList();
    }
  }

  function setAll(on: boolean): void {
    F.all = on;
    dirty = true;
    onChange?.();
  }
  function refresh(): void {
    dirty = true;
  }

  const api = Object.assign(F, {
    load,
    update,
    at,
    show,
    go,
    select,
    setAll,
    refresh,
    onEntities,
    covers,
    mock,
    recompute,
    health: (d: Device, ents: Entities, now: number) => health(d, ents, now, F.th!),
  });
  Object.defineProperty(api, 'points', { get: () => pts }); // (Object.assign would copy a getter's value once)
  return api as typeof api & { readonly points: typeof pts };
}

export type Faults = ReturnType<typeof createFaults>;
