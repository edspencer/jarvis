// The example plugin of docs/guide/writing-a-plugin.md: measure the distance between two points on the model. M turns
// measuring on and off (Esc stops it too); while it is on, a click takes a point instead of inspecting, and every two
// points make a measurement: a line in the scene, a row in the Measure panel and a subject the inspector can show.
// Shift-M clears them. tests/unit/measure-example.test.ts runs it; tests/e2e/external-plugin.spec.ts loads it into the
// demo house as an external plugin (npm run build-plugin).
import { definePlugin, type Subject } from 'jarvis/plugin';
import type { Line, Vector3 } from 'three';

interface MeasureConfig {
  /** the lines' colour (default '#ffb000') */
  colour?: string;
  /** decimal places shown (default 2) */
  decimals?: number;
}

interface Measurement {
  id: string;
  a: Vector3;
  b: Vector3;
}

type Units = 'm' | 'ft';
const FT = 0.3048; // metres per foot

// not one of the core's icons: a plugin can pass its own SVG
const RULER =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
  '<path d="M3 15L15 3l6 6L9 21z M7 11l2 2 M10 8l2 2 M13 5l2 2"/></svg>';

export default definePlugin<MeasureConfig>({
  id: 'measure',
  name: 'Measure',
  keys: ['M'], // the letters it binds: validate-site keeps a site layer's key off them
  validate(config) {
    const c = config as Record<string, unknown>;
    return [
      ...Object.keys(c)
        .filter((k) => k !== 'colour' && k !== 'decimals')
        .map((k) => `${k}: unknown field (expected colour, decimals)`),
      c.colour !== undefined && typeof c.colour !== 'string' && "colour: expected a CSS colour ('#ffb000')",
      c.decimals !== undefined &&
        !(Number.isInteger(c.decimals) && (c.decimals as number) >= 0) &&
        'decimals: expected a whole number',
    ].filter((x): x is string => !!x);
  },
  setup(ctx) {
    const colour = ctx.config.colour ?? '#ffb000';
    const decimals = ctx.config.decimals ?? 2;
    let units = ctx.storage.get<Units>('units', ctx.site.units); // the person's choice, else the site's plan units

    const list: Measurement[] = [];
    let measuring = false;
    let first: Vector3 | null = null; // the first point of the next measurement
    let n = 0;
    const byId = (id: string) => list.find((m) => m.id === id);
    const idOf = (s: Subject | null) => (s?.kind === 'item' && s.id.startsWith('measure:') ? s.id.slice(8) : '');
    const length = (m: Measurement) => m.a.distanceTo(m.b); // the scene is in metres
    const conv = (metres: number) => (units === 'm' ? metres : metres / FT);
    const fmt = (metres: number) => `${conv(metres).toFixed(decimals)} ${units}`;

    // ------------------------------------------------------------------ the scene
    const { THREE, scene, toPlan } = ctx.three;
    const group = new THREE.Group();
    group.name = 'measure';
    scene.add(group);
    const lineMat = new THREE.LineBasicMaterial({ color: colour, depthTest: false });
    const selectedMat = new THREE.LineBasicMaterial({ color: '#ffffff', depthTest: false });
    const dotMat = new THREE.MeshBasicMaterial({ color: colour, depthTest: false });
    const dot = new THREE.SphereGeometry(0.04); // 4 cm
    const lines = new Map<string, Line>();
    const marker = (p: Vector3) => {
      const m = new THREE.Mesh(dot, dotMat);
      m.position.copy(p);
      m.renderOrder = 10; // drawn last, over the walls (depthTest is off)
      return m;
    };
    const pending = marker(new THREE.Vector3());
    pending.visible = false;
    group.add(pending);
    const draw = (m: Measurement) => {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([m.a, m.b]), lineMat);
      line.renderOrder = 10;
      line.add(marker(m.a), marker(m.b));
      group.add(line);
      lines.set(m.id, line);
    };
    ctx.own(() => {
      scene.remove(group);
      for (const l of lines.values()) l.geometry.dispose();
      for (const x of [lineMat, selectedMat, dotMat, dot]) x.dispose();
    });

    // ------------------------------------------------------------------ measuring
    const changed = () => {
      panel.refresh();
      ctx.inspector.refresh();
      ctx.hud.invalidate(); // the status item and the badge
    };
    const setMeasuring = (on: boolean) => {
      measuring = on;
      first = null;
      pending.visible = false;
      changed();
    };
    const remove = (id: string) => {
      const line = lines.get(id);
      if (!line) return;
      list.splice(list.indexOf(byId(id)!), 1);
      group.remove(line);
      line.geometry.dispose();
      lines.delete(id);
      if (idOf(ctx.inspector.current()) === id) ctx.inspector.close();
      changed();
    };
    const clear = () => {
      for (const m of [...list]) remove(m.id);
      setMeasuring(measuring);
    };

    ctx.keys.add({
      code: 'KeyM',
      label: 'Measure: click two points on the model (M again to stop)',
      run: () => setMeasuring(!measuring),
    });
    ctx.keys.add({
      code: 'KeyM',
      shift: true,
      label: 'Clear the measurements',
      when: () => list.length > 0 || !!first,
      run: clear,
    });
    ctx.keys.add({
      code: 'Escape',
      label: 'Stop measuring',
      when: () => measuring, // only while there is something to cancel: then Esc is ours before the inspector's
      run: () => setMeasuring(false),
    });

    ctx.events.on('click', (e) => {
      if (!measuring) return;
      e.handled = true; // the click takes a point: it doesn't inspect
      const hit = ctx.pick.model(ctx.view.aim()); // the model under the mouse (or the crosshair)
      if (!hit) {
        ctx.toast('Nothing there to measure to');
        return;
      }
      const p = hit.hit.point.clone();
      if (!first) {
        first = p;
        pending.position.copy(p);
        pending.visible = true;
        ctx.hud.invalidate();
        return;
      }
      const m: Measurement = { id: String(++n), a: first, b: p };
      list.push(m);
      draw(m);
      first = null;
      pending.visible = false;
      ctx.events.emit('measure:added', { id: m.id, metres: length(m) });
      ctx.inspector.open(`measure:${m.id}`);
      changed();
    });
    // the selected measurement's line turns white
    ctx.events.on('select', ({ subject }) => {
      for (const [id, line] of lines) line.material = id === idOf(subject) ? selectedMat : lineMat;
    });

    // ------------------------------------------------------------------ the HUD
    ctx.status.addItem({
      id: 'measure',
      order: 140,
      render: () =>
        measuring
          ? { icon: RULER, strong: 'Measure', text: first ? 'click the second point' : 'click the first point' }
          : null,
      onClick: () => setMeasuring(false),
    });

    const panel = ctx.hud.addPanel({
      id: 'measure',
      title: 'Measure',
      icon: RULER,
      order: 60,
      badge: () => list.length || null,
      render: (body) =>
        body.blocks(() => [
          { type: 'toggle', label: 'Measuring', key: 'M', value: measuring, onChange: setMeasuring },
          {
            type: 'segmented',
            label: 'Units',
            value: units,
            options: [
              { value: 'm', label: 'Metres' },
              { value: 'ft', label: 'Feet' },
            ],
            onChange: (v) => {
              units = v as Units;
              ctx.storage.set('units', units);
              changed();
            },
          },
          {
            type: 'list',
            rows: list.map((m) => ({
              id: m.id,
              text: `Measurement ${m.id}`,
              value: fmt(length(m)),
              subject: `measure:${m.id}`,
            })),
            empty: 'Press M, then click two points on the model.',
          },
        ]),
      actions: () =>
        list.length
          ? [{ label: 'Clear all', key: 'Shift-M', confirm: 'Clear every measurement?', onClick: clear }]
          : [],
    });

    // ------------------------------------------------------------------ the inspector
    ctx.inspector.registerSubject('measure', {
      describe: (id) => {
        const m = byId(id);
        return m ? { title: `Measurement ${m.id}`, type: fmt(length(m)), icon: RULER } : null;
      },
      fly: (id) => {
        const m = byId(id);
        if (m) ctx.view.fly(m.a.clone().lerp(m.b, 0.5), null);
      },
    });
    const plan = (v: Vector3) => {
      const p = toPlan(v); // world (metres, Y up) -> plan (X east, Y north, Z up; the site's units)
      return `${p.X.toFixed(1)}, ${p.Y.toFixed(1)}, ${p.Z.toFixed(1)} ${ctx.site.units}`;
    };
    ctx.inspector.addSection({
      id: 'measure',
      title: 'Measurement',
      icon: RULER,
      order: 10, // the subject's owner comes first
      for: (s) => {
        const m = byId(idOf(s));
        if (!m) return null;
        const d = m.b.clone().sub(m.a);
        return {
          blocks: [
            { type: 'meter', value: conv(d.length()).toFixed(decimals), unit: units },
            {
              type: 'kv',
              rows: [
                ['Horizontal', fmt(Math.hypot(d.x, d.z))],
                ['Vertical', fmt(Math.abs(d.y))],
                ['From', { text: plan(m.a), mono: true }],
                ['To', { text: plan(m.b), mono: true }],
              ],
            },
          ],
          actions: [{ label: 'Delete', kind: 'danger', onClick: () => remove(m.id) }],
        };
      },
    });

    // for the console: window.twin.measure.list()
    ctx.expose('measure', { list: () => list.map((m) => ({ id: m.id, metres: length(m) })), clear });
  },
});
