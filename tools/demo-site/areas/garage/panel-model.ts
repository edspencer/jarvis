// The main panel and the energy monitor beside it, on the garage's east wall (back to back with the utility meter
// outside): docs/demo-house.md#electrical-service. The panel is drawn with its door open, so the breaker stack (from
// panel.ts's schedule: every populated space a breaker, the 2-pole ones spanning two rows, AFCI / GFCI ones with a
// white test button) and the schedule card on the door's inside read from the garage floor.
import { Shape, type V3 } from '../../geometry.ts';
import { WING } from '../../dims.ts';
import type { Model } from '../../model.ts';
import { PANEL, SCHEDULE } from '../../panel.ts';

const X = WING.x1; // the east wall's inner face
const z = (h: number) => WING.z + h;

/** the panel: its centre on the wall (plan y), its box's extent */
export const PANEL_BOX = { y0: 5.22, y1: 5.58, z0: z(1.0), z1: z(1.9), depth: 0.1 };
/** the monitor's enclosure, north of the panel */
export const MONITOR_BOX = { y0: 5.74, y1: 5.94, z0: z(1.42), z1: z(1.66), depth: 0.07 };

const ROW = 0.0254; // a space is an inch tall
const STACK_TOP = z(1.68); // top of spaces 1 and 2

/** a regular polygon about c in the plane across `axis` (x: a YZ polygon; y: an XZ one) */
export function ngon(c: V3, r: number, axis: 'x' | 'y', n = 8): V3[] {
  return Array.from({ length: n }, (_, i) => {
    const a = Math.PI / n + (i / n) * 2 * Math.PI;
    const u = r * Math.cos(a),
      v = r * Math.sin(a);
    return (axis === 'x' ? [c[0], c[1] + u, c[2] + v] : [c[0] + u, c[1], c[2] + v]) as V3;
  });
}

/** a flat rectangle on the plane across `axis` at `at` (x = at, y = at or z = at), facing `out` along it: a label, a
 * line, a blank (4 vertices where a box would take 24). It spans a0-a1 along the plan's other horizontal axis (x for
 * the z plane) and b0-b1 up the wall (y for the z plane). */
export function decal(
  s: Shape,
  mat: string,
  axis: 'x' | 'y' | 'z',
  at: number,
  out: 1 | -1,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): void {
  const p = (a: number, b: number): V3 => (axis === 'x' ? [at, a, b] : axis === 'y' ? [a, at, b] : [a, b, at]);
  const inside = p((a0 + a1) / 2, (b0 + b1) / 2);
  inside[{ x: 0, y: 1, z: 2 }[axis]] = at - out;
  s.on(mat).face([p(a0, b0), p(a1, b0), p(a1, b1), p(a0, b1)], inside);
}

export function panelAndMonitor(m: Model): void {
  const { y0, y1, z0, z1, depth } = PANEL_BOX;
  const yc = (y0 + y1) / 2;
  const s = new Shape();
  // the tub and its dead-front
  s.on('ga_panel_grey').box(X - depth, y0, z0, X, y1, z1);
  s.on('ga_panel_front').box(X - depth - 0.006, y0 + 0.025, z0 + 0.03, X - depth, y1 - 0.025, z1 - 0.03);
  // the main breaker (2-pole, at the top, both columns) with its handle
  const front = X - depth - 0.006;
  s.on('ga_breaker').box(front - 0.026, yc - 0.075, STACK_TOP + 0.03, front, yc + 0.075, STACK_TOP + 0.16);
  s.on('ga_panel_grey').box(front - 0.045, yc - 0.05, STACK_TOP + 0.085, front - 0.026, yc + 0.05, STACK_TOP + 0.105);
  // the branch breakers: odd spaces in the left column (north, as you face the panel), even in the right
  for (const c of SCHEDULE) {
    const spaces = Array.isArray(c.breaker) ? c.breaker : [c.breaker];
    const odd = spaces[0] % 2 === 1;
    const rows = spaces.map((n) => Math.floor((n - 1) / 2));
    const top = STACK_TOP - Math.min(...rows) * ROW - 0.002,
      bottom = STACK_TOP - (Math.max(...rows) + 1) * ROW + 0.002;
    const cy = yc + (odd ? 0.05 : -0.05);
    s.on('ga_breaker').box(front - 0.018, cy - 0.045, bottom, front, cy + 0.045, top);
    // the handle (one across both poles of a 2-pole breaker), and an AFCI / GFCI breaker's white test button
    const hz = (top + bottom) / 2,
      hh = spaces.length > 1 ? 0.016 : 0.006;
    s.on('ga_breaker').box(front - 0.03, cy - 0.012, hz - hh, front - 0.018, cy + 0.012, hz + hh);
    if (c.protection) decal(s, 'ga_label_card', 'x', front - 0.0185, -1, cy + 0.025, cy + 0.04, hz - 0.004, hz + 0.004);
  }
  // blank fillers in the spare spaces (the knock-outs a breaker would take)
  const used = new Set(SCHEDULE.flatMap((c) => (Array.isArray(c.breaker) ? c.breaker : [c.breaker])));
  for (let n = 1; n <= PANEL.spaces; n++) {
    if (used.has(n)) continue;
    const row = Math.floor((n - 1) / 2),
      cy = yc + (n % 2 ? 0.05 : -0.05);
    const zt = STACK_TOP - row * ROW - 0.003;
    decal(s, 'ga_panel_grey', 'x', front - 0.0005, -1, cy - 0.04, cy + 0.04, zt - ROW + 0.006, zt);
  }
  // the door, open: hinged on its south edge and swung out square to the wall; the schedule card on its inside
  s.on('ga_panel_grey').box(X - depth - 0.36, y0 - 0.018, z0 + 0.01, X - depth - 0.005, y0 - 0.004, z1 - 0.01);
  const card = { x0: X - depth - 0.33, x1: X - depth - 0.04, z0: z0 + 0.12, z1: z1 - 0.1 };
  decal(s, 'ga_label_card', 'y', y0 - 0.0035, 1, card.x0, card.x1, card.z0, card.z1);
  // its lines: two columns of circuits, as written in by hand
  for (let i = 0; i < 21; i++) {
    const lz = card.z1 - 0.04 - i * 0.03;
    for (const [a, b] of [
      [card.x0 + 0.02, card.x0 + 0.13],
      [card.x0 + 0.16, card.x1 - 0.02],
    ])
      decal(s, 'ga_label_ink', 'y', y0 - 0.003, 1, a, b - (i % 3) * 0.02, lz - 0.003, lz + 0.003);
  }
  m.node('Panel_main', s, { room: 'garage', kind: 'main panel', main_amps: PANEL.main_amps, spaces: PANEL.spaces });

  // the monitor: a small enclosure joined to the panel by a conduit nipple, its CT leads in a bundle into the panel
  const b = MONITOR_BOX;
  const t = new Shape();
  t.on('ga_monitor').box(X - b.depth, b.y0, b.z0, X, b.y1, b.z1);
  t.on('ga_monitor').box(X - b.depth - 0.006, b.y0 + 0.01, b.z0 + 0.01, X - b.depth, b.y1 - 0.01, b.z1 - 0.01);
  t.on('ga_brand_band').box(
    X - b.depth - 0.009,
    b.y0 + 0.03,
    b.z1 - 0.07,
    X - b.depth - 0.006,
    b.y1 - 0.03,
    b.z1 - 0.045,
  );
  t.on('ga_led').box(X - b.depth - 0.012, b.y1 - 0.05, b.z0 + 0.04, X - b.depth - 0.006, b.y1 - 0.035, b.z0 + 0.055);
  // the Wi-Fi antenna
  t.on('ga_breaker').box(X - 0.04, b.y1 - 0.035, b.z1, X - 0.025, b.y1 - 0.02, b.z1 + 0.12);
  // the nipple to the panel's side
  t.on('ga_panel_grey').box(X - 0.05, y1, b.z0 + 0.09, X - 0.02, b.y0, b.z0 + 0.12);
  // the CT leads: down out of the monitor's bottom and across into the panel's side knock-out
  for (const [i, mat] of (['ga_monitor', 'ga_breaker', 'ga_monitor'] as const).entries()) {
    const off = i * 0.012;
    t.on(mat).box(X - 0.045 + off, b.y0 + 0.06, z(1.22) + off, X - 0.035 + off, b.y0 + 0.07, b.z0);
    t.on(mat).box(X - 0.045 + off, y1, z(1.22) + off, X - 0.035 + off, b.y0 + 0.07, z(1.23) + off);
  }
  m.node('Energy_monitor', t, { room: 'garage', kind: 'circuit monitor', channels: 16 });
}
