// The Home Assistant connector plugin: fills the store (connector.ts) and contributes its own UI: a status item
// (connected / live / error) that opens a small connector modal (connect, disconnect, the error), the Controls panel
// (the site's scripts and switches, with the standard confirm), and a "Home Assistant" inspector section on anything
// the site binds to entities (a fixture, a registry item, a device, a plate). It draws nothing in the scene: the lights
// and faults feature plugins read the store.
import type { HomeAssistantConfig, LightsConfig, Site } from '../../site';
import { definePlugin, type Blocks, type InlineSpan, type Subject, type Tone } from '../../plugin-api';
import { createConnector } from './connector';
import type { Control, ConnectorStatusLabel, HomeAssistantAuth } from './types';

const LABEL: ConnectorStatusLabel = {
  disconnected: 'not connected',
  connecting: 'connecting…',
  live: 'live',
  error: 'error',
  mock: 'mock data',
};
const TONE: Record<keyof ConnectorStatusLabel, Tone> = {
  disconnected: 'off',
  connecting: 'warn',
  live: 'ok',
  error: 'bad',
  mock: 'info',
};

export const ago = (iso: string): string => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 90
    ? `${Math.round(s)} s ago`
    : s < 5400
      ? `${Math.round(s / 60)} min ago`
      : s < 172800
        ? `${Math.round(s / 3600)} h ago`
        : `${Math.round(s / 86400)} d ago`;
};

type HAConfig = NonNullable<Site['plugins']['home-assistant']> & HomeAssistantConfig;

export default definePlugin<HAConfig>({
  id: 'home-assistant',
  name: 'Home Assistant',
  async setup(ctx) {
    const mode = ctx.url.get('ha') === 'mock' ? 'mock' : ctx.url.get('ha') === 'off' ? 'off' : 'live';
    let lastErr = '';
    const handle = ctx.store.addConnector({
      id: 'home-assistant',
      name: 'Home Assistant',
      call: (ids, action, data) => c.call(ids, action, data),
      refusal: (ids, action, data) => c.refusal(ids, action, data),
      simulate: (states) => c.mock?.load(states),
      history: (id, from, to) => c.readHistory(id, from, to),
    });
    const c = createConnector({
      hassUrl: ctx.config.url || '',
      controlsUrl: ctx.config.controls,
      mapUrl: (ctx.site.plugins.lights as LightsConfig | null)?.map, // the site's fixture map: part of the allow-list
      mode,
      mockSeed: ctx.url.get('hamock'),
      handle,
      fixtures: ctx.three.model.fixtures,
      bindMock: (fid, e) => ctx.store.bind({ ref: `fixture:${fid}`, entities: [e], conf: 'mock', src: '?ha=mock' }),
      onChange: () => {
        if (c.status === 'error' && c.error && c.error !== lastErr)
          ctx.toast({ text: `Home Assistant: ${c.error}`, tone: 'bad' });
        lastErr = c.status === 'error' ? c.error : '';
        controls.refresh();
        ctx.hud.invalidate();
        ctx.inspector.refresh();
        modal?.refresh();
      },
    });
    ctx.events.on('model', ({ id }) => {
      if (id !== 'main') c.fixturesAdded();
    });
    // the person's login for other plugins (the assistant's server checks it): docs/plugins.md
    ctx.services.provide<HomeAssistantAuth>('home-assistant.auth', { accessToken: () => c.accessToken() });

    // ------------------------------------------------------------------ status item and the connector modal
    let modal: { close(): void; refresh(): void } | null = null;
    const openModal = () => {
      modal?.close();
      modal = ctx.modal({
        title: 'Home Assistant',
        blocks: () => [
          { type: 'status', tone: TONE[c.status], text: LABEL[c.status], detail: c.error || undefined },
          {
            type: 'kv',
            rows: [
              ['Server', c.hassUrl ? { text: c.hassUrl, href: c.hassUrl } : 'none in the site manifest'],
              ['Entities', String(Object.keys(c.entities).length)],
              ['Allowed to switch', `${c.allow.size} entities (the site's controls and fixture map)`],
            ],
          },
          mode === 'live' && {
            type: 'text',
            text: {
              text: "Logs in with Home Assistant's own login page; the tokens stay in this browser. Home Assistant must list this page's origin in http: cors_allowed_origins.",
              muted: true,
            },
          },
          mode === 'mock' && {
            type: 'callout',
            tone: 'info',
            text: 'Mock data (?ha=mock): nothing reaches Home Assistant.',
          },
        ],
        actions: () =>
          mode !== 'live'
            ? [{ label: 'Close', kind: 'primary', onClick: () => modal?.close() }]
            : c.conn || c.status === 'connecting'
              ? [
                  { label: 'Disconnect and forget', kind: 'danger', onClick: () => c.disconnect(true) },
                  { label: 'Close', onClick: () => modal?.close() },
                ]
              : [
                  { label: 'Close', onClick: () => modal?.close() },
                  { label: 'Connect', kind: 'primary', onClick: () => void c.connect() },
                ],
        onClose: () => (modal = null),
      });
    };
    ctx.status.addItem({
      id: 'home-assistant',
      order: 200,
      render: () => ({
        dot: TONE[c.status],
        text: `Home Assistant${c.status === 'live' ? '' : ` · ${LABEL[c.status]}`}`,
        title: c.error || `Home Assistant: ${LABEL[c.status]}`,
      }),
      onClick: openModal,
    });

    // ------------------------------------------------------------------ the Controls panel
    const ctlRow = (ctl: Control) => {
      const st = c.entities[ctl.entity_id];
      const state = st?.state;
      const pend = c.pending[ctl.id];
      const busy = pend === 'sent' || (ctl.action === 'run' && state === 'on');
      let secondary = ctl.action === 'run' ? 'script' : state || '';
      const w = ctl.power && c.entities[ctl.power];
      if (ctl.action === 'toggle' && w && state === 'on' && w.state !== 'unavailable')
        secondary += ` · ${Math.round(+w.state)} W`;
      if (busy) secondary = ctl.action === 'run' ? 'running…' : 'switching…';
      if (!st) secondary = 'not in Home Assistant';
      else if (state === 'unavailable') secondary = 'unavailable';
      if (pend && pend !== 'sent') secondary = pend;
      return { st, busy, secondary, on: ctl.action === 'toggle' && state === 'on' };
    };
    const run = async (ctl: Control) => {
      const err = await c.act(ctl, (q) =>
        ctx.confirm({ title: ctl.label, text: q, confirm: ctl.action === 'run' ? 'Run' : 'Switch' }),
      );
      if (err) ctx.toast({ text: `${ctl.label}: ${err}`, tone: 'bad' });
    };
    const controls = ctx.hud.addPanel({
      id: 'home-assistant.controls',
      title: 'Controls',
      icon: 'power',
      order: 70,
      when: () => c.controls.length > 0 && (c.status === 'live' || c.status === 'mock'),
      render: (body) =>
        body.blocks(() => [
          {
            type: 'list',
            rows: c.controls.map((ctl) => {
              const r = ctlRow(ctl);
              return {
                id: ctl.id,
                text: ctl.label,
                secondary: r.secondary,
                dot: r.on ? 'ok' : r.st?.state === 'unavailable' ? 'bad' : 'off',
                value: r.busy ? '…' : ctl.action === 'run' ? 'Run' : r.on ? 'Turn off' : 'Turn on',
                title: `${ctl.action === 'run' ? 'Run' : 'Switch'} ${r.st?.attributes?.friendly_name || ctl.entity_id} in Home Assistant${ctl.confirm ? ' (asks first)' : ''}`,
                run: r.busy || !r.st || r.st.state === 'unavailable' ? undefined : () => void run(ctl),
              };
            }),
          },
          { type: 'text', text: { text: "Only the site's controls file can be run from here.", muted: true } },
        ]),
    });

    // ------------------------------------------------------------------ the inspector section: bound entities
    const fmtState = (e: string): string => {
      const st = c.entities[e];
      if (!st) return c.status === 'live' || c.status === 'mock' ? 'not in Home Assistant' : 'not connected';
      const a = st.attributes || {};
      let s = st.state;
      if (a.unit_of_measurement) s += ` ${a.unit_of_measurement}`;
      if (st.state === 'on') {
        if (a.brightness != null) s += ` · ${Math.round((100 * a.brightness) / 255)} %`;
        if (Array.isArray(a.rgb_color) && a.color_mode !== 'color_temp') s += ` · rgb(${a.rgb_color.join(', ')})`;
        else if (a.color_temp_kelvin) s += ` · ${a.color_temp_kelvin} K`;
      }
      return s;
    };
    const tone = (e: string): Tone => {
      const s = c.entities[e]?.state;
      return s === 'on' ? 'ok' : s === 'unavailable' || s === 'unknown' ? 'bad' : 'off';
    };
    ctx.inspector.addSection({
      id: 'home-assistant',
      title: 'Home Assistant',
      icon: 'home',
      order: 60,
      for: (s: Subject) => {
        const ref = ctx.inspector.refOf(s);
        if (!ref) return null;
        const bs = ctx.store.bindingsOf(ref);
        const ents = ctx.store.entitiesOf(ref);
        if (!bs.length) return null;
        const b0 = bs[0];
        const out: Blocks = [];
        if (!ents.length) {
          out.push({
            type: 'text',
            text: { text: `No entity mapped yet${b0.src ? ` (${b0.src})` : ''}`, muted: true },
          });
          return { blocks: out };
        }
        const mapping: InlineSpan[] = [];
        if (b0.conf)
          mapping.push({ text: b0.conf, pill: b0.conf === 'high' ? 'ok' : b0.conf === 'mock' ? 'info' : 'warn' });
        if (b0.src) mapping.push({ text: b0.src, muted: true });
        if (ents.length === 1) {
          const e = ents[0];
          const st = c.entities[e];
          out.push({
            type: 'kv',
            rows: [
              ['Entity', { text: e, mono: true }],
              st?.attributes?.friendly_name ? ['Name', st.attributes.friendly_name] : null,
              ['State', fmtState(e)],
              st?.last_changed
                ? ['Last change', `${new Date(st.last_changed).toLocaleString('en-GB')} (${ago(st.last_changed)})`]
                : null,
              mapping.length ? ['Mapping', mapping] : null,
            ],
          });
        } else {
          if (mapping.length) out.push({ type: 'kv', rows: [['Mapping', mapping]] });
          out.push({
            type: 'list',
            title: `Entities (${ents.length})`,
            rows: ents.slice(0, 14).map((e) => ({ id: e, text: e, secondary: fmtState(e), dot: tone(e) })),
          });
          if (ents.length > 14) out.push({ type: 'text', text: { text: `+ ${ents.length - 14} more`, muted: true } });
        }
        if (c.hassUrl) {
          const href = ref.startsWith('devices:')
            ? `${c.hassUrl}/config/devices/device/${encodeURIComponent(ref.slice(8))}`
            : `${c.hassUrl}/history?entity_id=${encodeURIComponent(ents.join(','))}`;
          out.push({ type: 'links', items: [{ text: 'Open in Home Assistant', href, icon: 'link' }] });
        }
        return { blocks: out };
      },
    });

    // The console hook: read-only, so the allow-list's inputs (controls, map, policy, mode) can't be changed from it,
    // and no send(). The mock's test handles (failNext, set, calls) exist only with ?ha=mock. setWallhack is the faults
    // plugin's overlay now (kept for scripts written against the prototype).
    ctx.expose(
      'ha',
      Object.freeze({
        get mode() {
          return c.mode;
        },
        get status() {
          return c.status;
        },
        get error() {
          return c.error;
        },
        get entities() {
          return c.entities;
        },
        get mock() {
          return c.mock;
        },
        get hassUrl() {
          return c.hassUrl;
        },
        /** the entities send() may call, and the services each may have (a copy) */
        get allowed() {
          return Object.fromEntries([...c.allow].map(([e, s]) => [e, [...s]]));
        },
        connect: () => c.connect(),
        disconnect: (forget = false) => c.disconnect(forget),
        get wallhack() {
          return !!ctx.services.get<{ on: boolean }>('faults')?.on;
        },
        setWallhack: (on: boolean) => ctx.services.get<{ setOn(v: boolean): void }>('faults')?.setOn(on),
      }),
    );
    await c.start();
    return { dispose: () => c.dispose() };
  },
});
