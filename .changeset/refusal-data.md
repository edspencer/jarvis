---
'jarvis': patch
---

A connector's `refusal(ids, action, data)` now gets the call's data. Home Assistant's connector now refuses up front for
everything its `call()` would refuse, data keys included, so a `store.call()` across connectors is never half sent
because of bad data. A plugin icon that the sanitiser strips completely now shows the default icon instead of nothing.
