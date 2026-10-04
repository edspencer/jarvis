// The plugin host: which plugins start (a manifest section, or autoStart), in what order (`requires` and `after`),
// each in isolation: a plugin that throws during setup (or whose requirement didn't start) is disposed, reported, and
// the rest carry on. Independent plugins start in parallel; a plugin waits only for the ones it names.
import type { Disposable, PluginContext, PluginDef, PluginInstance } from './types';

export type PluginState = 'pending' | 'starting' | 'running' | 'failed' | 'skipped' | 'disposed';

export interface PluginRecord {
  def: PluginDef;
  state: PluginState;
  error?: string;
  /** what it registered, disposed with it */
  disposers: Disposable[];
  instance?: PluginInstance | void;
}

export interface HostDeps {
  /** does the site enable this plugin (a manifest section)? */
  enabled(id: string): boolean;
  /** the context for one plugin; `own` collects what it registers (disposed with it) */
  context(def: PluginDef, own: (d: Disposable) => void): PluginContext;
  /** a plugin failed or was skipped: tell the person (a toast) */
  report(def: PluginDef, message: string): void;
}

export interface PluginHost {
  /** start the plugins (resolves when every one has started, failed or been skipped) */
  start(defs: PluginDef[]): Promise<void>;
  /** stop one, and the running plugins that require it */
  dispose(id: string): void;
  disposeAll(): void;
  running(id: string): boolean;
  records(): PluginRecord[];
  /** the start order chosen (for tests and the console) */
  order: string[];
}

/** Order plugins so each comes after the ones it requires and (if present) those in `after`. Throws on a cycle. */
export function startOrder(defs: PluginDef[]): PluginDef[] {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const out: PluginDef[] = [];
  const mark = new Map<string, 'visiting' | 'done'>();
  const visit = (d: PluginDef, path: string[]) => {
    const m = mark.get(d.id);
    if (m === 'done') return;
    if (m === 'visiting') throw new Error(`plugins: a cycle in requires/after: ${[...path, d.id].join(' -> ')}`);
    mark.set(d.id, 'visiting');
    for (const r of [...(d.requires || []), ...(d.after || [])]) {
      const dep = byId.get(r);
      if (dep) visit(dep, [...path, d.id]);
    }
    mark.set(d.id, 'done');
    out.push(d);
  };
  for (const d of defs) visit(d, []);
  return out;
}

const msg = (err: unknown) => String((err as Error)?.message || err);

export function createPluginHost(deps: HostDeps): PluginHost {
  const recs = new Map<string, PluginRecord>();
  const host: PluginHost = {
    order: [],
    async start(defs) {
      const enabled = defs.filter((d) => {
        if (recs.has(d.id)) {
          console.warn(`plugins: ${d.id} is already loaded`);
          return false;
        }
        return d.autoStart || deps.enabled(d.id);
      });
      let ordered: PluginDef[];
      try {
        ordered = startOrder(enabled);
      } catch (err) {
        console.error(err);
        for (const d of enabled) deps.report(d, msg(err));
        return;
      }
      host.order = [...host.order, ...ordered.map((d) => d.id)];
      for (const d of ordered) recs.set(d.id, { def: d, state: 'pending', disposers: [] });
      const done = new Map<string, Promise<boolean>>();
      for (const d of ordered) {
        const waits = [...(d.requires || []), ...(d.after || [])].filter((r) => done.has(r) || recs.has(r));
        const p = Promise.all(waits.map((r) => done.get(r) ?? Promise.resolve(host.running(r)))).then((oks) =>
          run(d, waits, oks),
        );
        done.set(d.id, p);
      }
      await Promise.all(done.values());
    },
    dispose(id) {
      const r = recs.get(id);
      if (!r || r.state === 'disposed') return;
      for (const o of recs.values()) if (o.state === 'running' && o.def.requires?.includes(id)) host.dispose(o.def.id);
      stop(r, 'disposed');
    },
    disposeAll() {
      for (const id of [...host.order].reverse()) host.dispose(id);
    },
    running: (id) => recs.get(id)?.state === 'running',
    records: () => [...recs.values()],
  };

  function stop(r: PluginRecord, state: PluginState): void {
    try {
      r.instance?.dispose?.();
    } catch (err) {
      console.error(`plugin ${r.def.id}: dispose failed`, err);
    }
    for (const d of r.disposers.splice(0).reverse()) {
      try {
        d.dispose();
      } catch (err) {
        console.error(`plugin ${r.def.id}: a disposer failed`, err);
      }
    }
    r.state = state;
  }

  async function run(d: PluginDef, waits: string[], oks: boolean[]): Promise<boolean> {
    const r = recs.get(d.id)!;
    const missing = (d.requires || []).filter((q) => !waits.includes(q) || !oks[waits.indexOf(q)]);
    if (missing.length) {
      r.state = 'skipped';
      r.error = `needs ${missing.join(', ')}, which ${missing.length > 1 ? "aren't" : "isn't"} running`;
      console.warn(`plugin ${d.id} off: ${r.error}`);
      deps.report(d, r.error);
      return false;
    }
    r.state = 'starting';
    try {
      const ctx = deps.context(d, (x) => r.disposers.push(x));
      r.instance = await d.setup(ctx);
      if (r.state !== 'starting') return false; // disposed while starting
      r.state = 'running';
      return true;
    } catch (err) {
      r.error = msg(err);
      console.warn(`plugin ${d.id} off (${r.error}); the walkthrough works without it`);
      stop(r, 'failed');
      deps.report(d, r.error);
      return false;
    }
  }

  return host;
}
