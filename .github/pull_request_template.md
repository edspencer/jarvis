## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## How it was checked

<!-- e.g. npm test, npm run test:e2e, the demo site in a browser (which views), your own site folder -->

## Checklist

- [ ] `npm run format:check`, `npm run lint`, `npm run typecheck` and `npm test` pass
- [ ] a changeset (`npx changeset`) if users would notice the change
- [ ] docs updated if the manifest (`schema/site.schema.json`), the model format (`docs/model-format.md`) or a plugin's
      data format changed
- [ ] if `tools/make-demo-site.ts` changed: `npm run demo-site` and the regenerated `examples/demo-site` committed
- [ ] nothing from a real building (models, photos, device lists, entity ids, addresses, hostnames, IPs) in the diff
