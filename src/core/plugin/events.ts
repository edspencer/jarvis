// The event bus: frame, select, mode, visibility, model, pointerlock, and plugins' own '<id>:<name>' events. A handler
// that throws is reported once and keeps running for the next event (one plugin's bug never stops the frame loop).
import type { Disposable, EventBus } from './types';

type Fn = (e: unknown) => void;

export interface Bus extends EventBus {
  /** a view of the bus whose handlers are wrapped and collected under an owner (a plugin) */
  scoped(owner: string, collect: (d: Disposable) => void, onError: (err: unknown) => void): EventBus;
  /** handlers registered for an event */
  count(name: string): number;
}

export function createBus(): Bus {
  const handlers = new Map<string, Set<Fn>>();

  function on(name: string, fn: Fn): Disposable {
    let set = handlers.get(name);
    if (!set) handlers.set(name, (set = new Set()));
    set.add(fn);
    return { dispose: () => void handlers.get(name)?.delete(fn) };
  }

  function emit(name: string, e?: unknown): void {
    const set = handlers.get(name);
    if (!set) return;
    for (const fn of [...set]) fn(e);
  }

  function scoped(owner: string, collect: (d: Disposable) => void, onError: (err: unknown) => void): EventBus {
    return {
      on(name: string, fn: Fn) {
        let failed = false;
        const d = on(name, (e) => {
          try {
            fn(e);
          } catch (err) {
            if (!failed) {
              failed = true; // once per handler: a broken frame handler would otherwise flood the console
              console.error(`plugin ${owner}: ${name} handler failed`, err);
              onError(err);
            }
          }
        });
        collect(d);
        return d;
      },
      emit,
    } as EventBus;
  }

  return {
    on: on as EventBus['on'],
    emit: emit as EventBus['emit'],
    scoped,
    count: (name) => handlers.get(name)?.size ?? 0,
  };
}
