// Lights: the building's light fixtures as they are. A feature plugin: it reads the site's fixture map (which
// entities light each fixture), binds them in the store, draws each fixture by its entities' live state (fx.ts), and
// switches a light from the model (T while aiming at it, Shift-click, the Light section's button) through
// ctx.store.call(), which the owning connector executes under its allow-list. It doesn't know which connector that is.
//
// A fixture with one entity gets 'toggle'; one with several (a two-bulb lamp, a cove's four strips) gets turn_on or
// turn_off on all of them, so they stay together. The glow changes at once (optimistic) and the real state replaces it
// when the store reports the change; no change within PENDING_MS, or an error, puts the real state back and says why
// (a toast and the section).
//
// The blink test (?hablink, on an unconfirmed fixture): flashes each bulb of a low-confidence set in turn and asks
// which fixture blinked (aim and press T, or Shift-click); the answers come out as map lines to paste.
import * as THREE from 'three';
import type { LightsConfig } from '../../site';
import { definePlugin, type Blocks, type ButtonSpec, type Subject, type ToastHandle } from '../../plugin-api';
import { cleanName } from '../../core/builtin';
import { human } from '../../core/text';
import { DEFAULT_K, combine, kelvinRGB, lookOf } from './look';
import { createLightFx, type FixtureFx } from './fx';

const PENDING_MS = 5000;
const DOMAINS = /^(light|switch)\./;

interface MapEntry {
  entity_id?: string | string[] | null;
  conf?: string;
  src?: string;
  group?: string;
  unavailable_means?: string;
  switch_is_light?: boolean;
}

interface FaultsOverlay {
  on: boolean;
  covers(e: string): boolean;
}

export default definePlugin<LightsConfig>({
  id: 'lights',
  name: 'Lights',
  async setup(ctx) {
    const { scene, camera, model } = ctx.three;
    const fixtures = model.fixtures;
    const store = ctx.store;
    const ref = (fid: string) => `fixture:${fid}`;
    const entitiesOf = (fid: string) => store.entitiesOf(ref(fid)).filter((e) => DOMAINS.test(e));
    const bindingOf = (fid: string) => store.bindingsOf(ref(fid))[0];
    const meta = (fid: string) => (bindingOf(fid)?.meta || {}) as Partial<MapEntry>;
    const faults = () => ctx.services.get<FaultsOverlay>('faults');

    // ------------------------------------------------------------------ the fixture map -> bindings
    if (ctx.config.map) {
      let m: Record<string, unknown> | null = null;
      try {
        const j = await ctx.load<Record<string, unknown> & { fixtures?: Record<string, unknown> }>(ctx.config.map);
        m = (j.fixtures as Record<string, unknown>) || j;
      } catch (err) {
        ctx.log.warn(`no fixture map (${(err as Error).message}): no fixture is mapped`);
      }
      for (const [fid, v] of Object.entries(m || {})) {
        if (!v || typeof v !== 'object') continue;
        const e = v as MapEntry;
        const ents = (Array.isArray(e.entity_id) ? e.entity_id : e.entity_id ? [e.entity_id] : []).filter(
          (x): x is string => typeof x === 'string' && DOMAINS.test(x),
        );
        store.bind({
          ref: ref(fid),
          entities: ents,
          conf: e.conf,
          src: e.src,
          meta: { group: e.group, unavailable_means: e.unavailable_means, switch_is_light: e.switch_is_light },
        });
      }
    }

    // without the faults plugin, V still shows the lights whose entities are unavailable (?hawall starts with it on)
    let ownFaults = ctx.url.has('hawall');
    // ------------------------------------------------------------------ the scene
    const fx = createLightFx({
      scene,
      camera,
      fixtures,
      materials: ctx.three.materials,
      emitterHints: ctx.config.emitterHints,
      // real lights; tune for fps (8-12); a bare ?halights means none, as before
      poolSize: THREE.MathUtils.clamp(ctx.url.get('halights') === '' ? 0 : ctx.url.num('halights', 10), 0, 32),
      room: () => ctx.view.here(),
      seen: (p) => ctx.view.seen(p),
      entitiesOf,
      wallOn: () => (faults() ? !!faults()!.on : ownFaults),
      covers: (e) => !!faults()?.covers(e),
    });
    const stamp = (fid: string): string =>
      entitiesOf(fid)
        .map((e) => `${store.get(e)?.state}|${store.get(e)?.last_changed}`)
        .join(',');
    function refresh(fid: string): void {
      const f = fx.fx[fid];
      if (!f) return;
      if (f.pending) {
        // a switch is in flight: keep its optimistic look until the store reports
        if (stamp(fid) === f.pending.stamp) return;
        f.pending = null;
        f.err = null;
      }
      const es = entitiesOf(fid);
      if (!es.length) return fx.applyLook(f, { kind: 'none' });
      const um = meta(fid).unavailable_means;
      fx.applyLook(f, combine(es.map((e) => lookOf(store.get(e), um))));
    }
    // every fixture in the model, prepared once (the lamps of an extra model arrive later)
    function sync(): void {
      if (!fx.engaged) return;
      for (const id of Object.keys(fixtures))
        if (!fx.fx[id]) {
          fx.prepFixture(id);
          refresh(id);
        }
    }
    const engageIfLive = () => {
      if (fx.engaged || !store.live()) return;
      fx.engage();
      sync();
    };
    store.onConnectors(engageIfLive);
    ctx.events.on('model', () => sync());
    store.onChange((c) => {
      engageIfLive();
      const touched = new Set<string>();
      for (const e of c.changed) for (const r of store.refsOf(e)) if (r.startsWith('fixture:')) touched.add(r.slice(8));
      for (const fid of touched) refresh(fid);
      if (touched.size) inspectFixture();
    });
    store.onBindings(() => {
      for (const fid of Object.keys(fx.fx)) refresh(fid);
      inspectFixture();
    });
    ctx.events.on('frame', ({ dt }) => fx.update(dt));
    engageIfLive();
    // the faults plugin's overlay, if it runs (it gives way to a device marker); else the lights offer their own V
    ctx.events.on('ready', () => {
      if (ctx.plugins.has('faults')) return;
      ctx.status.addToggle({
        id: 'lights.faults',
        label: 'Faults',
        title: 'Lights that are unavailable, drawn through walls',
        order: 44,
        key: { code: 'KeyV', label: 'Faults through walls: the lights whose entities are unavailable' },
        when: () => store.live(),
        get: () => ownFaults,
        set: (v) => {
          ownFaults = v;
          fx.poke();
        },
      });
    });

    // ------------------------------------------------------------------ switching
    const fixtureOf = (s: Subject | null): string | null =>
      s?.kind === 'object' ? ((s.node.userData.fixture_id as string | undefined) ?? null) : null;
    const nameOf = (fid: string) => cleanName(fid);
    const inspectFixture = () => ctx.inspector.refresh((s) => !!fixtureOf(s));

    function blocker(fid: string): string | null {
      const es = entitiesOf(fid);
      if (!es.length) return 'no entity mapped to this fixture yet';
      const r = store.refusal(es, 'toggle');
      if (r) return r;
      if (es.every((e) => ['unavailable', 'unknown', undefined].includes(store.get(e)?.state))) return 'unavailable';
      return null;
    }
    // how many bulbs a toggle reaches: a group lists its members in attributes.entity_id
    function bulbsOf(fid: string): { n: number; groups: number } {
      let n = 0,
        groups = 0;
      for (const e of entitiesOf(fid)) {
        const mem = store.get(e)?.attributes?.entity_id;
        if (Array.isArray(mem)) {
          n += mem.length;
          groups++;
        } else n++;
      }
      return { n, groups };
    }

    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
    async function toggleFixture(fid: string): Promise<boolean> {
      const f = fx.fx[fid];
      const why = blocker(fid);
      if (!f || why) {
        if (f) f.err = why;
        ctx.toast({ text: `Can't switch ${nameOf(fid)}: ${why || 'not ready'}`, tone: 'warn' });
        inspectFixture();
        return false;
      }
      const es = entitiesOf(fid);
      const to = f.look?.kind === 'on' ? 'off' : 'on';
      f.err = null;
      f.pending = { to, stamp: stamp(fid), t: Date.now() };
      if (f.look?.kind === 'on') f.lastOn = f.look;
      fx.applyLook(
        f,
        to === 'on'
          ? f.lastOn || { kind: 'on', colour: kelvinRGB(DEFAULT_K, new THREE.Color()), level: 0.8 }
          : { kind: 'off' },
      );
      inspectFixture();
      const mine = f.pending;
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        // nothing came back: put the real state back, and say so
        if (f.pending !== mine) return;
        f.pending = null;
        f.err = `no change reported within ${PENDING_MS / 1000} s`;
        refresh(fid);
        ctx.toast({ text: `${nameOf(fid)}: ${f.err}`, tone: 'warn' });
        inspectFixture();
      }, PENDING_MS);
      pendingTimers.add(timer);
      try {
        await store.call(es, es.length === 1 ? 'toggle' : to === 'on' ? 'turn_on' : 'turn_off');
        ctx.toast({ text: `Turned ${to} ${nameOf(fid)}`, tone: 'ok', timeout: 2500 });
        return true;
      } catch (err) {
        if (f.pending === mine) f.pending = null;
        f.err = `Failed: ${(err as Error)?.message || err}`;
        ctx.log.warn(`switching ${fid} failed`, err);
        refresh(fid);
        ctx.toast({ text: `Couldn't switch ${nameOf(fid)}: ${(err as Error)?.message || err}`, tone: 'bad' });
        inspectFixture();
        return false;
      }
    }

    // T at the crosshair (walking) or the mouse (overview); during a blink test it answers "this one blinked"
    /** the light fixture in the model at a screen point (markers drawn over it don't get in the way) */
    const fixtureAt = (ndc: THREE.Vector2): Subject | null => {
      const p = ctx.pick.model(ndc);
      return p && p.node.userData.fixture_id ? { kind: 'object', node: p.node, part: p.part, hit: p.hit } : null;
    };
    function switchAt(s: Subject | null): void {
      const fid = fixtureOf(s);
      if (!fid || !fx.engaged) return;
      if (blink.active) blinkAnswer(fid);
      else void toggleFixture(fid);
      if (s) ctx.inspector.open(s);
    }
    ctx.keys.add({
      code: 'KeyT',
      label:
        'Switch the light under the crosshair (walking) or the mouse (overview) on or off; Shift-click does the same',
      run: () => switchAt(fixtureAt(ctx.view.aim())),
    });
    ctx.events.on('click', (e) => {
      if (!e.shiftKey || !fx.engaged) return;
      const s = fixtureAt(ctx.view.aim());
      if (!s) return;
      e.handled = true;
      switchAt(s);
    });

    // ------------------------------------------------------------------ the blink test
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const blink = {
      active: false,
      busy: false,
      queue: [] as string[],
      i: 0,
      answers: [] as { entity: string; fixture?: string | null; error?: string }[],
      toast: null as ToastHandle | null,
    };
    function blinkSet(fid: string): string[] {
      const f = fixtures[fid];
      const conf = bindingOf(fid)?.conf || 'low';
      const same = Object.keys(fixtures).filter(
        (id) =>
          bindingOf(id)?.conf === conf &&
          fixtures[id].userData.room === f.userData.room &&
          fixtures[id].userData.fixture_kind === f.userData.fixture_kind,
      );
      return [...new Set(same.flatMap(entitiesOf))]
        .filter(
          (e) =>
            e.startsWith('light.') &&
            !Array.isArray(store.get(e)?.attributes?.entity_id) &&
            !['unavailable', 'unknown', undefined].includes(store.get(e)?.state),
        )
        .sort();
    }
    async function flash(e: string): Promise<void> {
      const st = store.get(e)!;
      const was = st.state,
        a = st.attributes || {};
      for (let k = 0; k < 3; k++) {
        await store.call(e, 'turn_on', { brightness: 255 });
        await sleep(600);
        await store.call(e, 'turn_off');
        await sleep(600);
      }
      if (was === 'on') {
        // back as it was: brightness, then its colour in its own mode
        const back: Record<string, unknown> = {};
        if (a.brightness != null) back.brightness = a.brightness;
        if (a.color_mode === 'color_temp' && a.color_temp_kelvin) back.color_temp_kelvin = a.color_temp_kelvin;
        else if (Array.isArray(a.xy_color)) back.xy_color = a.xy_color;
        else if (Array.isArray(a.rgb_color)) back.rgb_color = a.rgb_color;
        await store.call(e, 'turn_on', back);
      }
    }
    function drawBlink(): void {
      const e = blink.queue[blink.i];
      const spec = {
        text: `Blink test ${blink.i + 1} / ${blink.queue.length}: ${e}. ${blink.busy ? 'Flashing…' : 'Which fixture blinked? Aim at it and press T (or Shift-click it).'}`,
        tone: 'info' as const,
        sticky: true,
        actions: [
          ...(blink.busy ? [] : [{ label: "Didn't see it", run: () => blinkAnswer(null) }]),
          { label: 'Stop', run: () => ((blink.i = blink.queue.length), blink.busy || blinkEnd()) },
        ],
      };
      if (blink.toast) blink.toast.update(spec);
      else blink.toast = ctx.toast(spec);
    }
    async function blinkStart(fid: string): Promise<void> {
      if (blink.active) return;
      const ents = blinkSet(fid);
      if (!ents.length) {
        ctx.toast({ text: 'Blink test: no bulbs to flash in this set', tone: 'warn' });
        return;
      }
      const ok = await ctx.confirm({
        title: 'Blink test',
        text: `Flash ${ents.length} light(s) one at a time (${ents.join(', ')}), 3 times each, then put each back as it was?`,
        confirm: 'Start',
      });
      if (!ok) return;
      Object.assign(blink, { active: true, queue: ents, i: 0, answers: [] });
      inspectFixture();
      void blinkNext();
    }
    async function blinkNext(): Promise<void> {
      if (blink.i >= blink.queue.length) return blinkEnd();
      blink.busy = true;
      drawBlink();
      try {
        await flash(blink.queue[blink.i]);
      } catch (err) {
        blink.answers.push({ entity: blink.queue[blink.i], error: String((err as Error)?.message || err) });
        blink.i++;
        blink.busy = false;
        return blinkNext();
      }
      blink.busy = false;
      drawBlink();
    }
    function blinkAnswer(fid: string | null): boolean {
      if (!blink.active || blink.busy) return false;
      blink.answers.push({ entity: blink.queue[blink.i], fixture: fid });
      blink.i++;
      void blinkNext();
      return true;
    }
    function blinkEnd(): void {
      blink.active = false;
      blink.toast?.close();
      blink.toast = null;
      const day = new Date().toISOString().slice(0, 10);
      const lines = blink.answers.map((a) =>
        a.fixture
          ? `  ${a.fixture}:\n    entity_id: ${a.entity}\n    conf: high\n    src: "blink test ${day}: flashed ${a.entity}, seen at ${a.fixture}"`
          : `  # ${a.entity}: ${a.error ? `not flashed (${a.error})` : 'nobody saw a fixture blink'}`,
      );
      ctx.storage.set('blinkResults', { day, answers: blink.answers });
      inspectFixture();
      const m = ctx.modal({
        title: 'Blink test done',
        blocks: () => [
          { type: 'text', text: "Paste into the fixture map's fixtures: (also kept in this browser)." },
          { type: 'textarea', value: lines.join('\n'), rows: 8 },
        ],
        actions: () => [{ label: 'Close', kind: 'primary', onClick: () => m.close() }],
      });
    }

    // ------------------------------------------------------------------ the Light section, the hover label
    const stateText = (fid: string): { tone: 'ok' | 'off' | 'bad' | 'info'; text: string; detail?: string } => {
      const f = fx.fx[fid];
      const l = f?.look;
      if (f?.pending) return { tone: 'info', text: f.pending.to === 'on' ? 'Turning on…' : 'Turning off…' };
      if (!l || l.kind === 'none')
        return { tone: 'off', text: entitiesOf(fid).length ? 'Not connected' : 'Not mapped' };
      if (l.kind === 'fault') return { tone: 'bad', text: 'Unavailable' };
      if (l.kind === 'off') return { tone: 'off', text: 'Off' };
      const st = store.get(entitiesOf(fid)[0]);
      const k = st?.attributes?.color_temp_kelvin;
      return { tone: 'ok', text: 'On', detail: `${Math.round(100 * l.level)} %${k ? ` · ${k} K` : ''}` };
    };
    ctx.inspector.describeObject((node) => {
      const fid = node.userData.fixture_id as string | undefined;
      if (!fid) return null;
      const kind = node.userData.fixture_kind ? String(node.userData.fixture_kind).replace(/_/g, ' ') : '';
      const room = node.userData.room ? human(node.userData.room) : '';
      return {
        title: cleanName(fid),
        type: ['Light fixture', kind, room].filter(Boolean).join(' · '),
        icon: 'bulb',
        crumbs: room ? [room, 'lights'] : ['lights'],
      };
    });
    ctx.inspector.addSection({
      id: 'lights',
      title: 'Light',
      icon: 'bulb',
      order: 10,
      for: (s) => {
        const fid = fixtureOf(s);
        if (!fid || !bindingOf(fid)) return null;
        const f = fx.fx[fid];
        const why = blocker(fid);
        const st = stateText(fid);
        const m = meta(fid);
        const b = bindingOf(fid);
        const { n, groups } = bulbsOf(fid);
        // other fixtures on the same entity switch too (a group standing in for a set of cans)
        const others = new Set(
          entitiesOf(fid)
            .flatMap((e) => store.refsOf(e))
            .filter((r) => r.startsWith('fixture:') && r !== ref(fid)),
        );
        const blocks: Blocks = [
          { type: 'status', tone: st.tone, text: st.text, detail: st.detail },
          n > 0 && {
            type: 'kv',
            rows: [
              [
                'Switches',
                `${n > 1 ? `${n} bulbs${groups ? ` (${groups === 1 ? 'a group' : `${groups} groups`})` : ''}` : '1 bulb'}${others.size ? ` · with ${others.size} other fixture${others.size > 1 ? 's' : ''}` : ''}`,
              ],
              m.group ? ['Group', m.group] : null,
            ],
          },
          others.size > 0 && { type: 'links', items: [...others].slice(0, 8) },
          why && fx.engaged && { type: 'text', text: { text: `Can't switch: ${why}`, muted: true } },
          b?.conf === 'low' && {
            type: 'callout',
            tone: 'warn',
            text: '⚠ Unconfirmed mapping: this may be another bulb of the same set.',
            action:
              ctx.url.has('hablink') && !blink.active && !why
                ? { label: 'Run a blink test…', run: () => void blinkStart(fid) }
                : undefined,
          },
          f?.err && { type: 'callout', tone: 'bad', text: f.err },
        ];
        const actions: ButtonSpec[] =
          fx.engaged && !why
            ? [
                {
                  label: f?.pending
                    ? f.pending.to === 'on'
                      ? 'Turning on…'
                      : 'Turning off…'
                    : f?.look?.kind === 'on'
                      ? 'Turn off'
                      : 'Turn on',
                  kind: 'primary',
                  key: 'T',
                  disabled: !!f?.pending || blink.active,
                  onClick: () => void toggleFixture(fid),
                },
              ]
            : [];
        return { blocks, actions };
      },
    });
    ctx.hover.add({
      id: 'lights',
      label: (s) => {
        const fid = fixtureOf(s);
        const l = fid && fx.engaged ? fx.fx[fid]?.look : null;
        if (!l || l.kind === 'none') return null;
        return l.kind === 'fault' ? 'unavailable' : l.kind === 'on' ? `on ${Math.round(100 * l.level)} %` : 'off';
      },
    });

    const api = {
      fx: fx.fx,
      get engaged() {
        return fx.engaged;
      },
      get lit() {
        return fx.lit;
      },
      toggleFixture,
      blocker,
      entitiesOf,
      entityOf: (fid: string) => entitiesOf(fid)[0] || null,
      blinkStart,
      blink,
      look: (fid: string) => (fx.fx[fid] as FixtureFx | undefined)?.look ?? null,
      poolSize: fx.pool.length,
      poke: () => fx.poke(),
    };
    ctx.services.provide('lights', api);
    ctx.expose('lights', api);
    return {
      dispose: () => {
        for (const t of pendingTimers) clearTimeout(t);
        blink.toast?.close();
        fx.dispose();
      },
    };
  },
});
