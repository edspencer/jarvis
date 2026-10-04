// Equipment pins: the equipment registry drawn as category pins (pins.ts), with the P chip (Shift-P through walls),
// the Equipment panel (search, category chips, the pins grouped by room), the Equipment section on a registry item
// (and a link to it from a light fixture that is one), and the registry in global search. Subjects: 'pins:<id>'.
// ?pins shows them, ?pinswall through walls, ?pin=<id> flies to one and opens it.
import { human } from '../../core/text';
import type { PinsConfig } from '../../site';
import {
  definePlugin,
  type Block,
  type Blocks,
  type Glyph,
  type LinkItem,
  type PanelHandle,
  type Subject,
} from '../../plugin-api';
import { createPins, type PinItem } from './pins';

export default definePlugin<PinsConfig>({
  id: 'pins',
  name: 'Equipment pins',
  async setup(ctx) {
    const { scene, camera, renderer, model } = ctx.three;
    const pins = createPins({
      config: ctx.config,
      site: ctx.site,
      scene,
      camera,
      renderer,
      fixtures: model.fixtures,
      state: ctx.view.state as never,
      seen: (p) => ctx.view.seen(p),
      fly: (t, c) => ctx.view.fly(t, c),
      onChange: () => {
        late.panel?.refresh();
        ctx.hud.invalidate();
      },
    });
    const late: { panel?: PanelHandle } = {}; // the panel, once it exists
    await pins.load();
    const { CATS } = pins;
    const glyphOf = (it: Pick<PinItem, 'category' | 'approx'>): Glyph => ({
      letter: CATS[it.category]?.l || '?',
      colour: CATS[it.category]?.c || '#cccccc',
      hollow: !!it.approx,
    });
    const idOf = (s: Subject | null) => (s?.kind === 'item' && s.id.startsWith('pins:') ? s.id.slice(5) : null);

    // bindings: a registry item's Home Assistant entities (the HA section shows them)
    for (const it of pins.items)
      if (it.ha?.entities?.length) ctx.store.bind({ ref: `pins:${it.id}`, entities: it.ha.entities });

    ctx.inspector.registerSubject('pins', {
      describe: (id) => {
        const it = pins.byId[id];
        if (!it) {
          const u = pins.unplaced[id];
          return u ? { title: u.name, type: 'Not placed in the registry yet', icon: 'pin' } : null;
        }
        return {
          title: it.name,
          type: [CATS[it.category]?.name || it.category, it.status, human(it.room)].filter(Boolean).join(' · '),
          glyph: glyphOf(it),
          crumbs: [human(it.room), (CATS[it.category]?.name || it.category).toLowerCase()],
        };
      },
      fly: (id) => void pins.go(id),
    });
    ctx.events.on('select', ({ subject }) => {
      const id = idOf(subject);
      if (id !== pins.selected) pins.select(id && pins.byId[id] ? id : null);
    });
    ctx.events.on('visibility', () => pins.refresh()); // pins upstairs go with U
    ctx.events.on('frame', ({ dt }) => pins.update(dt));
    ctx.pick.addScreenPicker({
      id: 'pins',
      order: 20,
      at: (ndc) => {
        const it = pins.at(ndc);
        return it ? { kind: 'item', id: `pins:${it.id}` } : null;
      },
    });
    ctx.hover.add({
      id: 'pins',
      label: (s) => {
        const it = pins.byId[idOf(s) || ''];
        return it ? `${CATS[it.category]?.name || it.category}${it.approx ? ' (room only)' : ''}` : null;
      },
    });

    // ------------------------------------------------------------------ the chip
    ctx.status.addToggle({
      id: 'pins',
      label: 'Pins',
      title:
        "Equipment pins: the registry's panels, HVAC, plumbing, network, appliances… one coloured letter per category",
      order: 40,
      key: { code: 'KeyP', label: 'Equipment pins: one coloured letter per category; click a pin to inspect it' },
      get: () => pins.on,
      set: (v) => pins.setOn(v),
      text: () => (pins.wall ? 'Pins · walls' : 'Pins'),
      variants: [
        {
          label: 'Through walls (dimmed)',
          key: { code: 'KeyP', shift: true, label: 'Equipment pins through walls (dimmed)' },
          get: () => pins.on && pins.wall,
          set: (v) => pins.setWall(v),
        },
      ],
    });
    ctx.hud.addLegend({
      id: 'pins',
      title: 'Equipment',
      hint: 'hollow = room only',
      when: () => pins.on && !late.panel?.isOpen,
      items: () =>
        pins.KEYS.filter((k) => pins.cats.has(k) && pins.drawn.some((it) => it.category === k)).map((k) => ({
          label: CATS[k].name,
          glyph: { letter: CATS[k].l, colour: CATS[k].c },
        })),
    });

    // ------------------------------------------------------------------ the Equipment panel
    let query = '';
    const counts: Record<string, number> = {};
    for (const it of pins.items) if (!it.fixtures.length) counts[it.category] = (counts[it.category] || 0) + 1;
    const keys = pins.KEYS.filter((k) => counts[k]);
    late.panel = ctx.hud.addPanel({
      id: 'pins.equipment',
      title: 'Equipment',
      icon: 'pin',
      order: 40,
      meta: () => (pins.on ? `${pins.drawn.length} shown` : `${pins.items.length} items`),
      render: (body) =>
        body.blocks(() => {
          const shown = pins.on ? pins.drawn : [];
          const rooms = new Map<string, PinItem[]>();
          for (const it of shown) {
            const r = human(it.room) || 'elsewhere';
            if (!rooms.has(r)) rooms.set(r, []);
            rooms.get(r)!.push(it);
          }
          const out: Blocks = [
            {
              type: 'search',
              id: 'pins.search',
              value: query,
              placeholder: 'Find equipment by name, make or model',
              onInput: (v) => {
                query = v;
                pins.setQuery(v);
              },
              onEnter: () => {
                const hit = pins.items.find((it) => pins.matches(it));
                if (hit) ctx.inspector.open(`pins:${hit.id}`, { fly: true });
              },
            },
            {
              type: 'chips',
              items: keys.map((k) => ({
                id: k,
                label: CATS[k].name,
                glyph: { letter: CATS[k].l, colour: CATS[k].c },
                count: counts[k],
                on: pins.cats.has(k),
                title: `${CATS[k].name}: ${counts[k]} (click to hide / show; Alt-click or right-click for only this)`,
                onToggle: () => {
                  const next = new Set(pins.cats);
                  if (next.has(k)) next.delete(k);
                  else next.add(k);
                  pins.setCats(next);
                  if (!pins.on) pins.setOn(true);
                },
                onSolo: () => {
                  const only = pins.cats.size === 1 && pins.cats.has(k);
                  pins.setCats(only ? pins.KEYS : [k]);
                  if (!pins.on) pins.setOn(true);
                },
              })),
            },
            !pins.on && {
              type: 'callout',
              tone: 'info',
              text: 'The pins are hidden.',
              action: { label: 'Show them (P)', run: () => pins.setOn(true) },
            },
          ];
          for (const [room, list] of [...rooms].sort((a, b) => a[0].localeCompare(b[0])))
            out.push({
              type: 'group',
              id: `pins.room.${room}`,
              title: room,
              count: list.length,
              blocks: [
                {
                  type: 'list',
                  rows: list
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((it) => ({
                      id: it.id,
                      text: it.name,
                      secondary: [it.make, it.model].filter(Boolean).join(' ') || CATS[it.category]?.name,
                      glyph: glyphOf(it),
                      selected: pins.selected === it.id,
                      subject: `pins:${it.id}`,
                    })),
                },
              ],
            });
          if (pins.on && !shown.length)
            out.push({ type: 'empty', text: query ? 'No equipment matches' : 'No pins in the chosen categories' });
          return out;
        }),
    });

    // ------------------------------------------------------------------ the Equipment section
    const linkTo = (id: string): LinkItem => (pins.byId[id] || pins.unplaced[id] ? `pins:${id}` : { text: id });
    const sectionFor = (it: PinItem): Blocks => {
      const p = it.plan;
      const place =
        it.approx === 'room-centroid'
          ? 'room centroid (the registry gives the room only)'
          : it.approx === 'z-guess'
            ? 'height guessed (the registry gives x, y only)'
            : `position conf ${it.loc_conf}`;
      const shownFile =
        ctx.config.stripPrefix && it.file.startsWith(ctx.config.stripPrefix)
          ? it.file.slice(ctx.config.stripPrefix.length)
          : it.file;
      const back = it.referenced_by.filter((r) => !it.connections.some((c) => c.refs.includes(r.id)));
      const unknown = { text: 'unknown', muted: true };
      return [
        {
          type: 'kv',
          rows: [
            ['Make / model', [it.make, it.model].filter(Boolean).join(' ') || unknown],
            it.serial ? ['Serial', { text: it.serial, mono: true }] : null,
            [
              'Status',
              [
                { text: it.status, pill: it.status === 'in service' || it.status === 'installed' ? 'ok' : 'off' },
                { text: `conf ${it.conf}`, muted: true },
              ],
            ],
            ['Where', [human(it.room), { text: `plan ${p[0]}, ${p[1]}, Z ${p[2]} ft · ${place}`, muted: true }]],
            it.qty ? ['Qty', String(it.qty)] : null,
            it.aliases.length ? ['Aliases', it.aliases.join(', ')] : null,
            ['Id', { text: it.id, mono: true }],
          ],
        },
        it.loc_note && { type: 'note', label: 'Location note', text: it.loc_note },
        it.specs.length > 0 && { type: 'label', text: 'Specs' },
        it.specs.length > 0 && {
          type: 'kv',
          rows: it.specs.slice(0, 10).map(([k, v]) => [human(k), v] as [string, string]),
        },
        it.specs.length > 10 && {
          type: 'text',
          text: { text: `+ ${it.specs.length - 10} more in the registry file`, muted: true },
        },
        ...it.connections.map((c): Block =>
          c.refs.length
            ? { type: 'links', title: human(c.key), items: c.refs.map(linkTo) }
            : { type: 'kv', rows: [[human(c.key), c.text]] },
        ),
        back.length > 0 && { type: 'links', title: 'Linked from', items: back.map((r) => linkTo(r.id)) },
        it.fixtures.length > 0 && {
          type: 'links',
          title: 'In the model',
          items: [
            {
              text: `${it.fixtures.length} light fixture${it.fixtures.length > 1 ? 's' : ''}`,
              icon: 'bulb',
              title: it.fixtures.join(', '),
              run: () => pins.markFixtures(it.fixtures),
            },
          ],
        },
        it.documents.length > 0 && {
          type: 'links',
          title: 'Documents',
          items: it.documents.map((d) => (d.url ? { text: d.text, href: d.url } : { text: d.text, icon: 'blueprint' })),
        },
        it.photos.length > 0 && {
          type: 'links',
          title: 'Photos',
          items: it.photos.map((ph) => ({
            text: ph.label || ph.file,
            icon: 'camera',
            href: ph.url || undefined,
            title: [ph.file, ph.t && `t ${ph.t}`, ph.shows].filter(Boolean).join(' · '),
          })),
        },
        it.open_questions.length > 0 && {
          type: 'note',
          label: 'Open questions',
          text: it.open_questions.map((x) => `• ${x}`).join('\n'),
        },
        {
          type: 'links',
          items: [
            ctx.config.sourceLink
              ? { text: shownFile, href: ctx.config.sourceLink.replace('{file}', it.file) }
              : { text: shownFile, icon: 'blueprint' },
          ],
        },
      ];
    };
    ctx.inspector.addSection({
      id: 'pins',
      title: 'Equipment',
      icon: 'pin',
      order: 10,
      for: (s) => {
        const id = idOf(s);
        if (id) {
          const it = pins.byId[id];
          if (it) return { blocks: sectionFor(it) };
          const u = pins.unplaced[id];
          return u
            ? {
                blocks: [
                  {
                    type: 'kv',
                    rows: [
                      ['Room', human(u.room)],
                      ['Note', u.note || ''],
                    ],
                  },
                  { type: 'text', text: { text: 'No position in the registry yet.', muted: true } },
                ],
              }
            : null;
        }
        // a light fixture that is a registry item: link to it rather than pin it twice
        const fid = s.kind === 'object' ? (s.node.userData.fixture_id as string | undefined) : undefined;
        const reg = fid && pins.byFixture(fid);
        return reg ? { blocks: [{ type: 'links', title: 'Registry item', items: [`pins:${reg.id}`] }] } : null;
      },
    });

    ctx.search.add({
      id: 'pins',
      label: 'Equipment',
      order: 20,
      search: (q) =>
        pins.items
          .filter((it) => pins.matches(it, q))
          .slice(0, 8)
          .map((it) => ({
            text: it.name,
            secondary: [
              [it.make, it.model].filter(Boolean).join(' ') || human(it.room),
              it.fixtures.length ? 'light' : '',
            ]
              .filter(Boolean)
              .join(' · '),
            glyph: glyphOf(it),
            subject: `pins:${it.id}`,
          })),
    });

    ctx.services.provide('pins', pins);
    ctx.expose('pins', pins);
    if (ctx.url.get('pin')) ctx.inspector.open(`pins:${ctx.url.get('pin')}`, { fly: true });
    return { dispose: () => pins.dispose() };
  },
});
