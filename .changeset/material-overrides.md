---
'jarvis': patch
---

Blueprint fade and energy mode no longer leave the house faded: B on, J on, B off (or any other order) now puts back the right materials. Plugins get one core mechanism for temporary materials, `ctx.three.materials.push(meshes, material | fn, { priority })` (an override taken off with `dispose()`, and when the plugin stops) and `materials.base(mesh)`; the blueprints, energy and lights plugins use it.
