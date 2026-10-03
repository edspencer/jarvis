// Geometry for the demo-site generator: solids built in the plan frame (X east, Y north, Z up, metres) and written
// in glTF's (X, Z, -Y). Flat-shaded, outward faces, no UVs: the demo uses plain colours.

export type V3 = [number, number, number];

/** plan (x, y, z) -> glTF (x, z, -y) */
export const toGltf = ([x, y, z]: V3): V3 => [x, z, -y];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const mean = (ps: V3[]): V3 => {
  const s: V3 = [0, 0, 0];
  for (const p of ps) for (let i = 0; i < 3; i++) s[i] += p[i] / ps.length;
  return s;
};
const round = (x: number) => Math.round(x * 1e5) / 1e5;

/** triangles for one material, in glTF coordinates */
export class Geo {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];

  /** a planar convex polygon (plan points), facing away from `inside` (a plan point) */
  face(pts: V3[], inside: V3): void {
    const g = pts.map(toGltf);
    let n = norm(cross(sub(g[1], g[0]), sub(g[2], g[0])));
    if (dot(n, sub(mean(g), toGltf(inside))) < 0) {
      g.reverse();
      n = [-n[0], -n[1], -n[2]];
    }
    const base = this.positions.length / 3;
    for (const p of g) {
      this.positions.push(...p.map(round));
      this.normals.push(...n.map(round));
    }
    for (let i = 1; i < g.length - 1; i++) this.indices.push(base, base + i, base + i + 1);
  }

  /** a convex solid given by its faces (plan points) */
  solid(faces: V3[][]): void {
    const c = mean(faces.flat());
    for (const f of faces) this.face(f, c);
  }

  /** an axis-aligned box, plan coordinates */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    this.prism(
      [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y1, z0],
        [x0, y1, z0],
      ],
      [0, 0, z1 - z0],
    );
  }

  /** a convex planar polygon swept along `by` */
  prism(poly: V3[], by: V3): void {
    const top = poly.map((p) => [p[0] + by[0], p[1] + by[1], p[2] + by[2]] as V3);
    const faces: V3[][] = [poly, top];
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      faces.push([poly[i], poly[j], top[j], top[i]]);
    }
    this.solid(faces);
  }

  /** a solid of revolution about a vertical axis: rings of (z, radius), n sides */
  lathe(cx: number, cy: number, rings: [number, number][], n = 8, phase = Math.PI / 8): void {
    const ring = ([z, r]: [number, number]) =>
      Array.from({ length: n }, (_, i) => {
        const a = phase + (i / n) * 2 * Math.PI;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a), z] as V3;
      });
    const rs = rings.map(ring);
    const c: V3 = [cx, cy, (rings[0][0] + rings.at(-1)![0]) / 2];
    if (rings[0][1] > 0) this.face(rs[0], c);
    if (rings.at(-1)![1] > 0) this.face(rs.at(-1)!, c);
    for (let k = 0; k < rs.length - 1; k++)
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = rs[k][i],
          b = rs[k][j],
          d = rs[k + 1][i],
          e = rs[k + 1][j];
        // a ring of radius 0 makes triangles
        const quad = [a, b, e, d].filter((p, idx, all) => all.findIndex((q) => q.every((v, w) => v === p[w])) === idx);
        if (quad.length >= 3) this.face(quad, [cx, cy, (a[2] + d[2]) / 2]);
      }
  }

  get empty(): boolean {
    return !this.indices.length;
  }

  /** plan-frame bounding box, as glTF world [minX, minY, minZ, maxX, maxY, maxZ] */
  static gltfBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
    const a = toGltf([x0, y0, z0]),
      b = toGltf([x1, y1, z1]);
    return [0, 1, 2].map((i) => round(Math.min(a[i], b[i]))).concat([0, 1, 2].map((i) => round(Math.max(a[i], b[i]))));
  }
}

/** a set of Geo by material name */
export class Shape {
  byMaterial = new Map<string, Geo>();
  on(material: string): Geo {
    let g = this.byMaterial.get(material);
    if (!g) this.byMaterial.set(material, (g = new Geo()));
    return g;
  }
}
