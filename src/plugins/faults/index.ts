// Device faults: every device in the site's device map, its health from the store's live states (faults.ts), drawn
// through walls while the overlay is on. The Faults chip (V; Shift-V shows the healthy ones too), the Faults panel
// (counts by severity, the devices grouped by room, a count badge on the rail), a legend, and the Device health section.
// Subjects: 'devices:<device id>'. It also offers the overlay to the lights plugin (a fixture's own fault marker gives
// way to a device's). ?hawall starts with the overlay on, ?haall shows every device, ?habatt=30 and ?hastale=12 set the
// battery threshold and the stale hours.
import { human } from '../../core/text';
import type { FaultsConfig } from '../../site';
import { definePlugin, type Blocks, type Glyph, type LinkItem, type Subject, type Tone } from '../../plugin-api';
import type { Pins } from '../pins/pins';
import type { Switches } from '../switches/switches';
import { createFaults, COL, NAME, type Device } from './faults';
import { SEV, healthEntities, type Severity } from './health';

const TONE: Record<Severity, Tone> = { red: 'bad', amber: 'warn', blue: 'info', ok: 'ok' };
const LETTER: Record<Severity, string> = { red: '!', amber: '!', blue: '↑', ok: '✓' };

export default definePlugin<FaultsConfig>({
  id: 'faults',
  name: 'Device faults',
  after: ['home-assistant', 'pins', 'switches'],
  async setup(ctx) {
    const { scene, camera, renderer, model } = ctx.three;
    const store = ctx.store;
    const late: { panel?: { refresh(): void } } = {}; // the panel, once it exists
    const faults = createFaults({
      config: ctx.config,
      site: ctx.site,
      scene,
      camera,
      renderer,
      fixtures: model.fixtures,
      state: ctx.view.state as never,
      fly: (t, c) => ctx.view.fly(t, c),
      entities: () => store.entities(),
      active: () => store.live(),
      isMock: () => store.mock(),
      simulate: (list) => store.simulate(list),
      getPins: () => ctx.services.get<Pins>('pins') ?? null,
      getSwitches: () => ctx.services.get<Switches>('switches') ?? null,
      onChange: () => {
        late.panel?.refresh();
        ctx.hud.invalidate();
        ctx.inspector.refresh((s) => !!idOf(s));
      },
    });
    await faults.load();
    const idOf = (s: Subject | null) => (s?.kind === 'item' && s.id.startsWith('devices:') ? s.id.slice(8) : null);
    const colourOf = (d: Device) => (d.off && d.sev === 'ok' ? '#8a93a3' : COL[d.sev]);
    const glyphOf = (d: Device): Glyph => ({ letter: LETTER[d.sev], colour: colourOf(d), hollow: !!d.place?.approx });
    const toneOf = (d: Device): Tone => (d.off && d.sev === 'ok' ? 'off' : TONE[d.sev]);

    for (const d of faults.devices) ctx.store.bind({ ref: `devices:${d.id}`, entities: healthEntities(d) });
    store.onChange((c) => faults.onEntities(c.entities, c.previous));
    if (store.mock()) faults.mock();
    faults.recompute(faults.devices);

    // the overlay: the device markers, and the lights' own markers for fixtures no device covers
    const setOn = (v: boolean) => {
      faults.setOn(v);
      ctx.services.get<{ poke(): void }>('lights')?.poke();
      ctx.hud.invalidate();
    };
    ctx.services.provide('faults', {
      get on() {
        return faults.on;
      },
      setOn: (v: boolean) => setOn(v),
      covers: faults.covers,
    });
    ctx.events.on('frame', ({ dt }) => faults.update(dt));
    ctx.events.on('visibility', () => faults.refresh()); // markers upstairs go with U
    ctx.events.on('select', ({ subject }) => {
      const id = idOf(subject);
      const d = id ? faults.byId[id] : null;
      if (d !== faults.selected) faults.select(d || null);
    });
    ctx.pick.addScreenPicker({
      id: 'faults',
      order: 10, // over everything, pins included
      at: (ndc) => {
        const d = faults.at(ndc);
        return d ? { kind: 'item', id: `devices:${d.id}` } : null;
      },
    });
    ctx.hover.add({
      id: 'faults',
      label: (s) => {
        const d = faults.byId[idOf(s) || ''];
        return d ? `${d.why[0]?.text || d.off || 'ok'}${d.place?.approx ? ' (room only)' : ''}` : null;
      },
    });
    ctx.inspector.registerSubject('devices', {
      describe: (id) => {
        const d = faults.byId[id];
        if (!d) return null;
        return {
          title: d.name,
          type: [[d.make, d.model].filter(Boolean).join(' '), d.integration, human(d.place?.room || d.area)]
            .filter(Boolean)
            .join(' · '),
          glyph: glyphOf(d),
          crumbs: ['Faults', human(d.place?.room || d.area || 'not placed')],
        };
      },
      fly: (id) => void faults.go(id),
    });

    // ------------------------------------------------------------------ the chip, the legend
    ctx.status.addToggle({
      id: 'faults',
      label: 'Faults',
      title: 'Every device that needs attention, drawn through walls',
      order: 44,
      key: {
        code: 'KeyV',
        label:
          'Faults through walls: every device that needs attention gets a marker over everything (red offline, amber battery or signal, blue update; hollow = placed by its room only)',
      },
      when: () => store.live(),
      get: () => faults.on,
      set: (v) => setOn(v),
      text: () => (faults.all ? 'Faults · all' : 'Faults'),
      variants: [
        {
          label: 'Healthy devices too',
          key: {
            code: 'KeyV',
            shift: true,
            label: 'Faults through walls: the healthy devices too (green; grey = a bulb off at its wall switch)',
          },
          get: () => faults.all,
          set: (v) => {
            faults.setAll(v);
            if (v && !faults.on) setOn(true);
          },
        },
      ],
    });
    ctx.hud.addLegend({
      id: 'faults',
      title: 'Device health',
      hint: 'V · Shift-V all',
      when: () => faults.on && faults.active,
      items: () => [
        { label: 'offline', tone: 'bad' },
        { label: 'attention', tone: 'warn' },
        { label: 'update', tone: 'info' },
        ...(faults.all
          ? [
              { label: 'ok', tone: 'ok' as const },
              { label: 'off at a switch', colour: '#8a93a3' },
            ]
          : []),
        { label: 'room only', hollow: true },
      ],
    });

    // ------------------------------------------------------------------ the Faults panel
    const listed = () => faults.devices.filter((d) => faults.sevs.has(d.sev) || (faults.all && d.sev === 'ok'));
    const panel = ctx.hud.addPanel({
      id: 'faults',
      title: 'Faults',
      icon: 'fault',
      order: 50,
      badge: () => (faults.active && faults.counts.red ? faults.counts.red : null),
      badgeTone: () => 'bad',
      meta: () => (faults.active ? `${listed().length} of ${faults.devices.length} devices` : null),
      render: (body) =>
        body.blocks(() => {
          if (!faults.active)
            return [
              {
                type: 'empty',
                text: 'No live states: connect Home Assistant (the status strip) to see device health.',
              },
            ];
          const c = faults.counts;
          const rooms = new Map<string, Device[]>();
          for (const d of listed()) {
            const r = d.at ? human(d.place?.room || '?') : 'not placed';
            if (!rooms.has(r)) rooms.set(r, []);
            rooms.get(r)!.push(d);
          }
          const worst = (ds: Device[]) => ds.reduce((m, d) => Math.max(m, SEV[d.sev]), 0);
          const reds = (ds: Device[]) => ds.filter((d) => d.sev === 'red').length;
          const order = [...rooms.keys()].sort(
            (a, b) =>
              Number(a === 'not placed') - Number(b === 'not placed') ||
              worst(rooms.get(b)!) - worst(rooms.get(a)!) ||
              reds(rooms.get(b)!) - reds(rooms.get(a)!) ||
              a.localeCompare(b),
          );
          const sevChip = (k: Severity, label: string) => ({
            id: k,
            label,
            dot: TONE[k],
            count: c[k],
            on: faults.sevs.has(k),
            title: `${NAME[k]}: click to hide / show`,
            onToggle: () => {
              if (faults.sevs.has(k)) faults.sevs.delete(k);
              else faults.sevs.add(k);
              faults.refresh();
              panel.refresh();
            },
            onSolo: () => {
              faults.sevs.clear();
              faults.sevs.add(k);
              faults.refresh();
              panel.refresh();
            },
          });
          const out: Blocks = [
            {
              type: 'chips',
              items: [sevChip('red', 'offline'), sevChip('amber', 'attention'), sevChip('blue', 'updates')],
            },
            {
              type: 'toggle',
              label: `Show all ${faults.devices.length}`,
              key: 'Shift-V',
              title: `${c.ok} ok${c.off ? `, ${c.off} off at a switch` : ''}`,
              value: faults.all,
              onChange: (v) => faults.setAll(v),
            },
            !faults.on && {
              type: 'callout',
              tone: 'info',
              text: 'The markers are hidden.',
              action: { label: 'Show them (V)', run: () => setOn(true) },
            },
          ];
          for (const r of order) {
            const ds = rooms.get(r)!.sort((a, b) => SEV[b.sev] - SEV[a.sev] || a.name.localeCompare(b.name));
            out.push({
              type: 'group',
              id: `faults.room.${r}`,
              title: r,
              count: ds.length,
              blocks: [
                {
                  type: 'list',
                  rows: ds.map((d) => ({
                    id: d.id,
                    text: d.name,
                    secondary: `${d.place?.approx ? '◌ room only · ' : ''}${d.why[0]?.text || d.off || 'ok'}`,
                    dot: toneOf(d),
                    selected: faults.selected === d,
                    title: d.why.map((x) => x.text).join('; ') || d.off || 'ok',
                    subject: `devices:${d.id}`,
                  })),
                },
              ],
            });
          }
          if (!order.length) out.push({ type: 'empty', text: 'Nothing to show' });
          return out;
        }),
    });
    late.panel = panel;

    // ------------------------------------------------------------------ the Device health section
    const placeText = (d: Device): string => {
      const pl = d.place;
      if (!pl) return 'not placed (no HA area, no placement hint)';
      const how =
        (
          {
            registry: 'at its registry item',
            plate: 'at its wall plate',
            fixture: 'at the light fixture it is in',
            area: "its area's room centroid",
          } as Record<string, string>
        )[pl.src] || pl.src;
      return `${human(pl.room)} · ${how}${pl.approx && pl.src !== 'area' ? ' (approx)' : ''}`;
    };
    const links = (d: Device): LinkItem[] => {
      const pl = d.place || ({} as NonNullable<Device['place']>);
      const out: LinkItem[] = [];
      const pins = ctx.services.get<Pins>('pins');
      const sw = ctx.services.get<Switches>('switches');
      if (pl.src === 'registry') out.push(pins?.byId[pl.ref as string] ? `pins:${pl.ref}` : { text: String(pl.ref) });
      if (pl.src === 'plate') {
        const p = sw?.byId[pl.ref as string];
        out.push(p ? `plates:${p.id}` : { text: `plate ${pl.ref}`, icon: 'plate' });
      }
      const fx = pl.src === 'fixture' ? faults.refs(pl.ref) : d.fixtures || [];
      for (const f of fx)
        out.push(model.fixtures[f] ? `fixture:${f}` : { text: `${f} (not in the model)`, icon: 'bulb' });
      const reg = fx.map((f) => pins?.byFixture(f)).find(Boolean);
      if (reg && pl.src !== 'registry') out.push(`pins:${reg.id}`);
      return out;
    };
    ctx.inspector.addSection({
      id: 'faults',
      title: 'Device health',
      icon: 'pulse',
      order: 10,
      for: (s) => {
        const d = faults.byId[idOf(s) || ''];
        if (!d) return null;
        const failing = [...new Set(d.why.flatMap((r) => r.entities || []))];
        const status: Blocks = !faults.active
          ? [{ type: 'status', tone: 'off', text: 'Not connected' }]
          : d.why.length
            ? d.why.map((r) => ({
                type: 'status' as const,
                tone: TONE[r.sev],
                text: r.text,
                detail: r.since
                  ? `since ${new Date(r.since).toLocaleString('en-GB')} (${faults.ago(r.since)})`
                  : undefined,
              }))
            : [
                {
                  type: 'status',
                  tone: d.off ? 'off' : d.known ? 'ok' : 'off',
                  text: d.off || (d.known ? 'ok' : 'no state for its entities'),
                },
              ];
        const l = links(d);
        return {
          blocks: [
            ...status,
            {
              type: 'kv',
              rows: [
                ['Model', [d.make, d.model].filter(Boolean).join(' ') || { text: 'unknown', muted: true }],
                ['Integration', d.integration || ''],
                ['Area', d.area || 'none'],
                [
                  'Placed',
                  [
                    placeText(d),
                    ...(d.place?.conf
                      ? [{ text: d.place.conf, pill: d.place.conf === 'high' ? ('ok' as const) : ('warn' as const) }]
                      : []),
                  ],
                ],
                d.unavailable_means
                  ? [
                      'Unavailable',
                      `means off: ${d.unavailable_means.off}${d.unavailable_means.unless_on ? `; a fault if any of ${d.unavailable_means.unless_on.length} bulb(s) on the same switch answers` : ''}`,
                    ]
                  : null,
                d.powered_by ? ['Powered by', { text: d.powered_by, mono: true }] : null,
                ctx.config.source ? ['Source', { text: ctx.config.source, mono: true }] : null,
              ],
            },
            d.place?.why && { type: 'note', text: d.place.why, lines: 2 },
            failing.length > 0 && {
              type: 'list',
              title: 'Failing',
              rows: failing.map((e) => ({
                id: e,
                text: e,
                secondary: store.get(e)?.state ?? 'no state',
                dot: 'bad' as const,
              })),
            },
            l.length > 0 && { type: 'links', title: 'Related', items: l },
          ],
        };
      },
    });
    ctx.search.add({
      id: 'faults',
      label: 'Devices',
      order: 35,
      search: (q) =>
        faults.devices
          .filter((d) => `${d.name} ${d.area || ''} ${d.make || ''} ${d.model || ''}`.toLowerCase().includes(q))
          .slice(0, 8)
          .map((d) => ({
            text: d.name,
            secondary: [d.why[0]?.text || d.off || NAME[d.sev], human(d.place?.room || d.area)]
              .filter(Boolean)
              .join(' · '),
            glyph: glyphOf(d),
            subject: `devices:${d.id}`,
          })),
    });
    ctx.expose('faults', faults);
    return {
      dispose: () => {
        setOn(false);
        faults.dispose();
      },
    };
  },
});
