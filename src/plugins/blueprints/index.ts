// Blueprints: the site's scanned sheets laid in the plan frame (blueprints.ts). A dock panel lists the sheets (plans,
// then elevations, each with its fit error) with the model fade, "hide above" and "on floor" options; B shows the last
// sheet again or hides it; a legend names the sheet while one is up. ?bp=<sheet id> opens with a sheet, ?bpfade=20
// sets the model's opacity.
import type { BlueprintsConfig } from '../../site';
import { definePlugin, type Blocks, type PanelHandle } from '../../plugin-api';
import { createBlueprints, type BlueprintSheet } from './blueprints';

export default definePlugin<BlueprintsConfig>({
  id: 'blueprints',
  name: 'Blueprints',
  async setup(ctx) {
    const { scene, renderer, model } = ctx.three;
    const units = ctx.site.units;
    let panel: PanelHandle | undefined = undefined;
    const b = createBlueprints({
      config: ctx.config,
      scene,
      renderer,
      owners: model.owners,
      groups: model.groups,
      applyVisibility: () => ctx.view.applyVisibility(),
      onChange: () => {
        panel?.refresh();
        ctx.hud.invalidate();
      },
    });
    const sheets = await b.loadIndex();
    if (!sheets.length) return; // no index or no sheets: nothing to show
    ctx.view.addVisibilityRule(() => (b.bp.active && b.bp.hideAbove ? b.bp.hidden : []));
    ctx.events.on('model', ({ id }) => {
      if (id !== 'main') b.onModelAdded();
    });

    let busy: { done(): void } | null = null;
    const show = async (id: string | null) => {
      busy?.done();
      busy = id && !b.bp.cache[id] ? ctx.status.progress('Loading the blueprint…') : null;
      try {
        await b.showBlueprint(id);
      } catch (err) {
        ctx.toast({ text: (err as Error).message, tone: 'warn' });
      } finally {
        busy?.done();
        busy = null;
      }
    };
    const label = (s: BlueprintSheet) => `${s.title}${s.rms != null ? ` (±${s.rms} ${units})` : ''}`;

    panel = ctx.hud.addPanel({
      id: 'blueprints',
      title: 'Blueprints',
      icon: 'blueprint',
      order: 30,
      meta: () => (b.bp.active ? b.bp.active.id : `${sheets.length} sheets`),
      render: (body) =>
        body.blocks(() => {
          const a = b.bp.active;
          const row = (s: BlueprintSheet) => ({
            id: s.id,
            text: s.title,
            secondary: [
              s.id,
              s.kind === 'elevation' ? `${s.face} facade` : null,
              s.rms != null ? `fit ±${s.rms} ${units}` : null,
            ]
              .filter(Boolean)
              .join(' · '),
            icon: 'blueprint',
            selected: a?.id === s.id,
            value: a?.id === s.id ? 'shown' : '',
            run: () => show(a?.id === s.id ? null : s.id),
          });
          const plans = sheets.filter((s) => s.kind === 'plan');
          const elev = sheets.filter((s) => s.kind !== 'plan');
          const out: Blocks = [
            a
              ? {
                  type: 'callout',
                  tone: 'info',
                  text: `Showing ${label(a)}`,
                  action: { label: 'Hide (B)', run: () => show(null) },
                }
              : {
                  type: 'text',
                  text: { text: 'Pick a sheet to lay it in the model; B shows the last one again.', muted: true },
                },
            a && {
              type: 'slider',
              label: 'Model',
              min: 0,
              max: 100,
              step: 5,
              value: Math.round(b.bp.fade * 100),
              valueText: `${Math.round(b.bp.fade * 100)} %`,
              title: 'Opacity of the model while a blueprint is shown',
              onInput: (v) => b.setBlueprintFade(v / 100),
            },
            a?.kind === 'plan' && {
              type: 'toggle',
              label: 'Hide above the sheet',
              title: "Hide everything above the sheet's floor (higher storeys, ceilings, roofs)",
              value: b.bp.hideAbove,
              onChange: (v) => b.setHideAbove(v),
            },
            a &&
              b.floorOption(a) && {
                type: 'toggle',
                label: 'Lay it on its floor',
                title: "Put a ceiling / roof plan on its storey's floor instead of at its ceiling",
                value: b.bp.onFloor,
                onChange: (v) => b.setOnFloor(v),
              },
            plans.length > 0 && {
              type: 'group',
              id: 'blueprints.plans',
              title: 'Plans',
              count: plans.length,
              blocks: [{ type: 'list', rows: plans.map(row) }],
            },
            elev.length > 0 && {
              type: 'group',
              id: 'blueprints.elev',
              title: 'Elevations',
              count: elev.length,
              blocks: [{ type: 'list', rows: elev.map(row) }],
            },
          ];
          return out;
        }),
    });

    ctx.keys.add({
      code: 'KeyB',
      label:
        'Blueprint overlay: show / hide the last sheet chosen (plans lie at their floor, elevations stand on their facade)',
      run: () => {
        const next = b.bp.active
          ? null
          : b.bp.last || (sheets.find((x) => x.id === ctx.config.default) || sheets[0])?.id || null;
        show(next);
      },
    });
    ctx.hud.addLegend({
      id: 'blueprints',
      title: 'Blueprint',
      hint: 'B hides it',
      when: () => !!b.bp.active,
      items: () => {
        const a = b.bp.active!;
        return [
          { label: a.title, colour: '#7cc4ff' },
          ...(a.rms != null ? [{ label: `fit ±${a.rms} ${units}`, tone: 'off' as const }] : []),
        ];
      },
    });
    ctx.search.add({
      id: 'blueprints',
      label: 'Blueprint sheets',
      order: 60,
      search: (q) =>
        sheets
          .filter((s) => `${s.id} ${s.title}`.toLowerCase().includes(q))
          .map((s) => ({ text: s.title, secondary: s.id, icon: 'blueprint', run: () => (panel?.open(), show(s.id)) })),
    });
    ctx.expose('bp', b.bp);
    ctx.expose('blueprints', b);
    ctx.expose('showBlueprint', show); // the prototype's console names
    ctx.expose('setBlueprintFade', b.setBlueprintFade);
    if (ctx.url.get('bpfade')) b.setBlueprintFade(ctx.url.num('bpfade', 20) / 100);
    if (ctx.url.get('bp')) show(ctx.url.get('bp'));
    return {
      dispose: () => {
        if (b.bp.active) void b.showBlueprint(null);
      },
    };
  },
});
