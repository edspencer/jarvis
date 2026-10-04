// A minimal RGBA PNG writer and a rectangle rasteriser, for the demo site's blueprint sheets (no image library needed).
import { deflateSync } from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export class Canvas {
  w: number;
  h: number;
  px: Uint8Array;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 4);
  }
  /** fill a pixel rectangle [x0, x1) × [y0, y1) */
  rect(x0: number, y0: number, x1: number, y1: number, [r, g, b, a]: number[]): void {
    const X0 = Math.max(0, Math.round(Math.min(x0, x1))),
      X1 = Math.min(this.w, Math.round(Math.max(x0, x1)));
    const Y0 = Math.max(0, Math.round(Math.min(y0, y1))),
      Y1 = Math.min(this.h, Math.round(Math.max(y0, y1)));
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) this.px.set([r, g, b, a], (y * this.w + x) * 4);
  }
  png(): Uint8Array {
    const raw = new Uint8Array((this.w * 4 + 1) * this.h);
    for (let y = 0; y < this.h; y++)
      raw.set(this.px.subarray(y * this.w * 4, (y + 1) * this.w * 4), y * (this.w * 4 + 1) + 1);
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, this.w);
    dv.setUint32(4, this.h);
    ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
    const parts = [
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', new Uint8Array()),
    ];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}
