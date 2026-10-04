---
'jarvis': patch
---

`MATERIAL_PRIORITY.energy` is 10 (it was 0), so a plugin's material override at the default priority sits under energy mode instead of tying with it. `materials.base(mesh)` is typed as the mesh's material (`Material | Material[]` for a plain `THREE.Mesh`) instead of casting the array case away, and it is the way to read a mesh's own material: picking and the inspector's Material row use it (they no longer show energy mode's ghost), and `mesh.userData.baseMaterial` is internal. On a touch screen, the window losing focus lets go of the thumb-stick, so a stick held through an app switch doesn't keep walking.
