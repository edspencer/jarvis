---
'jarvis': minor
---

Plugins without a fork. A `plugins.<id>` section with a `module` loads that ES module (relative to the manifest) as a
plugin, with the section's other fields as its `ctx.config`; `npm run build-plugin -- plugin.ts out.js` bundles one.
Modules load only from the viewer's own origin, or from an origin the manifest lists in the new top-level
`pluginOrigins` (honoured only for a manifest on the viewer's origin after redirects, so a `?site=` link can't bring
code), and never through a redirect. The container now sends a Content-Security-Policy (`script-src 'self'` plus
`JARVIS_PLUGIN_ORIGINS`) that enforces this in the browser. An external plugin whose id is a built-in's is skipped
with a warning. `validate-site` checks the module is there; with `--run-plugin-code` it imports it to check what it
exports, its keys and its section. A plugin may declare its letter `keys` and a `validate(config)` that runs before
`setup`. Only the enabled plugins' code is downloaded now (every built-in chunk was fetched on every site before).
Plugins can bind Esc (bindings with a `when` share it): after a modal, a text field, the mouse lock, a menu and the
search, Esc cancels a plugin's active tool before it closes the inspector.
