---
'@arki/journal': minor
---

A feature mounted twice with `feature.instance('eu', rebind)` now gets its own journal effects and taps. Their names carry the instance (`send-on-request#eu`), and so do the effect action ids (`send-on-request#eu.run`) and the stored job rows. Each instance runs with its own rebound needs, and two instances no longer trip the duplicate-name check. A plain feature keeps its names exactly as before.
