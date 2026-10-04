// The Content-Security-Policy the viewer is served with (deploy/nginx.conf sends the same; tests/unit/csp.test.ts
// checks they agree). It is what really enforces where plugin code may come from (docs/plugins.md, "Trust"): scripts
// only from the viewer's own origin and the listed ones, whatever a manifest says and wherever a redirect points.
// 'wasm-unsafe-eval' compiles the meshopt and Basis (KTX2) decoders; the Basis transcoder runs in blob: workers.
// Nothing else is restricted: models, data, images and Home Assistant's API may come from anywhere the site names.

/** the policy, with the extra script origins (space-separated, e.g. JARVIS_PLUGIN_ORIGINS) */
export function contentSecurityPolicy(pluginOrigins = ''): string {
  return [
    `script-src 'self' 'wasm-unsafe-eval'${pluginOrigins.trim() ? ` ${pluginOrigins.trim()}` : ''}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
}
