# JARVIS documentation

Start with the [README](../README.md) (what JARVIS is, the live demo, running it in development); then:

## Guides

- [Your own building](guide/your-own-building.md): from a 3D model (Blender, SketchUp, a scan, or code) to a site
  folder, `site.json`, `validate-site`, and a running viewer, with the demo house as the worked example
- [Writing a plugin](guide/writing-a-plugin.md): a step-by-step tutorial built around a small, real plugin
  ([`examples/measure.ts`](examples/measure.ts)), compiled and run by the unit tests, and loaded into the demo house as
  an external plugin (a module the site names, no fork) by the end-to-end tests

## Reference

- [Model format](model-format.md) (`jarvis-model/1`): what the viewer reads from a glTF model: node names, extras,
  layer rules, parts files, compression
- [Site manifest schema](../schema/site.schema.json) (`jarvis-site/1`): every field of `site.json`; the
  [README](../README.md#the-site-folder) walks through the common ones
- [Plugin API](plugins.md): the `jarvis/plugin` contract (keys, panels, the inspector, the entity store, the scene,
  events), [external plugins](plugins.md#external-plugins) and their trust model, with a second example,
  [`examples/irrigation.ts`](examples/irrigation.ts)
- [Deploying](deploy.md): the container image, the release tarball behind any static server, Home Assistant and CORS
- [The voice assistant](assistant.md) (experimental): the `jarvis-assistant` server, model credentials, the
  Home Assistant policy file, the browser plugin
- [Security](../SECURITY.md): what the Home Assistant allow-list does and doesn't protect, and how to report an issue

## Project

- [Contributing](../CONTRIBUTING.md) and the [Code of Conduct](../CODE_OF_CONDUCT.md)
- [Releasing](../RELEASING.md): changesets, the container image and the tarball
- [Third-party notices](../THIRD_PARTY_NOTICES.md): the licences of the code the build bundles
- [The demo house](../examples/demo-site/README.md): what the generated example site contains

## Design notes

Background, not reference: how the current design came about, and what is planned.

- [HUD audit](design/hud-audit.md): the prototype viewer's UI, and what was wrong with it
- [HUD panel standard](design/hud-panels.md): the panel / inspector / status design the HUD implements (and
  [the static mockup](design/mockup/index.html))
- [Voice assistant](design/voice-assistant.md): the proposal; a draft v1 is documented in [assistant.md](assistant.md)
- [Prototype migration](prototype-migration.md): where each building-specific value of the original single-building
  viewer went
