---
'jarvis': patch
---

The rail's red count badge (the Faults panel's devices in fault) has a darker fill, a new `--jv-bad-fill` token, so its
white number meets WCAG AA contrast (5.2:1; it was 3.4:1 on `--jv-bad`, which is unchanged). The neutral badge's fill
is a token too, `--jv-badge-fill`.
