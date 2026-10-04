---
'jarvis': patch
---

Safer plugin plumbing. A plugin's own SVG icon now goes through an allowlist: the HUD rebuilds it from drawing
elements and presentation attributes, and drops scripts, event handlers, styles, links, `<use>` and animation. A
`store.call()` across several connectors now checks every connector's refusal before it sends anything, so a refusal
can't leave the action half done. Each `<jv-blocks>` element now keeps its own expanded and collapsed state.
