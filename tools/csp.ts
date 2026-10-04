// The Content-Security-Policy the viewer is served with (deploy/nginx.conf sends the same; tests/unit/csp.test.ts
// checks they agree). It is what really enforces where plugin code may come from (docs/plugins.md, "Trust"): scripts
// only from the viewer's own origin and the listed ones, whatever a manifest says and wherever a redirect points.
// Nothing else is restricted: models, data, images and Home Assistant's API may come from anywhere the site names.
//
// Why 'unsafe-eval': a model's KTX2 (Basis Universal) textures are transcoded by three's basis_transcoder.js, an
// Emscripten build whose embind glue makes its function invokers with `new Function` (craftInvokerFunction; it isn't
// built with -sDYNAMIC_EXECUTION=0), in a worker KTX2Loader starts from a blob: URL, which inherits this policy.
// Without it a KTX2 model never loads (EvalError in the worker). 'unsafe-eval' also covers compiling WebAssembly (the
// meshopt and Basis decoders). It lets code that already runs on the page turn strings into code; it does not let a
// script from another origin run, which is what script-src's origin list is for: that list stays the plugin trust
// boundary. tests/csp loads the demo house, whose house-name plaque is a KTX2 texture, under this policy.

/** the policy, with the extra script origins (space-separated, e.g. JARVIS_PLUGIN_ORIGINS) */
export function contentSecurityPolicy(pluginOrigins = ''): string {
  return [
    `script-src 'self' 'unsafe-eval'${pluginOrigins.trim() ? ` ${pluginOrigins.trim()}` : ''}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
}
