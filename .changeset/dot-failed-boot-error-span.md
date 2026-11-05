---
"@arki/dot": patch
---

A failed boot now always marks the `dot.app.boot` and `dot.app.start` spans and the `dot.unit.boot` and `dot.unit.start` spans as errors, whatever the status of the returned failure. Before, a 4xx failure such as a refused start left the status unset, so a failed boot looked healthy in traces. The `failure.code` attribute is still set. Every other Dot span keeps the rule that only a fault (status 500 or higher) is an error.
