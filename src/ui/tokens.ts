// Design tokens (hud-panels.md §5): CSS custom properties on :root, so they reach into every component's shadow DOM
// and into a plugin's own render(el); the same values as a TS object for WebGL markers. Dark theme only for now; a
// light theme would be another set of the same names.

export const TOKENS = {
  surface: 'rgba(18, 21, 27, 0.86)',
  surfaceRaised: 'rgba(32, 37, 46, 0.92)',
  surfaceSunken: 'rgba(255, 255, 255, 0.045)',
  border: 'rgba(255, 255, 255, 0.08)',
  shadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
  text: '#e9edf2',
  textMuted: '#9aa4b2',
  textFaint: '#6b7585',
  accent: '#7cc4ff',
  ok: '#3fcf6a',
  warn: '#f0b43c',
  bad: '#ef5a4f',
  // fills under white or text-colour labels (count badges): darker than the status colour, for 4.5:1 contrast
  badFill: '#c9372c',
  badgeFill: '#2c3c55',
  info: '#6aa8ff',
  off: '#7a8494',
} as const;

/** the sequential scale (load tint and the like): 5 steps */
export const SEQUENTIAL = ['#2b3a55', '#6d6a5a', '#ffd166', '#ff9a4d', '#ff6b3d'] as const;

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export const TOKENS_CSS = `:root {
${Object.entries(TOKENS)
  .map(([k, v]) => `  --jv-${kebab(k)}: ${v};`)
  .join('\n')}
  --jv-radius: 10px;
  --jv-radius-ctl: 6px;
  --jv-font: system-ui, -apple-system, 'Segoe UI', sans-serif;
  --jv-mono: ui-monospace, Menlo, Consolas, monospace;
  --jv-gap: 10px;
  --jv-rail: 44px;
  --jv-dock: 320px;
  --jv-inspector: 360px;
  --jv-strip: 34px;
  --jv-motion: 120ms;
}
@media (prefers-reduced-motion: reduce) { :root { --jv-motion: 0ms; } }`;

/** put the tokens on the page (once) */
export function installTokens(doc: Document = document): void {
  if (doc.getElementById('jv-tokens')) return;
  const s = doc.createElement('style');
  s.id = 'jv-tokens';
  s.textContent = TOKENS_CSS;
  doc.head.appendChild(s);
}
