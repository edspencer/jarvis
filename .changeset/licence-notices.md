---
'jarvis': patch
---

The build now ships `LICENSE` and `THIRD_PARTY_NOTICES.md` (the licences of the bundled three.js, three-mesh-bvh, Lit,
home-assistant-js-websocket, and the meshopt, KTX2 and Basis Universal decoders), so the release tarball and the
container image carry them. `npm run notices` regenerates the notices from the build; a new workflow checks them and
the production dependencies' licences.
