import { describe, expect, it } from 'vitest';
import { TOKENS } from '../../src/ui/tokens';

// WCAG 2.x contrast of the rail's count badges (shell.ts .badge). The e2e axe scan can't check them: a badge's one or
// two digits make axe report color-contrast as "incomplete", not a pass or a violation.

/** relative luminance of an opaque #rrggbb */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not an opaque #rrggbb colour: ${hex}`);
  const [r, g, b] = m.slice(1).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('count badge contrast (10px bold: normal text, 4.5:1)', () => {
  const pairs: [string, string, string][] = [
    ['neutral: --jv-text on --jv-badge-fill', TOKENS.text, TOKENS.badgeFill],
    ['bad: white on --jv-bad-fill', '#ffffff', TOKENS.badFill],
    ['warn: #111 on --jv-warn', '#111111', TOKENS.warn],
  ];
  it.each(pairs)('%s', (_name, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('knows a failing pair (white on --jv-bad, the old badge)', () => {
    expect(contrast('#ffffff', TOKENS.bad)).toBeLessThan(4.5);
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
  });
});
