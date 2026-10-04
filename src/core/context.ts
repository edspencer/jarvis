// One plugin's ctx: the core's services, with every registration collected so that disposing (or a failed start)
// removes all of it, and the plugin's own config, storage and log prefix.
import type { Site } from '../site';
import type { Hud } from '../ui/hud';
import type { Picker } from './inspect';
import type { Bus } from './plugin/events';
import { createStorage } from './plugin/env';
import type { PluginHost } from './plugin/host';
import type { KeyRegistry } from './plugin/keys';
import { keyName } from './plugin/keys';
import type { createStore } from './plugin/store';
import type {
  Disposable,
  KeyBinding,
  PluginContext,
  PluginDef,
  ThreeApi,
  ToggleSpec,
  UrlApi,
  ViewApi,
} from './plugin/types';

export interface CoreServices {
  site: Site;
  three: ThreeApi;
  view: ViewApi;
  picker: Picker;
  bus: Bus;
  keys: KeyRegistry;
  store: ReturnType<typeof createStore>;
  hud: Hud;
  services: Map<string, unknown>;
  url: UrlApi;
  twin: Record<string, unknown>;
  host(): PluginHost;
}

/** A chip's keys: they do what a click does, and only while the chip shows (its `when`, and the key's own). */
export function toggleKeys(t: ToggleSpec, on: { toggle(): void; changed(): void }): KeyBinding[] {
  const both = (w?: () => boolean) => (t.when || w ? () => (!t.when || t.when()) && (!w || w()) : undefined);
  const out: KeyBinding[] = [];
  if (t.key) out.push({ ...t.key, when: both(t.key.when), run: () => on.toggle() });
  for (const v of t.variants || [])
    if (v.key)
      out.push({
        ...v.key,
        when: both(v.key.when),
        run: () => {
          v.set(!v.get());
          on.changed();
        },
      });
  return out;
}

export function createContextFactory(core: CoreServices) {
  return function makeContext(def: PluginDef, own: (d: Disposable) => void): PluginContext {
    const { hud } = core;
    const keep = <T extends Disposable>(d: T): T => (own(d), d);
    const id = def.id;
    const log = {
      info: (...a: unknown[]) => console.info(`[${id}]`, ...a),
      warn: (...a: unknown[]) => console.warn(`[${id}]`, ...a),
      error: (...a: unknown[]) => console.error(`[${id}]`, ...a),
    };
    let reported = false;
    const handlerFailed = (err: unknown) => {
      if (reported) return;
      reported = true;
      hud.toast({
        text: `${def.name}: something went wrong (${(err as Error)?.message || err}); see the console`,
        tone: 'warn',
      });
    };
    const section = (o: object | undefined) =>
      o && Object.hasOwn(o, id) ? (o as Record<string, unknown>)[id] : undefined;
    const config = (section(core.site.plugins) ?? section(core.site.manifest.plugins) ?? {}) as never;
    const inspector = hud.inspector(id);
    const ctx: PluginContext = {
      id,
      site: core.site,
      config,
      three: core.three,
      view: {
        ...core.view,
        state: core.view.state,
        addVisibilityRule: (fn) => keep(core.view.addVisibilityRule(fn)),
      },
      pick: core.picker.scoped(own),
      events: core.bus.scoped(id, own, handlerFailed),
      keys: {
        add: (k) => keep(core.keys.add(id, def.name, k)),
        list: () => core.keys.list(),
        name: keyName,
      },
      store: core.store.scoped(id, own),
      hud: {
        addPanel: (p) => keep(hud.addPanel(id, p)),
        addLegend: (l) => keep(hud.addLegend(l)),
        invalidate: () => hud.update('rail', 'dock', 'status', 'legend'),
      },
      inspector: {
        ...inspector,
        addSection: (s) => keep(inspector.addSection(s)),
        registerSubject: (k, r) => keep(inspector.registerSubject(k, r)),
        describeObject: (fn) => keep(inspector.describeObject(fn)),
      },
      status: {
        addItem: (i) => keep(hud.addItem(id, i)),
        addToggle: (t) => {
          const d = hud.addToggle(id, t);
          const ks = toggleKeys(t, {
            toggle: () => hud.setToggle(t, !t.get()),
            changed: () => hud.update('status', 'legend'),
          }).map((k) => core.keys.add(id, def.name, k));
          return keep({ dispose: () => (d.dispose(), ks.forEach((k) => k.dispose())) });
        },
        progress: (label) => {
          const p = hud.addProgress(label);
          own({ dispose: () => p.done() });
          return p;
        },
      },
      hover: { add: (p) => keep(hud.addHover(p)) },
      search: { add: (p) => keep(hud.addSearch(p)) },
      toast: (t) => hud.toast(t),
      confirm: (c) => hud.confirm(c),
      modal: (m) => {
        const h = hud.modal(m);
        own({ dispose: () => h.close() });
        return h;
      },
      url: core.url,
      storage: createStorage(`jarvis.${core.site.id}.${id}`),
      services: {
        provide: (name, api) => {
          if (core.services.has(name)) log.warn(`service ${name} is already provided; replacing it`);
          core.services.set(name, api);
          return keep({
            dispose: () => {
              if (core.services.get(name) === api) core.services.delete(name);
            },
          });
        },
        get: <T>(name: string) => core.services.get(name) as T | undefined,
      },
      plugins: { has: (p) => core.host().running(p) },
      log,
      async load<T>(path: string): Promise<T> {
        const u = new URL(path, core.site.url).href;
        const r = await fetch(u);
        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
        return (await r.json()) as T;
      },
      expose(name, api) {
        core.twin[name] = api;
        own({
          dispose: () => {
            if (core.twin[name] === api) delete core.twin[name];
          },
        });
      },
      own(d) {
        own(typeof d === 'function' ? { dispose: d } : d);
      },
    };
    return ctx;
  };
}
