---
'jarvis': minor
---

Plugins without a fork. A `plugins.<id>` section with a `module` loads that ES module (relative to the manifest) as a
plugin, with the section's other fields as its `ctx.config`; `npm run build-plugin -- plugin.ts out.js` builds one.
Only a manifest on the viewer's own origin (after redirects) loads external plugins, from that origin or one it lists
in the new top-level `pluginOrigins`, and never through a redirect: a `?site=` link can't bring code. The container now
sends a Content-Security-Policy (`script-src 'self' 'unsafe-eval'` plus `JARVIS_PLUGIN_ORIGINS`) that enforces this
in the browser; `'unsafe-eval'` is there for three.js's Basis (KTX2) transcoder, and the demo house gained a KTX2
texture to keep that tested. An external plugin whose id is a built-in's is skipped with a warning. A plugin may
declare its letter `keys` (a section's `keys` wins, and `validate-site` checks it) and a `validate(config)` that runs
before `setup`; `validate-site` checks the module is there, and with `--run-plugin-code` imports it to check what it
exports. Only the enabled plugins' code is downloaded now (every built-in chunk was fetched on every site before).
Plugins can bind Esc, with a `when` (bindings with a `when` share a key): after a modal, a text field, the mouse lock,
a menu and the search, Esc cancels a plugin's active tool before it closes the inspector.
