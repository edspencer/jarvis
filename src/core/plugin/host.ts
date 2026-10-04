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

/** Plan the start: each plugin after the ones it requires and (if present) those in `after`. Plugins caught in a
 * cycle can't be ordered: they are returned apart, with the cycle, and only they fail; the rest still start (one that
 * requires a cyclic plugin is then skipped, as for any requirement that isn't running). */
export function planStart(defs: PluginDef[]): { order: PluginDef[]; cyclic: { def: PluginDef; cycle: string[] }[] } {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const deps = (d: PluginDef) =>
    [...(d.requires || []), ...(d.after || [])].map((r) => byId.get(r)).filter((x): x is PluginDef => !!x);
  // Tarjan's strongly connected components: a component of two or more, or a plugin naming itself, is a cycle
  let n = 0;
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    stack: PluginDef[] = [],
    on = new Set<string>();
  const cyclic: { def: PluginDef; cycle: string[] }[] = [];
  const strong = (d: PluginDef) => {
    index.set(d.id, n);
    low.set(d.id, n++);
    stack.push(d);
    on.add(d.id);
    for (const e of deps(d)) {
      if (!index.has(e.id)) {
        strong(e);
        low.set(d.id, Math.min(low.get(d.id)!, low.get(e.id)!));
      } else if (on.has(e.id)) low.set(d.id, Math.min(low.get(d.id)!, index.get(e.id)!));
    }
    if (low.get(d.id) !== index.get(d.id)) return;
    const comp: PluginDef[] = [];
    let x: PluginDef;
    do {
      x = stack.pop()!;
      on.delete(x.id);
      comp.push(x);
    } while (x !== d);
    if (comp.length > 1 || deps(d).includes(d)) {
      const cycle = comp.map((c) => c.id).reverse();
      for (const c of comp) cyclic.push({ def: c, cycle });
    }
  };
  for (const d of defs) if (!index.has(d.id)) strong(d);
  const bad = new Set(cyclic.map((c) => c.def.id));
  // the rest in dependency order (ignoring the cyclic ones, which won't run)
  const out: PluginDef[] = [];
  const done = new Set<string>();
  const visit = (d: PluginDef) => {
    if (done.has(d.id) || bad.has(d.id)) return;
    done.add(d.id);
    for (const e of deps(d)) visit(e);
    out.push(d);
  };
  for (const d of defs) visit(d);
  return { order: out, cyclic };
}

/** The start order; throws if any plugins are in a cycle (see planStart for the forgiving form). */
export function startOrder(defs: PluginDef[]): PluginDef[] {
  const { order, cyclic } = planStart(defs);
  if (cyclic.length) throw new Error(`plugins: a cycle in requires/after: ${cyclic[0].cycle.join(' -> ')}`);
  return order;
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
      const { order: ordered, cyclic } = planStart(enabled);
      for (const { def, cycle } of cyclic) {
        const error = `in a cycle of requires / after: ${[...cycle, cycle[0]].join(' -> ')}`;
        recs.set(def.id, { def, state: 'failed', error, disposers: [] });
        console.error(`plugin ${def.id} off: ${error}`);
        deps.report(def, error);
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
      // registrations after the plugin was stopped (disposed while still starting) are undone at once
      const ctx = deps.context(d, (x) =>
        r.state === 'starting' || r.state === 'running' ? r.disposers.push(x) : x.dispose(),
      );
      // the plugin's own check of its section first: a problem keeps it off, as a failed setup does
      const problems = d.validate?.(ctx.config);
      if (Array.isArray(problems) && problems.length) throw new Error(`plugins.${d.id}: ${problems.join('; ')}`);
      r.instance = await d.setup(ctx);
      if (r.state !== 'starting') {
        // disposed while starting: its own dispose runs now that it exists
        try {
          r.instance?.dispose?.();
        } catch (err) {
          console.error(`plugin ${d.id}: dispose failed`, err);
        }
        return false;
      }
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
