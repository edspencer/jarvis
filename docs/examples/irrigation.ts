import { definePlugin } from 'jarvis/plugin';

interface Zone {
  id: string;
  name: string;
  valve: string;
  at: [number, number, number];
}

export default definePlugin<{ zones: string }>({
  id: 'irrigation',
  name: 'Irrigation',
  after: ['home-assistant'],
  async setup(ctx) {
    const { zones } = await ctx.load<{ zones: Zone[] }>(ctx.config.zones); // a missing file: the plugin is just off
    const byId = Object.fromEntries(zones.map((z) => [z.id, z]));
    const running = (z: Zone) => ctx.store.get(z.valve)?.state === 'on';
    for (const z of zones) ctx.store.bind({ ref: `irrigation:${z.id}`, entities: [z.valve] }); // the HA section shows it

    ctx.inspector.registerSubject('irrigation', {
      describe: (id) => (byId[id] ? { title: byId[id].name, type: 'Irrigation zone', icon: 'pin' } : null),
      fly: (id) => ctx.view.fly(ctx.three.P(...byId[id].at), null),
    });
    const panel = ctx.hud.addPanel({
      id: 'irrigation',
      title: 'Irrigation',
      icon: 'pin',
      order: 60,
      key: { code: 'KeyI', shift: true, label: 'Irrigation panel' },
      badge: () => zones.filter(running).length || null,
      render: (body) =>
        body.blocks(() => [
          {
            type: 'list',
            rows: zones.map((z) => ({
              id: z.id,
              text: z.name,
              secondary: ctx.store.get(z.valve)?.state ?? 'no state',
              dot: running(z) ? 'ok' : 'off',
              subject: `irrigation:${z.id}`,
            })),
          },
        ]),
    });
    ctx.store.onChange(
      () => (panel.refresh(), ctx.inspector.refresh()),
      zones.map((z) => z.valve),
    );

    ctx.inspector.addSection({
      id: 'irrigation',
      title: 'Zone',
      icon: 'pin',
      order: 10,
      for: (s) => {
        const z = s.kind === 'item' && s.id.startsWith('irrigation:') ? byId[s.id.slice(11)] : null;
        if (!z) return null;
        // ask for exactly what will be called: the connector's allow-list decides per action
        const action = running(z) ? 'turn_off' : 'turn_on';
        const why = ctx.store.refusal(z.valve, action);
        return {
          blocks: [
            { type: 'status', tone: running(z) ? 'ok' : 'off', text: running(z) ? 'Watering' : 'Off' },
            why ? { type: 'text', text: { text: `Can't switch: ${why}`, muted: true } } : null,
          ],
          actions: why
            ? []
            : [
                {
                  label: running(z) ? 'Stop' : 'Run',
                  kind: 'primary',
                  confirm: running(z) ? undefined : `Water ${z.name} now?`,
                  onClick: () =>
                    ctx.store
                      .call(z.valve, action)
                      .catch((e: Error) => ctx.toast({ text: `${z.name}: ${e.message}`, tone: 'bad' })),
                },
              ],
        };
      },
    });
    ctx.search.add({
      id: 'irrigation',
      label: 'Irrigation zones',
      search: (q) =>
        zones
          .filter((z) => z.name.toLowerCase().includes(q))
          .map((z) => ({ text: z.name, icon: 'pin', subject: `irrigation:${z.id}` })),
    });
  },
});
