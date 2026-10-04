import { Canvas } from './png.ts';
import { RISERS, STAIR_X, STAIR_Y0, STAIR_Y1, TREAD, UP } from './dims.ts';
import { ROOMS, WALLS, wallBoxes } from './layout.ts';

// ------------------------------------------------------------------ blueprints: one plan per storey
/** the sheets' extent, plan metres [x0, y0, x1, y1]: the block and the garage wing, with a margin */
const SHEET = [-1, -1, 20, 10];
export function blueprint(storey: 0 | 1): Uint8Array {
  const PX = 40; // pixels per metre
  const [X0, Y0, X1, Y1] = SHEET;
  const cv = new Canvas((X1 - X0) * PX, (Y1 - Y0) * PX);
  const ink = [24, 40, 72, 255],
    pale = [24, 40, 72, 70];
  const to = (x: number, y: number) => [(x - X0) * PX, (Y1 - y) * PX];
  const rect = (x0: number, y0: number, x1: number, y1: number, c: number[]) => {
    const [a, b] = to(x0, y0),
      [c2, d] = to(x1, y1);
    cv.rect(a, b, c2, d, c);
  };
  for (const r of ROOMS.filter((r) => r.storey === storey))
    for (const [x0, y0, x1, y1] of r.rects) rect(x0 + 0.05, y0 + 0.05, x1 - 0.05, y1 - 0.05, [24, 40, 72, 14]);
  for (const w of WALLS.filter((w) => w.storey === storey)) {
    const z = (storey ? UP : 0) + 1.1; // cut at 1.1 m (the garage wing's slab is 0.1 m down)
    for (const b of wallBoxes(w)) if (b[2] <= z && b[5] >= z) rect(b[0], b[1], b[3], b[4], ink);
    for (const o of w.openings)
      if (o.kind === 'window' || o.kind === 'glazed') {
        const mid = (w.c0 + w.c1) / 2;
        if (w.dir === 'x') rect(o.a, mid - 0.02, o.b, mid + 0.02, ink);
        else rect(mid - 0.02, o.a, mid + 0.02, o.b, ink);
      }
  }
  // the stair: treads (ground floor) or the stairwell's outline (first floor)
  for (let i = 0; i < RISERS - 1; i++) {
    const y = STAIR_Y0 + i * TREAD;
    if (!storey || i > 8) rect(STAIR_X[0], y, STAIR_X[1], y + 0.02, storey ? pale : ink);
  }
  rect(STAIR_X[0], STAIR_Y0, STAIR_X[0] + 0.03, STAIR_Y1, storey ? pale : ink);
  return cv.png();
}

export function blueprintIndex() {
  const [x0, y0, x1, y1] = SHEET;
  const corners = (z: number) => ({ tl: [x0, y1, z], tr: [x1, y1, z], bl: [x0, y0, z], br: [x1, y0, z] });
  return {
    sheets: [
      {
        id: 'A-1',
        title: 'A-1 ground floor plan',
        kind: 'plan',
        file: 'A-1.png',
        z_floor: 0,
        corners: corners(0.01),
        rms: 0,
      },
      {
        id: 'A-2',
        title: 'A-2 first floor plan',
        kind: 'plan',
        file: 'A-2.png',
        z_floor: UP,
        corners: corners(UP + 0.01),
        rms: 0,
      },
    ],
  };
}
