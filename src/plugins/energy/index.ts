// Energy: where the power goes. A feature plugin: it reads power (W) and energy (kWh) entities from the store, whichever
// connector supplies them, through the site's energy map (plugins.energy.map: meters from the feed down to a plug,
// what each one feeds in the model; map.ts, docs/plugins/energy.md). It contributes the Energy panel (the house's
// load, sources and storage, the panels, the top consumers), energy mode (J: the house ghosted, metered rooms and
// objects tinted by load on a log scale, a legend), an Energy section on every metered subject (live W, a 24-hour
// sparkline from the store's history, the breaker, today's kWh), a status item with the house's load, hover labels
// and search. Updates are coalesced: at most one recompute a second, and the HUD diffs what it re-renders.
// With ?ha=mock it makes up plausible loads (mock.ts); ?energymock=off leaves the entities to whoever sets them
// (twin.ha.mock.load). ?energy starts in energy mode.
import * as THREE from 'three';
import { formatIssues, type EnergyConfig } from '../../site';
import {
  definePlugin,
  type Blocks,
  type EntityState,
  type HistoryPoint,
  type InlineSpan,
  type LinkItem,
  type ListRow,
  type Subject,
  type SubjectRef,
} from '../../plugin-api';
import { checkEnergyMap, type EnergyMap } from './map';
import {
  buildTree,
  compute,
  countable,
  kwh,
  parents,
  powerOf,
  share,
  sumAll,
  top,
  totals,
  watts,
  where,
  type Meter,
  type Reading,
} from './tree';
import { fmtKWh, fmtW, legendSteps, loadColour, pct, position } from './scale';
import { downsample, integrate, midnight, sparkline, sumSeries, type Series } from './history';
import { mockHistory, mockStates } from './mock';
import { createEnergyScene, type Anchor, type Tint } from './scene';

const DAY = 24 * 3600e3;
const BUCKETS = 96; // 15 minutes each
const HISTORY_TTL = 5 * 60e3;
const TICK = 1000; // the most often anything is recomputed
const MOCK_TICK = 5000;

interface PinsLike {
  byId?: Record<string, { at?: THREE.Vector3 }>;
}
interface PlatesLike {
  byBox?: Record<string, { centre?: THREE.Vector3 }>;
  byId?: Record<string, { centre?: THREE.Vector3 }>;
}

/** a meter's past: the 24-hour series (W) and today's kWh worked out from it */
interface Past {
  at: number;
  series: Series;
  today: number | null;
}

export default definePlugin<EnergyConfig>({
  id: 'energy',
  name: 'Energy',
  after: ['home-assistant', 'pins', 'switches', 'lights'],
  async setup(ctx) {
    const raw = await ctx.load<unknown>(ctx.config.map);
    const check = checkEnergyMap(raw);
    if (!check.ok) throw new Error(`energy map: ${formatIssues(check.errors).slice(0, 3).join('; ')}`);
    for (const w of formatIssues(check.warnings)) ctx.log.warn(`energy map: ${w}`);
    const map = raw as EnergyMap;
    const tree = buildTree(map);
    const scale = map.scale || {};
    const store = ctx.store;
    const { model, camera, scene } = ctx.three;
    const get = (id: string) => store.get(id);

    let rs: Map<string, Reading> = compute(tree, get);
    let tot = totals(tree, rs);
    const hasToday = tree.all.some((m) => m.today.length);
    let view: 'now' | 'today' = 'now';

    // ------------------------------------------------------------------ bindings: the HA section shows the sensors
    for (const m of tree.all) {
      if (m.isOther) continue;
      const entities = [...m.power, ...m.today, ...m.month, ...(m.spec.remainder ? [m.spec.remainder] : [])];
      const b = { entities, conf: m.spec.conf, src: m.spec.src, meta: { meter: m.id } };
      ctx.store.bind({ ref: `energy:${m.id}`, ...b });
      for (const r of m.refs) if (!r.startsWith('node:')) ctx.store.bind({ ref: r, ...b });
    }

    // ------------------------------------------------------------------ subjects: meters, and what they feed
    const nodeCache = new Map<string, THREE.Object3D | null>();
    /** a node by name, in the main model or an extra one (the furniture); cached until a model comes in */
    const nodeNamed = (name: string): THREE.Object3D | null => {
      if (!nodeCache.has(name)) {
        let found = model.root.getObjectByName(name) ?? null;
        for (const list of Object.values(model.groups)) for (const n of list) found ??= n.getObjectByName(name) ?? null;
        nodeCache.set(name, found);
      }
      return nodeCache.get(name)!;
    };
    const centreOf = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());

    /** a meter as a subject: the first thing it feeds that someone knows, else its own item */
    const subjectOf = (m: Meter): SubjectRef => {
      const own = m.isOther ? m.parent! : m;
      for (const r of own.refs) {
        if (r.startsWith('node:')) {
          const n = nodeNamed(r.slice(5));
          if (n) return { kind: 'object', node: n };
        } else if (ctx.inspector.resolve(r)) return r;
      }
      return `energy:${m.id}`;
    };
    /** the meters a subject shows: its own meter, or those bound to it */
    const metersOf = (s: Subject | null): Meter[] => {
      if (!s) return [];
      if (s.kind === 'item') {
        if (s.id.startsWith('energy:')) {
          const m = tree.byId[s.id.slice(7)];
          return m ? [m] : [];
        }
        return tree.byRef.get(s.id) || [];
      }
      const out = new Set<Meter>();
      const ref = ctx.inspector.refOf(s);
      for (const m of (ref && tree.byRef.get(ref)) || []) out.add(m);
      const room = s.node.userData?.room;
      if (typeof room === 'string' && model.rooms.includes(s.node))
        for (const m of tree.byRef.get(`room:${room}`) || []) out.add(m);
      if (s.part?.name) for (const m of tree.byRef.get(`node:${s.part.name}`) || []) out.add(m);
      for (let n: THREE.Object3D | null = s.node; n && n !== model.root; n = n.parent)
        for (const m of tree.byRef.get(`node:${n.name}`) || []) out.add(m);
      return [...out];
    };
    const flyTo = (m: Meter) => {
      const s = subjectOf(m);
      if (typeof s !== 'string' && s.kind === 'object') return ctx.view.fly(centreOf(s.node), null);
      if (typeof s === 'string' && !s.startsWith('energy:')) return ctx.view.flyTo(s);
      const a = anchorsOf(m)[0];
      if (a) ctx.view.fly(a.at, null);
      else if (m.parent) flyTo(m.parent);
    };
    ctx.inspector.registerSubject('energy', {
      describe: (id) => {
        const m = tree.byId[id];
        if (!m) return null;
        return {
          title: m.isOther ? `Other on ${m.parent!.label}` : m.label,
          type: ['Meter', where(m)].filter(Boolean).join(' · '),
          icon: 'bolt',
          crumbs: ['Energy', ...(m.parent ? [m.parent.label] : [])],
        };
      },
      fly: (id) => tree.byId[id] && flyTo(tree.byId[id]),
    });

    // ------------------------------------------------------------------ history: sparklines and today's kWh
    const past = new Map<string, Past>();
    const pending = new Set<string>();
    const factor = (e: string) => watts({ ...(get(e) || dummy(e)), state: '1' }) ?? 1;
    const dummy = (e: string): EntityState => ({ entity_id: e, state: '1', attributes: {} });
    const mocking = () => store.mock() && ctx.url.get('energymock') !== 'off';
    const historyOf = async (e: string, from: number, to: number): Promise<HistoryPoint[]> => {
      if (mocking()) return mockHistory(tree, e, from, to, seed());
      const f = factor(e);
      return (await store.history(e, from, to)).map((p) => ({ ...p, v: p.v === null ? null : p.v * f }));
    };
    /** the 24-hour series of a meter: its power entities summed, or its children's */
    const seriesOf = async (m: Meter, from: number, to: number): Promise<{ s: Series; pts: HistoryPoint[][] }> => {
      if (m.power.length) {
        const pts = await Promise.all(m.power.map((e) => historyOf(e, from, to)));
        return { s: sumSeries(pts.map((p) => downsample(p, from, to, BUCKETS))), pts };
      }
      const kids = m.children.filter((c) => c.kind === m.kind);
      if (!kids.length) return { s: [], pts: [] };
      const all = await Promise.all(kids.map((c) => seriesOf(c, from, to)));
      return { s: sumSeries(all.map((a) => a.s)), pts: [] };
    };
    function wantPast(m: Meter): Past | null {
      const p = past.get(m.id);
      if ((!p || Date.now() - p.at > HISTORY_TTL) && !pending.has(m.id) && !m.isOther) {
        pending.add(m.id);
        const to = Date.now(),
          from = to - DAY;
        seriesOf(m, from, to)
          .then(({ s, pts }) => {
            const t0 = Math.max(from, midnight(to));
            const today = pts.length ? sumAll(pts.map((p) => integrate(p, t0, to))) : null;
            past.set(m.id, { at: Date.now(), series: s, today });
          })
          .catch((e: Error) => {
            ctx.log.warn(`energy: no history for ${m.id}: ${e.message}`);
            past.set(m.id, { at: Date.now(), series: [], today: null });
          })
          .finally(() => {
            pending.delete(m.id);
            ctx.inspector.refresh((s) => metersOf(s).includes(m));
            panel.refresh();
          });
      }
      return p ?? null;
    }
    const todayOf = (m: Meter): { v: number | null; derived: boolean } => {
      if (m.today.length) return { v: sumAll(m.today.map((e) => kwh(get(e)))), derived: false };
      return { v: past.get(m.id)?.today ?? null, derived: true };
    };

    // ------------------------------------------------------------------ the scene: energy mode
    const es = createEnergyScene({ scene, model, camera });
    const anchorCache = new Map<string, THREE.Vector3 | null>();
    function anchorAt(ref: string): THREE.Vector3 | null {
      if (anchorCache.get(ref)) return anchorCache.get(ref)!;
      const [kind, ...rest] = ref.split(':');
      const id = rest.join(':');
      let at: THREE.Vector3 | null = null;
      if (kind === 'pins') at = ctx.services.get<PinsLike>('pins')?.byId?.[id]?.at ?? null;
      else if (kind === 'plates') {
        const sw = ctx.services.get<PlatesLike>('switches');
        at = sw?.byBox?.[id]?.centre ?? sw?.byId?.[id]?.centre ?? null;
      } else if (kind === 'fixture') at = model.fixtures[id] ? centreOf(model.fixtures[id]) : null;
      else if (kind === 'node') {
        const n = nodeNamed(id);
        at = n ? centreOf(n) : null;
      }
      anchorCache.set(ref, at);
      return at;
    }
    function anchorsOf(m: Meter): Anchor[] {
      return m.refs
        .filter((r) => !r.startsWith('room:'))
        .map((ref) => ({ ref, at: anchorAt(ref)!, colour: '', size: 0 }))
        .filter((a) => a.at);
    }
    const sizeOf = (w: number | null) => {
      const t = position(w, scale);
      return t === null || t < 0 ? 0.15 : 0.3 + 0.7 * t;
    };
    function tint(): Tint {
      const t: Tint = { nodes: new Map(), rooms: new Map(), anchors: [] };
      for (const n of model.rooms) {
        const id = n.userData?.room;
        if (typeof id === 'string' && tree.byRef.has(`room:${id}`))
          t.rooms.set(n, loadColour(powerOf(tree, rs, `room:${id}`), scale));
      }
      for (const ref of tree.byRef.keys()) {
        if (ref.startsWith('room:')) continue;
        const w = powerOf(tree, rs, ref);
        const colour = loadColour(w, scale);
        if (ref.startsWith('fixture:') && model.fixtures[ref.slice(8)])
          t.nodes.set(model.fixtures[ref.slice(8)], colour);
        if (ref.startsWith('node:')) {
          const n = nodeNamed(ref.slice(5));
          if (n) t.nodes.set(n, colour);
        }
        const at = anchorAt(ref);
        if (at) t.anchors.push({ ref, at, colour, size: sizeOf(w) });
      }
      return t;
    }
    const setOn = (v: boolean) => {
      if (v === es.on) return;
      if (v) es.show(tint());
      else es.hide();
      ctx.hud.invalidate();
      panel.refresh();
    };
    ctx.events.on('frame', () => es.frame());
    ctx.events.on('model', () => {
      nodeCache.clear();
      anchorCache.clear();
      if (es.on) es.show(tint());
    });
    ctx.pick.addScreenPicker({
      id: 'energy',
      order: 20,
      at: (ndc) => {
        const a = es.at(ndc);
        if (!a) return null;
        if (a.ref.startsWith('node:')) {
          const n = nodeNamed(a.ref.slice(5));
          return n ? { kind: 'object', node: n } : null;
        }
        const s = ctx.inspector.resolve(a.ref);
        if (s) return s;
        const m = tree.byRef.get(a.ref)?.[0];
        return m ? { kind: 'item', id: `energy:${m.id}` } : null;
      },
    });
    ctx.status.addToggle({
      id: 'energy',
      label: 'Energy',
      icon: 'bolt',
      order: 46,
      title: 'Energy mode: the house ghosted, metered rooms and objects tinted by load',
      key: {
        code: 'KeyJ',
        label: 'Energy mode: the house ghosted, metered rooms and objects tinted by their load (log scale)',
      },
      get: () => es.on,
      set: (v) => setOn(v),
    });
    ctx.hud.addLegend({
      id: 'energy',
      title: 'Load',
      hint: 'J · log scale',
      when: () => es.on,
      items: () => legendSteps(scale),
    });

    // ------------------------------------------------------------------ the Energy panel
    const unitOf = (w: number | null) => (w !== null && Math.abs(w) >= 1000 ? 'kW' : 'W');
    const meterValue = (w: number | null) =>
      w === null ? '—' : Math.abs(w) >= 1000 ? (w / 1000).toFixed(Math.abs(w) < 10000 ? 2 : 1) : Math.round(w);
    const houseSpark = () => {
      const roots = tree.roots.filter((m) => m.kind === 'load');
      const ps = roots.map((m) => wantPast(m));
      return ps.every((p) => p?.series.length) ? sparkline(sumSeries(ps.map((p) => p!.series))) : undefined;
    };
    const rowOf = (m: Meter, of: number | null): ListRow => {
      const w = rs.get(m.id)?.w ?? null;
      const t = view === 'today' ? todayOf(m).v : null;
      return {
        id: m.id,
        text: m.isOther ? `Other · ${m.parent!.label}` : m.label,
        secondary: m.isOther ? (rs.get(m.id)?.reported ? 'unmetered (reported)' : 'unmetered') : where(m),
        value: view === 'today' ? fmtKWh(t) : fmtW(w),
        dot: w === null ? 'off' : undefined,
        bar: view === 'now' && w !== null && of ? Math.min(1, w / of) : undefined,
        title: m.spec.question ? `Open question: ${m.spec.question}` : undefined,
        subject: subjectOf(m),
      };
    };
    const panel = ctx.hud.addPanel({
      id: 'energy',
      title: 'Energy',
      icon: 'bolt',
      order: 55,
      key: { code: 'KeyJ', shift: true, label: 'Energy panel' },
      meta: () => (tot.load === null ? null : `${fmtW(tot.load)}${tot.partial ? ' +' : ''}`),
      render: (body) =>
        body.blocks((): Blocks => {
          const anyData = tree.entityIds.some((e) => get(e));
          if (!anyData && !store.live())
            return [
              { type: 'empty', text: 'No live data: connect a data source (the status strip) to see the loads.' },
            ];
          const load = tot.load;
          const consumers =
            view === 'today'
              ? top(tree, rs)
                  .sort((a, b) => (todayOf(b).v ?? -1) - (todayOf(a).v ?? -1))
                  .slice(0, 8)
              : top(tree, rs, 8);
          return [
            { type: 'meter', value: meterValue(load), unit: unitOf(load), spark: houseSpark() },
            {
              type: 'kv',
              rows: [
                [
                  'House load',
                  [
                    fmtW(load),
                    ...(tot.partial ? [{ text: ' some meters have no data', muted: true } as InlineSpan] : []),
                  ],
                ],
                ...tot.sources.map(({ meter, w }) => [meter.label, fmtW(w)] as [string, string]),
                ...tot.storage.map(
                  ({ meter, w }) =>
                    [
                      meter.label,
                      w === null ? '—' : `${fmtW(Math.abs(w))} ${w > 0 ? 'charging' : w < 0 ? 'discharging' : ''}`,
                    ] as [string, string],
                ),
              ],
            },
            hasToday && {
              type: 'segmented',
              value: view,
              options: [
                { value: 'now', label: 'Now', title: 'Power now' },
                { value: 'today', label: 'Today', title: 'Energy since midnight' },
              ],
              onChange: (v) => {
                view = v as 'now' | 'today';
                panel.refresh();
              },
            },
            {
              type: 'list',
              title: 'Panels',
              rows: parents(tree).map((m) => rowOf(m, load)),
            },
            {
              type: 'list',
              title: view === 'today' ? 'Top consumers today' : 'Top consumers',
              rows: consumers.map((m) => rowOf(m, load)),
              empty: 'No meters',
            },
            !es.on && {
              type: 'callout',
              tone: 'info',
              text: 'Energy mode tints the rooms and objects by their load.',
              action: { label: 'Show it (J)', run: () => setOn(true) },
            },
          ];
        }),
    });
    // (a panel's key is shown on its rail button; the plugin binds it)
    ctx.keys.add({ code: 'KeyJ', shift: true, label: 'Energy panel', run: () => panel.toggle() });
    ctx.status.addItem({
      id: 'energy.load',
      order: 60,
      render: () =>
        tot.load === null && !store.live()
          ? null
          : { icon: 'bolt', text: fmtW(tot.load), title: 'House load: open the Energy panel' },
      onClick: () => panel.open(),
    });

    // ------------------------------------------------------------------ the inspector's Energy section
    const confTone = (c?: string) => (c === 'high' ? 'ok' : c === 'low' ? 'warn' : c === 'mock' ? 'info' : 'off');
    function detail(m: Meter): Blocks {
      const r = rs.get(m.id);
      const w = r?.w ?? null;
      const p = wantPast(m);
      const spark = p ? sparkline(p.series) : undefined;
      const today = todayOf(m);
      const month = m.month.length ? sumAll(m.month.map((e) => kwh(get(e)))) : null;
      const legs =
        m.power.length > 1
          ? m.power.map((e, i) => `${m.spec.legs?.[i] ?? `leg ${i + 1}`} ${fmtW(watts(get(e)))}`)
          : null;
      const missing = m.power.filter((e) => watts(get(e)) === null);
      const kids: LinkItem[] = [
        ...m.children.map((c) => ({
          text: `${c.label} · ${fmtW(rs.get(c.id)?.w)}`,
          icon: 'bolt',
          subject: subjectOf(c),
        })),
        ...(m.other
          ? [{ text: `Other · ${fmtW(rs.get(m.other.id)?.w)}`, icon: 'bolt', subject: `energy:${m.other.id}` }]
          : []),
      ];
      const feeds = (m.isOther ? [] : m.refs)
        .map((ref): LinkItem | null => {
          if (ref.startsWith('node:')) {
            const n = nodeNamed(ref.slice(5));
            return n ? { text: ref.slice(5), icon: 'cube', subject: { kind: 'object', node: n } } : null;
          }
          return ctx.inspector.resolve(ref) ? ref : null;
        })
        .filter((x): x is LinkItem => !!x);
      return [
        w === null && {
          type: 'status',
          tone: 'off',
          text: 'No data',
          detail: missing.length ? `${missing.join(', ')}: unavailable` : 'its meters have no data',
        },
        { type: 'meter', value: meterValue(w), unit: unitOf(w), spark: spark && spark.length > 1 ? spark : undefined },
        {
          type: 'kv',
          rows: [
            r?.partial ? ['Note', { text: 'some of its meters have no data', tone: 'warn' }] : null,
            m.isOther
              ? [
                  'What',
                  rs.get(m.id)?.reported
                    ? 'unmetered remainder (reported by the monitor)'
                    : 'unmetered remainder (computed)',
                ]
              : null,
            legs ? ['Legs', legs.join(' · ')] : null,
            m.panel ? ['Panel', m.panel] : null,
            m.breaker ? ['Breaker', { text: m.breaker, mono: true }] : null,
            m.spec.volts ? ['Voltage', `${m.spec.volts} V`] : null,
            m.today.length || today.v !== null
              ? ['Today', today.derived ? [fmtKWh(today.v), { text: ' from power', muted: true }] : fmtKWh(today.v)]
              : null,
            month !== null ? ['This month', fmtKWh(month)] : null,
            m.parent ? ['Share of parent', pct(share(m, rs))] : null,
            m.spec.conf ? ['Mapping', { text: m.spec.conf, pill: confTone(m.spec.conf) }] : null,
            m.spec.src ? ['Source', m.spec.src] : null,
          ],
        },
        p === null && { type: 'text', text: { text: 'Loading the last 24 hours…', muted: true } },
        m.spec.question && { type: 'callout', tone: 'warn', text: `Open question: ${m.spec.question}` },
        m.spec.note && { type: 'note', text: m.spec.note },
        m.parent && { type: 'links', title: 'On', items: [subjectOf(m.parent)] },
        kids.length > 0 && { type: 'links', title: 'Feeds', items: kids },
        feeds.length > 0 && { type: 'links', title: 'Objects', items: feeds },
      ];
    }
    ctx.inspector.addSection({
      id: 'energy',
      title: 'Energy',
      icon: 'bolt',
      order: 55,
      for: (s) => {
        const ms = metersOf(s);
        if (!ms.length) return null;
        if (ms.length === 1) return { blocks: detail(ms[0]) };
        // several meters feed it (a room on two circuits): their sum, then each one
        const counted = countable(ms);
        const ws = counted.map((m) => rs.get(m.id)?.w ?? null);
        const sum = ws.some((w) => w !== null) ? ws.reduce<number>((a, w) => a + (w ?? 0), 0) : null;
        return {
          blocks: [
            { type: 'meter', value: meterValue(sum), unit: unitOf(sum) },
            {
              type: 'list',
              title: `${ms.length} meters`,
              rows: ms.map((m) => ({
                id: m.id,
                text: m.label,
                secondary: `${where(m)}${counted.includes(m) ? '' : ' · counted in its parent'}`,
                value: fmtW(rs.get(m.id)?.w),
                subject: `energy:${m.id}`,
              })),
            },
          ],
        };
      },
    });

    // ------------------------------------------------------------------ hover and search
    ctx.hover.add({
      id: 'energy',
      label: (s) => {
        const ms = countable(metersOf(s));
        if (!ms.length) return null;
        const ws = ms.map((m) => rs.get(m.id)?.w ?? null).filter((w): w is number => w !== null);
        return ws.length ? fmtW(ws.reduce((a, b) => a + b, 0)) : 'no data';
      },
    });
    ctx.search.add({
      id: 'energy',
      label: 'Energy meters',
      order: 60,
      search: (q) => {
        const t = q.toLowerCase();
        return tree.all
          .filter(
            (m) =>
              !m.isOther &&
              [m.label, m.id, m.panel, m.breaker && `breaker ${m.breaker}`, ...m.power]
                .filter(Boolean)
                .some((x) => String(x).toLowerCase().includes(t)),
          )
          .slice(0, 20)
          .map((m) => ({
            text: m.label,
            secondary: `${where(m) || 'meter'} · ${fmtW(rs.get(m.id)?.w)}`,
            icon: 'bolt',
            subject: subjectOf(m),
          }));
      },
    });

    // ------------------------------------------------------------------ updates: coalesced, at most once a second
    let dirty = false;
    store.onChange(() => (dirty = true), tree.entityIds);
    const tick = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      rs = compute(tree, get);
      tot = totals(tree, rs);
      if (panel.isOpen) panel.refresh();
      ctx.hud.invalidate();
      ctx.inspector.refresh((s) => metersOf(s).length > 0);
      if (es.on) es.show(tint());
    }, TICK);
    ctx.own(() => clearInterval(tick));

    // ------------------------------------------------------------------ ?ha=mock: made-up loads
    const seed = () => +(ctx.url.get('hamock') as string) || 7;
    let mocked = false;
    let mockTimer: ReturnType<typeof setInterval> | undefined;
    const startMock = () => {
      if (mocked || !mocking()) return;
      mocked = true;
      const still = ctx.url.get('hamock') === 'static',
        t0 = Date.now();
      const push = () => store.simulate(mockStates(tree, still ? t0 : Date.now(), seed()));
      push();
      if (!still) mockTimer = setInterval(push, MOCK_TICK);
    };
    startMock();
    ctx.own(store.onConnectors(startMock));
    ctx.own(() => clearInterval(mockTimer));

    if (ctx.url.has('energy')) ctx.events.on('ready', () => setOn(true));
    ctx.expose('energy', {
      tree,
      readings: () => rs,
      totals: () => tot,
      get on() {
        return es.on;
      },
      setOn,
      metersOf: (s: SubjectRef) => {
        const r = ctx.inspector.resolve(s);
        return r ? metersOf(r).map((m) => m.id) : [];
      },
      scene: es,
    });
    return { dispose: () => es.dispose() };
  },
});
