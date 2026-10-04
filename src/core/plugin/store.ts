// The entity store: devices' entities and their live states from every connector (Home Assistant today), the site's
// bindings of model objects and plugin items to entities, and the one way to act on an entity: call(), routed to the
// connector that owns it, which applies its own allow-list. Feature plugins read the store and never know which
// connector an entity came from. Pure (no DOM, no three.js): unit-tested.
import type {
  Binding,
  BindingInput,
  ConnectorHandle,
  ConnectorInfo,
  ConnectorSpec,
  ConnectorStatus,
  Disposable,
  Entities,
  EntityState,
  Store,
  StoreAction,
  StoreChange,
} from './types';

const HISTORY = 360;

interface Conn {
  spec: ConnectorSpec;
  info: ConnectorInfo;
  /** the entity ids it supplied */
  ids: Set<string>;
}

export function createStore(): Store & { scoped(owner: string, collect: (d: Disposable) => void): Store } {
  let ents: Entities = {};
  const owner = new Map<string, string>(); // entity id -> connector id
  const conns = new Map<string, Conn>();
  const listeners = new Set<{ fn: (c: StoreChange) => void; filter?: string[] | ((id: string) => boolean) }>();
  const connListeners = new Set<() => void>();
  const bindListeners = new Set<() => void>();
  const bindings = new Map<string, Binding[]>(); // ref -> bindings
  const byEntity = new Map<string, Set<string>>(); // entity -> refs
  const hist = new Map<string, { t: number; v: number }[]>();

  function record(e: EntityState): void {
    const v = Number(e.state);
    if (e.state === '' || !Number.isFinite(v)) return;
    let h = hist.get(e.entity_id);
    if (!h) hist.set(e.entity_id, (h = []));
    const t = Date.parse(e.last_updated || e.last_changed || '') || Date.now();
    if (h.length && h[h.length - 1].t === t) h[h.length - 1].v = v;
    else h.push({ t, v });
    if (h.length > HISTORY) h.splice(0, h.length - HISTORY);
  }

  function commit(next: Entities, changed: string[]): void {
    if (!changed.length) return;
    const previous = ents;
    ents = next;
    for (const id of changed) if (next[id]) record(next[id]);
    const c: StoreChange = { changed, entities: next, previous };
    for (const l of [...listeners]) {
      const f = l.filter;
      if (f && !(typeof f === 'function' ? changed.some(f) : changed.some((id) => f.includes(id)))) continue;
      try {
        l.fn(c);
      } catch (err) {
        console.error('store: a change listener failed', err);
      }
    }
  }

  function notifyConnectors(): void {
    for (const fn of [...connListeners]) fn();
  }

  function addConnector(spec: ConnectorSpec): ConnectorHandle {
    if (conns.has(spec.id)) throw new Error(`store: connector ${spec.id} is already registered`);
    const c: Conn = {
      spec,
      info: { id: spec.id, name: spec.name, status: 'disconnected', detail: '' },
      ids: new Set(),
    };
    conns.set(spec.id, c);
    notifyConnectors();
    const take = (id: string) => {
      const o = owner.get(id);
      if (o && o !== spec.id) return false; // another connector's entity: first come keeps it
      owner.set(id, spec.id);
      c.ids.add(id);
      return true;
    };
    let gone = false;
    const handle: ConnectorHandle = {
      replace(all: Entities) {
        if (gone) return;
        const next: Entities = { ...ents };
        const changed: string[] = [];
        for (const id of c.ids)
          if (!all[id]) {
            delete next[id];
            owner.delete(id);
            changed.push(id);
          }
        c.ids = new Set([...c.ids].filter((id) => all[id]));
        for (const [id, e] of Object.entries(all)) {
          if (!take(id)) continue;
          if (next[id] !== e) {
            next[id] = e;
            changed.push(id);
          }
        }
        commit(next, changed);
      },
      update(states: EntityState[]) {
        if (gone) return;
        const next: Entities = { ...ents };
        const changed: string[] = [];
        for (const e of states) {
          if (!take(e.entity_id) || next[e.entity_id] === e) continue;
          next[e.entity_id] = e;
          changed.push(e.entity_id);
        }
        commit(next, changed);
      },
      status(s: ConnectorStatus, detail = '') {
        if (gone) return;
        if (c.info.status === s && c.info.detail === detail) return;
        c.info = { ...c.info, status: s, detail };
        notifyConnectors();
      },
      dispose() {
        handle.replace({});
        gone = true; // a late update from a closing connection is ignored
        conns.delete(spec.id);
        notifyConnectors();
      },
    };
    return handle;
  }

  /** entity ids grouped by their connector; unknown ones under '' */
  function split(ids: string[]): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const id of ids) {
      const o = owner.get(id) ?? '';
      if (!m.has(o)) m.set(o, []);
      m.get(o)!.push(id);
    }
    return m;
  }
  const list = (ids: string | string[]) => [...new Set(([] as string[]).concat(ids))];

  function refusal(ids: string | string[], action: StoreAction): string | null {
    const all = list(ids);
    if (!all.length) return 'no entity';
    for (const [o, part] of split(all)) {
      const c = conns.get(o);
      if (!c) return `${part.join(', ')}: no connector has ${part.length > 1 ? 'these' : 'this'}`;
      const r = c.spec.refusal?.(part, action);
      if (r) return r;
    }
    return null;
  }

  async function call(ids: string | string[], action: StoreAction, data?: Record<string, unknown>): Promise<void> {
    const all = list(ids);
    if (!all.length) throw new Error('no entity to call');
    const parts = split(all);
    const unknown = parts.get('');
    if (unknown) throw new Error(`${unknown.join(', ')}: no connector has ${unknown.length > 1 ? 'these' : 'this'}`);
    for (const [o, part] of parts) await conns.get(o)!.spec.call(part, action, data);
  }

  // ------------------------------------------------------------------ bindings
  function reindex(): void {
    byEntity.clear();
    for (const [ref, bs] of bindings)
      for (const b of bs)
        for (const e of b.entities) {
          if (!byEntity.has(e)) byEntity.set(e, new Set());
          byEntity.get(e)!.add(ref);
        }
  }
  let bindQueued = false;
  function bindChanged(): void {
    reindex();
    if (bindQueued) return;
    bindQueued = true;
    queueMicrotask(() => {
      bindQueued = false;
      for (const fn of [...bindListeners]) fn();
    });
  }
  function bind(b: BindingInput): Disposable {
    const full = { ...b, source: b.source ?? 'site', entities: [...new Set(b.entities)] } as Binding;
    if (!bindings.has(full.ref)) bindings.set(full.ref, []);
    bindings.get(full.ref)!.push(full);
    bindChanged();
    return {
      dispose() {
        const bs = bindings.get(full.ref);
        const i = bs?.indexOf(full) ?? -1;
        if (i >= 0) bs!.splice(i, 1);
        if (bs && !bs.length) bindings.delete(full.ref);
        bindChanged();
      },
    };
  }
  function bindingsOf(ref: string): Binding[] {
    const bs = bindings.get(ref) || [];
    // a mock binding stands in only where nothing real names an entity (a map entry with none yet still shows)
    const real = bs.filter((b) => b.conf !== 'mock' && b.entities.length);
    if (real.length) return real;
    const mock = bs.filter((b) => b.conf === 'mock');
    return mock.length ? mock : bs;
  }
  const entitiesOf = (ref: string) => [...new Set(bindingsOf(ref).flatMap((b) => b.entities))];

  const store = {
    get: (id: string) => ents[id],
    entities: () => ents,
    onChange(fn: (c: StoreChange) => void, filter?: string[] | ((id: string) => boolean)): Disposable {
      const l = { fn, filter };
      listeners.add(l);
      return { dispose: () => void listeners.delete(l) };
    },
    call,
    refusal,
    sourceOf: (id: string) => owner.get(id),
    history: (id: string) => hist.get(id) || [],
    addConnector,
    connectors: () => [...conns.values()].map((c) => c.info),
    live: () => [...conns.values()].some((c) => c.info.status === 'live' || c.info.status === 'mock'),
    mock: () => [...conns.values()].some((c) => c.info.status === 'mock'),
    simulate(states: EntityState[]) {
      for (const c of conns.values()) if (c.info.status === 'mock') c.spec.simulate?.(states);
    },
    onConnectors(fn: () => void): Disposable {
      connListeners.add(fn);
      return { dispose: () => void connListeners.delete(fn) };
    },
    bind,
    bindingsOf,
    entitiesOf,
    refsOf: (e: string) => [...(byEntity.get(e) || [])],
    onBindings(fn: () => void): Disposable {
      bindListeners.add(fn);
      return { dispose: () => void bindListeners.delete(fn) };
    },
  };

  /** the same store, with every registration a plugin makes collected for its disposal */
  function scoped(by: string, collect: (d: Disposable) => void): Store {
    const keep = <T extends Disposable>(d: T): T => (collect(d), d);
    return {
      ...store,
      onChange: (fn, filter) => keep(store.onChange(fn, filter)),
      onConnectors: (fn) => keep(store.onConnectors(fn)),
      onBindings: (fn) => keep(store.onBindings(fn)),
      addConnector: (c) => keep(store.addConnector(c)),
      bind: (b) => keep(store.bind({ source: by, ...b })),
    };
  }

  return { ...store, scoped };
}
