---
'@arki/live': patch
---

`@arki/live` now runs on Hermes (React Native). Hermes cannot compile async generators, so the client's SSE reader, the hub's stream feed and the endpoint's frame stream are now plain async iterators. They behave as before: calls run one at a time, and a stream that ends early (a last frame, an error, `return()` or `break`) still releases its body reader, its hub slot and its listeners. One small fix: a stream returned before it was ever read now cleans up too. No API change.

no demo impact: internal iterator rewrite, no API change
