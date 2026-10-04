// Sun & time: the dock panel that drives the core's sun (time of day, day of the year, now, animate the year), and a
// status item with the time while it isn't "now". Starts on every site (autoStart).
import { definePlugin } from '../../plugin-api';
import type { Sunlight } from '../../core/sunlight';
import { utcToLocal } from '../../core/sun';

export default definePlugin({
  id: 'sun',
  name: 'Sun & time',
  autoStart: true,
  setup(ctx) {
    const sun = ctx.services.get<Sunlight>('core.sunlight');
    if (!sun) throw new Error('no sun in this viewer');
    const tz = ctx.site.geo.timeZone;
    // "now" within a few minutes of the real clock
    const isNow = () => {
      const n = utcToLocal(Date.now(), tz);
      return n.doy === sun.sunAt.doy && n.year === sun.sunAt.year && Math.abs(n.min - sun.sunAt.min) < 10;
    };
    const report = () => sun.last ?? sun.updateSun();
    const panel = ctx.hud.addPanel({
      id: 'sun',
      title: 'Sun & time',
      icon: 'sun',
      order: 20,
      meta: () => report().local,
      render: (body) =>
        body.blocks(() => {
          const r = report();
          return [
            {
              type: 'slider',
              label: 'Time',
              min: 300,
              max: 1260,
              step: 5,
              value: sun.sunAt.min,
              valueText: r.local,
              title: `Local clock time, ${tz}`,
              onInput: (v) => {
                sun.sunAt.min = v;
                sun.updateSun();
              },
            },
            {
              type: 'slider',
              label: 'Date',
              min: 1,
              max: r.daysInYear,
              value: sun.sunAt.doy,
              valueText: r.dateLabel.split(' · ')[0],
              title: 'Day of the year: scrub through the seasons',
              onInput: (v) => {
                sun.sunAt.doy = v;
                sun.updateSun();
              },
            },
            {
              type: 'kv',
              rows: [
                ['Sun', r.timeLabel.split(' · ')[1] || ''],
                ['Day', r.dateLabel],
              ],
            },
            {
              type: 'toggle',
              label: 'Animate the year',
              title: 'Run the dates through the year at this time of day',
              value: sun.animate,
              onChange: (v) => {
                sun.animate = v;
                panel.refresh();
              },
            },
            {
              type: 'buttons',
              items: [
                {
                  label: 'Now',
                  onClick: () => {
                    sun.animate = false;
                    sun.sunNow();
                  },
                },
              ],
            },
          ];
        }),
    });
    const changed = () => {
      panel.refresh();
      ctx.hud.invalidate();
    };
    sun.onChange.add(changed);
    ctx.own(() => sun.onChange.delete(changed));
    ctx.status.addItem({
      id: 'sun.time',
      order: 150,
      render: () =>
        isNow() ? null : { icon: 'sun', text: report().local, title: `${report().timeLabel}; ${report().dateLabel}` },
      onClick: () => panel.toggle(),
    });
  },
});
