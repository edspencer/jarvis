# Contributing

Thanks for helping. Issues and pull requests are welcome: bugs, viewer features, plugins, model conventions, docs.

## Set up

Node 22.18 or newer (see `.nvmrc`).

```sh
npm install            # if NODE_ENV=production is set in your shell: npm install --include=dev
npm run dev            # http://localhost:5173, with the demo house
npx playwright install chromium   # once, for the end-to-end tests
```

`npm run dev` serves the demo house in `examples/demo-site` unless `JARVIS_SITE` points at another site folder (keep
your own under `sites/`, which git ignores). With `?ha=mock` the Home Assistant plugin plays a made-up state stream.

## Before you open a pull request

```sh
npm run format         # Prettier
npm run lint           # ESLint
npm run typecheck      # tsc, strict
npm test               # unit tests (Vitest)
npm run test:e2e       # Playwright against the demo house; uses the GPU if there is one, else SwiftShader
npm run validate-site -- examples/demo-site
```

CI runs all of these on every pull request, plus a build of the container image, and the checks must pass before a
merge. If a test fails only in CI, the workflow run has the Playwright report and traces as an artifact.

- **Changesets.** If users would notice the change (the viewer, the manifest or model format, the tools, the
  container), add a changeset: `npx changeset`, choose patch / minor / major, write one line for the changelog. Docs,
  tests and CI changes don't need one. See [RELEASING.md](RELEASING.md).
- **The demo house is generated.** Change `tools/make-demo-site.ts`, run `npm run demo-site`, commit the result. CI
  fails if `examples/demo-site` isn't what the script writes. When you add a viewer feature, consider giving the demo
  house something that exercises it, and an e2e test.
- **Formats are public.** The manifest (`schema/site.schema.json`), the model format (`docs/model-format.md`) and the
  plugins' data files are what people build sites against. Keep changes backwards compatible within `jarvis-site/1` /
  `jarvis-model/1`, and update the schema, the docs and `validate-site` together.
- **No real buildings.** Don't commit models, photos, device lists or addresses of a real place, yours included. Test
  data is synthetic (`examples/demo-site`, `tests/fixtures`).
- **Style.** Prettier and ESLint settle formatting. Comments say why, not what. Match the code around you.

## Commits and pull requests

Small, focused pull requests against `main`, with a description of what changed, why and how you checked it (the
template asks). `main` is protected: changes land through pull requests with green checks.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
