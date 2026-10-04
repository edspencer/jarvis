// Wall plates: the model's switch and outlet plates (switches.ts draws them instanced and highlights them), with the
// L chip (Shift-L through walls; switches or outlets only in its menu), a legend, the Wall plate section (positions,
// breakers, the fixtures each one switches, box-to-box links) and plates in global search. Subjects: 'plates:<plate
// id>'. Starts on any site whose model has plates (autoStart); ?plates highlights them, ?plateswall through walls,
// ?plates=switch|outlet filters, ?plate=<box id> flies to one.
//
// A position that names an ha_entity shows it (and the Home Assistant section shows its state); switching it from a
// plate is offered only with mock data (?ha=mock): plate identities are still being confirmed, so live Home Assistant
// is never switched from a plate.
import { human } from '../../core/text';
import type { SwitchesConfig } from '../../site';
import { definePlugin, type Blocks, type InlineSpan, type LinkItem, type Subject } from '../../core/plugin/types';
import type { Pins } from '../pins/pins';
import { createSwitches, type Plate, type PlatePosition } from './switches';

export default definePlugin<SwitchesConfig>({
  id: 'switches',
  name: 'Wall plates',
  autoStart: true,
  after: ['pins', 'home-assistant'],
  setup(ctx) {
    const { scene, camera, model } = ctx.three;
    if (!model.switchRoot) return; // no plates in this model
    const sw = createSwitches({
      config: ctx.config,
      site: ctx.site,
      root: model.root,
      scene,
      camera,
      fixtures: model.fixtures,
      fly: (t, c) => ctx.view.fly(t, c),
      getPins: () => ctx.services.get<Pins>('pins') ?? null,
      onChange: () => ctx.hud.invalidate(),
    });
    sw.adopt(model.switchRoot);
    const kindOf = sw.kindOf;
    const plateOf = (s: Subject | null): Plate | null =>
      s?.kind === 'item' && s.id.startsWith('plates:') ? sw.byId[s.id.slice(7)] || null : null;
    const title = (p: Plate) => p.box || 'unknown plate';

    for (const p of sw.plates) {
      const ents = (p.d.positions || []).map((x) => x.ha_entity).filter((e): e is string => !!e);
      if (ents.length)
        ctx.store.bind({ ref: `plates:${p.id}`, entities: ents, conf: p.d.id_conf, src: 'wall plate sheet' });
    }

    // mock data: a state for each plate's light (the mock only makes up the fixture map's), so its toggle works
    if (ctx.store.mock()) {
      const now = new Date().toISOString();
      const missing = [...new Set(sw.plates.flatMap((p) => (p.d.positions || []).map((x) => x.ha_entity)))].filter(
        (e): e is string => !!e && e.startsWith('light.') && !ctx.store.get(e),
      );
      if (missing.length)
        ctx.store.simulate(missing.map((e) => ({ entity_id: e, state: 'off', attributes: {}, last_changed: now })));
    }

    ctx.inspector.registerSubject('plates', {
      describe: (id) => {
        const p = sw.byId[id];
        return p
          ? {
              title: title(p),
              type: [`${kindOf(p) === 'outlet' ? 'Outlet' : 'Switch'} plate`, human(p.d.room)]
                .filter(Boolean)
                .join(' · '),
              icon: 'plate',
              crumbs: [human(p.d.room), 'wall plates'],
            }
          : null;
      },
      fly: (id) => void sw.go(id),
    });
    ctx.pick.addResolver((pr) => {
      const p = sw.plateOf(pr.hit);
      return p ? { kind: 'item', id: `plates:${p.id}`, hit: pr.hit } : null;
    });
    ctx.events.on('select', ({ subject }) => {
      const p = plateOf(subject);
      if (p !== sw.selected) sw.select(p);
    });
    ctx.events.on('frame', ({ dt }) => sw.update(dt));

    // ------------------------------------------------------------------ the chip and the legend
    ctx.status.addToggle({
      id: 'plates',
      label: 'Plates',
      title: 'Highlight the switch and outlet plates',
      order: 42,
      key: { code: 'KeyL', label: 'Wall plates: highlight the switch and outlet plates; click one to inspect it' },
      get: () => sw.on,
      set: (v) => sw.setOn(v),
      text: () =>
        `Plates${sw.kind === 'switch' ? ' · switches' : sw.kind === 'outlet' ? ' · outlets' : ''}${sw.wall ? ' · walls' : ''}`,
      variants: [
        {
          label: 'Through walls',
          key: { code: 'KeyL', shift: true, label: 'Wall plates through walls' },
          get: () => sw.on && sw.wall,
          set: (v) => sw.setWall(v),
        },
        {
          label: 'Switches only',
          get: () => sw.kind === 'switch',
          set: (v) => (sw.setKind(v ? 'switch' : 'both'), sw.setOn(true)),
        },
        {
          label: 'Outlets only',
          get: () => sw.kind === 'outlet',
          set: (v) => (sw.setKind(v ? 'outlet' : 'both'), sw.setOn(true)),
        },
      ],
    });
    ctx.hud.addLegend({
      id: 'plates',
      title: 'Wall plates',
      hint: 'L · Shift-L walls',
      when: () => sw.on,
      items: () => [
        ...(sw.kind !== 'outlet' ? [{ label: 'switch box', colour: '#ffb43c' }] : []),
        ...(sw.kind !== 'switch' ? [{ label: 'outlet box', colour: '#4fd3ff' }] : []),
        { label: 'unknown plate', colour: '#e055ff' },
      ],
    });

    // ------------------------------------------------------------------ the Wall plate section
    const boxLink = (box: string, label = box): LinkItem => {
      const p = sw.byBox[box];
      return p
        ? { text: label, icon: 'plate', subject: `plates:${p.id}` }
        : { text: `${label} (not located)`, icon: 'plate' };
    };
    /** a note with each box id in it as a link, as inline text plus the links found */
    const refsIn = (t: string): { text: InlineSpan[]; links: LinkItem[] } => {
      const text: InlineSpan[] = [];
      const links: LinkItem[] = [];
      for (const part of sw.splitRefs(t)) {
        if ('text' in part) text.push({ text: part.text });
        else {
          text.push({
            text: part.all,
            tone: sw.byBox[part.box] ? 'info' : undefined,
            title: sw.byBox[part.box] ? 'a plate: see the links' : 'not located',
          });
          if (!links.some((l) => typeof l === 'object' && 'text' in l && l.text.startsWith(part.box)))
            links.push(boxLink(part.box));
        }
      }
      return { text, links };
    };
    const fixtureLinks = (fids: string[]): LinkItem[] => {
      const known = fids.filter((f) => model.fixtures[f]);
      const out: LinkItem[] = fids.map((f) =>
        model.fixtures[f] ? `fixture:${f}` : { text: `${f} (not in the model)`, icon: 'bulb' },
      );
      if (known.length > 1) out.push({ text: `all ${known.length}`, icon: 'bulb', run: () => sw.markFixtures(known) });
      return out;
    };
    const position = (p: Plate, ps: PlatePosition): Blocks => {
      const role = ps.role ? refsIn(ps.role) : { text: [{ text: 'role unknown', muted: true }], links: [] };
      // a plate whose notes say it is this position; an outlet first when the role speaks of an outlet / duplex
      const named = (p.box && sw.mentions[`${p.box}#${ps.pos}`]) || [];
      const wantOutlet = /outlet|duplex|receptacle/i.test(ps.role || '');
      const rank = (x: Plate) => ((kindOf(x) === 'outlet') === wantOutlet ? 0 : 1);
      const mock = ctx.store.mock();
      const st = ps.ha_entity ? ctx.store.get(ps.ha_entity) : undefined;
      return [
        {
          type: 'kv',
          rows: [
            [`#${ps.pos}`, role.text],
            ps.breaker ? ['Breaker', ps.breaker] : null,
            ps.ha_group ? ['HA group', ps.ha_group] : null,
            ps.ha_entity
              ? ['HA', [{ text: ps.ha_entity, mono: true }, ...(st ? [{ text: st.state, muted: true }] : [])]]
              : null,
          ],
        },
        (role.links.length > 0 || named.length > 0) && {
          type: 'links',
          items: [...role.links, ...[...named].sort((x, y) => rank(x) - rank(y)).map((o) => `plates:${o.id}`)],
        },
        ps.fixture_ids?.length && { type: 'links', title: 'Fixtures', items: fixtureLinks(ps.fixture_ids) },
        ps.link?.box && {
          type: 'links',
          items: [
            boxLink(
              ps.link.box,
              `${ps.link.dir === 'from' ? 'From' : ps.link.dir === 'with' ? 'With' : 'To'} ${ps.link.box}${ps.link.pos ? `#${ps.link.pos}` : ''}`,
            ),
          ],
        },
        ps.ha_entity &&
          mock &&
          ps.ha_entity.startsWith('light.') && {
            type: 'buttons',
            items: [
              {
                label: 'Toggle (mock)',
                title: 'Mock data only: live Home Assistant is never switched from a plate',
                onClick: () =>
                  ctx.store
                    .call(ps.ha_entity!, 'toggle')
                    .catch((err) => ctx.toast({ text: `${ps.ha_entity}: ${(err as Error).message}`, tone: 'bad' })),
              },
            ],
          },
      ];
    };
    ctx.inspector.addSection({
      id: 'switches',
      title: 'Wall plate',
      icon: 'plate',
      order: 10,
      for: (s) => {
        const p = plateOf(s);
        if (!p) return null;
        const d = p.d;
        const notes = d.notes ? refsIn(d.notes) : null;
        const back = sw.plates.filter(
          (o) => o !== p && p.box && (o.d.positions || []).some((ps) => ps.link?.box === p.box),
        );
        const named = ((p.box && sw.mentions[p.box]) || []).filter((o) => !back.includes(o));
        const out: Blocks = [
          {
            type: 'kv',
            rows: [
              ['Kind', kindOf(p)],
              ['Room', human(d.room)],
              [
                'Plate',
                [
                  `${d.gangs}-gang ${d.style || 'decora'}${d.colour && d.colour !== 'white' ? `, ${d.colour}` : ''}${d.mount && d.mount !== 'wall' ? `, on ${d.mount}` : ''}`,
                  ...(d.devices?.length ? [{ text: `(${d.devices.join(', ')})`, muted: true }] : []),
                ],
              ],
              [
                'Confidence',
                [
                  { text: `position ${d.conf || '?'}`, pill: d.conf === 'high' ? 'ok' : 'warn' },
                  { text: `identity ${d.id_conf || '?'}`, pill: d.id_conf === 'high' ? 'ok' : 'warn' },
                ],
              ],
              d.wall ? ['Wall', { text: d.wall, mono: true }] : null,
            ],
          },
          notes && { type: 'note', label: 'Notes', text: d.notes! },
          notes && notes.links.length > 0 && { type: 'links', items: notes.links },
          d.gangs_note && { type: 'note', label: 'Gangs', text: d.gangs_note },
          { type: 'label', text: 'Positions' },
        ];
        if (!d.positions?.length) out.push({ type: 'text', text: { text: 'none accounted for', muted: true } });
        for (const ps of d.positions || []) out.push(...position(p, ps));
        if (back.length) out.push({ type: 'links', title: 'Linked from', items: back.map((o) => `plates:${o.id}`) });
        if (named.length) out.push({ type: 'links', title: 'Named in', items: named.map((o) => `plates:${o.id}`) });
        if (d.file && ctx.config.source)
          out.push({
            type: 'kv',
            rows: [['Source', { text: ctx.config.source.replace('{file}', d.file), mono: true }]],
          });
        return { blocks: out };
      },
    });

    ctx.search.add({
      id: 'plates',
      label: 'Wall plates',
      order: 30,
      search: (q) =>
        sw.plates
          .filter((p) => `${p.box || ''} ${p.d.room || ''} ${kindOf(p)}`.toLowerCase().replace(/_/g, ' ').includes(q))
          .slice(0, 8)
          .map((p) => ({
            text: title(p),
            secondary: `${kindOf(p)} · ${human(p.d.room)}`,
            icon: 'plate',
            subject: `plates:${p.id}`,
          })),
    });

    ctx.services.provide('switches', sw);
    ctx.expose('switches', sw);
    const q = ctx.url.get('plate');
    if (q) {
      const p = sw.byBox[q] || sw.byId[q];
      if (p) ctx.inspector.open(`plates:${p.id}`, { fly: true });
    }
    return { dispose: () => sw.dispose() };
  },
});
