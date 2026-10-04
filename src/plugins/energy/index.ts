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
  overshoot,
  powerOf,
  sumOf,
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
import { sparkline, sumSeries } from './history';
import { mockHistory, mockStates } from './mock';
import { createPast, type Past } from './past';
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
      // not onto nodes (no reference) nor fixtures: a fixture's bindings are the lights plugin's (its light entities)
      for (const r of m.refs) if (!r.startsWith('node:') && !r.startsWith('fixture:')) ctx.store.bind({ ref: r, ...b });
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
    let disposed = false;
    /** W per unit of an entity's history (from its unit now); null: not in the store, or not a power unit */
    const factor = (e: string): number | null => {
      const st = get(e);
      return st ? watts({ ...st, state: '1' }) : null;
    };
    const mocking = () => store.mock() && ctx.url.get('energymock') !== 'off';
    const historyOf = async (e: string, from: number, to: number): Promise<HistoryPoint[]> => {
      if (mocking()) return mockHistory(tree, e, from, to, seed());
      const f = factor(e);
      if (f === null) return [];
      return (await store.history(e, from, to)).map((p) => ({ ...p, v: p.v === null ? null : p.v * f }));
    };
    // at most 4 requests at once; a parent's fetch caches its children's (past.ts)
    const past = createPast({
      history: historyOf,
      ttl: HISTORY_TTL,
      span: DAY,
      buckets: BUCKETS,
      onError: (m, e) => ctx.log.warn(`energy: no history for ${m.id}: ${e.message}`),
    });
    /** a meter's past as known now; asks for it if it isn't fresh (the UI refreshes when it comes) */
    function wantPast(m: Meter): Past | null {
      if (!m.isOther && !past.settled(m))
        void past.load(m).then(() => {
          if (disposed) return;
          ctx.inspector.refresh((s) => metersOf(s).includes(m));
          panel.refresh();
        });
      return past.get(m);
    }
    const todayOf = (m: Meter): { v: number | null; derived: boolean } => {
      if (m.today.length) return { v: sumAll(m.today.map((e) => kwh(get(e)))), derived: false };
      return { v: past.get(m)?.today ?? null, derived: true };
    };

    // ------------------------------------------------------------------ the scene: energy mode
    const es = createEnergyScene({ scene, model, camera, materials: ctx.three.materials });
    const anchorCache = new Map<string, THREE.Vector3 | null>();
    function anchorAt(ref: string): THREE.Vector3 | null {
      if (anchorCache.has(ref)) return anchorCache.get(ref)!;
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
    // round first, then choose W or kW (999.6 W is 1.00 kW; -0.3 W of CT noise is 0 W)
    const unitOf = (w: number | null) => (w !== null && Math.round(Math.abs(w)) >= 1000 ? 'kW' : 'W');
    const meterValue = (w: number | null) => {
      if (w === null) return '—';
      const a = Math.round(Math.abs(w));
      if (a < 1000) return Math.round(w) || 0;
      const kw = w / 1000;
      return Math.abs(kw) < 9.995 ? kw.toFixed(2) : kw.toFixed(1);
    };
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
          // Today: by kWh where it is known (an energy sensor, or a history already fetched), the rest after them by
          // their power now; only the rows shown, and only those without an energy sensor, fetch their history
          const consumers =
            view === 'today'
              ? top(tree, rs)
                  .map((m, i) => [m, todayOf(m).v, i] as const)
                  .sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1) || a[2] - b[2])
                  .slice(0, 8)
                  .map(([m]) => m)
              : top(tree, rs, 8);
          if (view === 'today') for (const m of consumers) if (!m.today.length) wantPast(m);
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
    /** the warning for a parent whose children add up to well more than it measures (on it and on its Other) */
    const overText = (m: Meter): string | null => {
      const parent = m.isOther ? m.parent! : m.other ? m : null;
      if (!parent?.other) return null;
      const over = overshoot(rs.get(parent.other.id), rs.get(parent.id)?.w);
      return over === null
        ? null
        : `Its meters add up to ${fmtW(over)} more than ${parent.label} measures (Other is shown as 0). Usually a mapping error: a meter under the wrong parent, or a kW sensor without a unit read as W.`;
    };
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
        p === null && !m.isOther && { type: 'text', text: { text: 'Loading the last 24 hours…', muted: true } },
        overText(m) && { type: 'callout', tone: 'warn', text: overText(m)! },
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
        const counted = countable(ms, rs);
        const { w: sum, partial } = sumOf(ms, rs);
        return {
          blocks: [
            { type: 'meter', value: meterValue(sum), unit: unitOf(sum) },
            partial && {
              type: 'text',
              text: { text: 'Some of its meters have no data: the sum is partial', tone: 'warn' },
            },
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
        const ms = metersOf(s);
        if (!ms.length) return null;
        const { w, partial } = sumOf(ms, rs);
        return w === null ? 'no data' : `${fmtW(w)}${partial ? ' (partial)' : ''}`;
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

    // ------------------------------------------------------------------ readings that look like mapping errors (logged once)
    const told = new Set<string>();
    const tellOnce = (key: string, msg: string) => {
      if (told.has(key)) return;
      told.add(key);
      ctx.log.warn(`energy: ${msg}`);
    };
    function checkReadings(): void {
      for (const m of tree.all) {
        if (m.isOther) {
          const over = overshoot(rs.get(m.id), rs.get(m.parent!.id)?.w);
          if (over !== null)
            tellOnce(
              `over:${m.id}`,
              `${m.parent!.label}'s children add up to ${fmtW(over)} more than it measures: a meter under the wrong parent, or a kW sensor without a unit?`,
            );
          continue;
        }
        // a number in a unit that isn't power (VA) or energy (Wh, kWh) is no data: say why
        for (const [list, read, what] of [
          [m.power, watts, 'power (W, kW)'],
          [[...m.today, ...m.month], kwh, 'energy (Wh, kWh)'],
        ] as const)
          for (const e of list) {
            const st = get(e);
            if (st && Number.isFinite(Number(st.state)) && st.state !== '' && read(st) === null)
              tellOnce(
                `unit:${e}`,
                `${e} is in "${st.attributes?.unit_of_measurement ?? ''}", not a ${what} unit: it reads as no data`,
              );
          }
      }
    }
    checkReadings();

    // ------------------------------------------------------------------ updates: coalesced, at most once a second
    let dirty = false;
    store.onChange(() => (dirty = true), tree.entityIds);
    const tick = setInterval(() => {
      // energy mode: ghost what changed meanwhile (the lights preparing a fixture, a model coming in)
      if (!dirty) return void (es.on && es.show(tint()));
      dirty = false;
      rs = compute(tree, get);
      tot = totals(tree, rs);
      checkReadings();
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
    return {
      dispose: () => {
        disposed = true;
        es.dispose();
      },
    };
  },
});
