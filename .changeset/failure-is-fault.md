---
'@arki/failure': minor
---

New `isFault(failure)`. It is true when a returned failure is something an operator must act on: its `status` is 500 or higher, such as a provider outage, a wrong setting or `UnexpectedDefect`. It is false for outcomes the caller handles, such as a declined card or a missing record (4xx). A definition with no `status` defaults to 400, so it is not a fault. Telemetry code can always record `failure.code` and mark a span as an error only when `isFault(failure)` is true.
