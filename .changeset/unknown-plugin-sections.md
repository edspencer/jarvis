---
'jarvis': minor
---

A `plugins.<id>` section this build doesn't have is now a warning, not an error: the viewer skips that plugin, says so
once in the console ("site config for plugin 'x', which this build doesn't have: skipped", with a "did you mean" for a
near miss) and loads the rest, so a site written for a newer viewer no longer stops an older one at the loading screen.
`npm run validate-site` reports it the same way. A typo inside a known plugin's section is still an error.
