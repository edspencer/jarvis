import { describe, expect, it, vi } from 'vitest';
import { createPluginHost, startOrder } from '../../src/core/plugin/host';
import type { Disposable, PluginContext, PluginDef } from '../../src/core/plugin/types';

/** a host whose context is just the `own` collector, with every plugin enabled unless listed in `off` */
function makeHost(off: string[] = []) {
  const reports: string[] = [];
  const host = createPluginHost({
    enabled: (id) => !off.includes(id),
    context: (def, own) =>
      ({
        id: def.id,
        own: (d: Disposable | (() => void)) => own(typeof d === 'function' ? { dispose: d } : d),
      }) as unknown as PluginContext,
    report: (def, m) => reports.push(`${def.id}: ${m}`),
  });
  return { host, reports };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('startOrder', () => {
  const def = (id: string, requires: string[] = [], after: string[] = []): PluginDef => ({
    id,
    name: id,
    requires,
    after,
    setup() {},
  });

  it('puts each plugin after the ones it requires and those it starts after', () => {
    const order = startOrder([
      def('faults', [], ['ha', 'pins']),
      def('lights', ['store']),
      def('pins'),
      def('ha'),
      def('store'),
    ]).map((d) => d.id);
    expect(order.indexOf('faults')).toBeGreaterThan(order.indexOf('ha'));
    expect(order.indexOf('faults')).toBeGreaterThan(order.indexOf('pins'));
    expect(order.indexOf('lights')).toBeGreaterThan(order.indexOf('store'));
  });

  it('ignores an `after` that is not present', () => {
    expect(startOrder([def('a', [], ['missing'])]).map((d) => d.id)).toEqual(['a']);
  });

  it('throws on a cycle', () => {
    expect(() => startOrder([def('a', ['b']), def('b', ['a'])])).toThrow(/cycle/);
  });
});

describe('the plugin host', () => {
  it('starts a plugin only if the site enables it, or it is autoStart', async () => {
    const { host } = makeHost(['pins', 'sun']);
    const ran: string[] = [];
    await host.start([
      { id: 'pins', name: 'Pins', setup: () => void ran.push('pins') },
      { id: 'sun', name: 'Sun', autoStart: true, setup: () => void ran.push('sun') },
      { id: 'faults', name: 'Faults', setup: () => void ran.push('faults') },
    ]);
    expect(ran.sort()).toEqual(['faults', 'sun']);
    expect(host.running('pins')).toBe(false);
  });

  it('waits for what a plugin requires (async setups) before starting it', async () => {
    const { host } = makeHost();
    const log: string[] = [];
    await host.start([
      { id: 'lights', name: 'Lights', requires: ['ha'], setup: () => void log.push('lights') },
      {
        id: 'ha',
        name: 'HA',
        async setup() {
          await tick();
          log.push('ha');
        },
      },
    ]);
    expect(log).toEqual(['ha', 'lights']);
    expect(host.order).toEqual(['ha', 'lights']);
  });

  it('isolates a failure: the plugin is disposed and reported, the others still start, dependants are skipped', async () => {
    const { host, reports } = makeHost();
    const disposed = vi.fn();
    const ran: string[] = [];
    await host.start([
      {
        id: 'broken',
        name: 'Broken',
        setup(ctx) {
          ctx.own(disposed); // registered before the throw: must still be cleaned up
          throw new Error('no data file');
        },
      },
      { id: 'needsBroken', name: 'Needs', requires: ['broken'], setup: () => void ran.push('needsBroken') },
      { id: 'fine', name: 'Fine', setup: () => void ran.push('fine') },
    ]);
    expect(ran).toEqual(['fine']);
    expect(disposed).toHaveBeenCalledOnce();
    expect(host.records().find((r) => r.def.id === 'broken')!.state).toBe('failed');
    expect(host.records().find((r) => r.def.id === 'needsBroken')!.state).toBe('skipped');
    expect(reports).toEqual(['broken: no data file', "needsBroken: needs broken, which isn't running"]);
  });

  it('skips a plugin whose requirement is not enabled', async () => {
    const { host, reports } = makeHost(['ha']);
    await host.start([
      { id: 'ha', name: 'HA', setup() {} },
      { id: 'lights', name: 'Lights', requires: ['ha'], setup() {} },
    ]);
    expect(host.running('lights')).toBe(false);
    expect(reports[0]).toMatch(/^lights: needs ha/);
  });

  it('a rejected async setup counts as a failure', async () => {
    const { host, reports } = makeHost();
    await host.start([{ id: 'a', name: 'A', setup: async () => Promise.reject(new Error('HTTP 404')) }]);
    expect(host.running('a')).toBe(false);
    expect(reports).toEqual(['a: HTTP 404']);
  });

  it('dispose runs the instance dispose and every registration, newest first, and stops dependants too', async () => {
    const { host } = makeHost();
    const log: string[] = [];
    await host.start([
      {
        id: 'base',
        name: 'Base',
        setup(ctx) {
          ctx.own(() => log.push('first'));
          ctx.own(() => log.push('second'));
          return { dispose: () => log.push('instance') };
        },
      },
      { id: 'dep', name: 'Dep', requires: ['base'], setup: (ctx) => ctx.own(() => log.push('dep')) },
    ]);
    host.dispose('base');
    expect(log).toEqual(['dep', 'instance', 'second', 'first']);
    expect(host.running('base')).toBe(false);
    expect(host.running('dep')).toBe(false);
    host.dispose('base'); // twice is harmless
    expect(log).toHaveLength(4);
  });
});
