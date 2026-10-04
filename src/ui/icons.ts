// The core's icons (24 × 24, currentColor). A plugin passes one of these names, or its own '<svg …>' string.
const s = (body: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS: Record<string, string> = {
  search: s('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  nav: s('<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z" fill="currentColor" stroke="none"/>'),
  sun: s(
    '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  ),
  blueprint: s('<path d="M4 4h16v16H4z M4 10h8v10 M12 4v6"/>'),
  pin: s(
    '<path d="M12 22s7-7 7-12a7 7 0 10-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5" fill="currentColor" stroke="none"/>',
  ),
  fault: s('<path d="M12 3l10 17H2z"/><path d="M12 10v4.5M12 17.2v.3"/>'),
  bolt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z" fill="currentColor"/></svg>',
  power: s('<path d="M12 3v8"/><path d="M7 6.5a7.5 7.5 0 1010 0"/>'),
  help: s('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-1 .7-1.5 1.2-1.5 2.5M12 17v.3"/>'),
  gear: s(
    '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  ),
  bulb: s('<path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0012 3z"/>'),
  cube: s('<path d="M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5z M3.5 7.25L12 12l8.5-4.75 M12 12v9.5"/>'),
  home: s('<path d="M12 3l9 8h-2.5v9h-13v-9H3z"/><circle cx="12" cy="14" r="2" fill="currentColor" stroke="none"/>'),
  plate: s(
    '<rect x="6" y="3" width="12" height="18" rx="2"/><rect x="10" y="8" width="4" height="8" rx="1" fill="currentColor" stroke="none"/>',
  ),
  pulse: s('<path d="M3 12h4l2-5 4 10 2-5h6"/>'),
  door: s('<path d="M6 21V3h12v18M3 21h18"/><circle cx="14.5" cy="12" r="1" fill="currentColor" stroke="none"/>'),
  layers: s('<path d="M12 3l9 5-9 5-9-5z M3 13l9 5 9-5"/>'),
  eye: s('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  ghost: s(
    '<path d="M6 20V10a6 6 0 0112 0v10l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5z"/><circle cx="10" cy="10" r=".8" fill="currentColor"/><circle cx="14" cy="10" r=".8" fill="currentColor"/>',
  ),
  close: s('<path d="M6 6l12 12M18 6L6 18"/>'),
  back: s('<path d="M15 5l-7 7 7 7"/>'),
  forward: s('<path d="M9 5l7 7-7 7"/>'),
  chevron: s('<path d="M6 9l6 6 6-6"/>'),
  more: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  link: s('<path d="M7 17L17 7M9 7h8v8"/>'),
  copy: s(
    '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
  ),
  room: s('<path d="M3 21V8l9-5 9 5v13M3 21h18M9 21v-7h6v7"/>'),
  camera: s('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
  pinned: s('<path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v8"/>'),
};

/** the SVG for an icon reference (a name or an SVG string) */
export function iconSvg(ref: string | undefined): string {
  if (!ref) return '';
  // a plugin's own SVG: drawing elements only (no scripts, event handlers, external images or embedded HTML)
  if (ref.trimStart().startsWith('<svg'))
    return /<\s*(script|foreignObject|image|iframe|a)\b|\son\w+\s*=|javascript:/i.test(ref) ? ICONS.cube : ref;
  return ICONS[ref] || ICONS.cube;
}
