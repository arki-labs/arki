---
"@arki/resilience": patch
---

Emit default bounded completion/duration metrics and circuit-breaker transition counts/events using the application's OpenTelemetry provider. Preserve exact outcomes, synchronous dispatch and single execution under broken reporting; no library SDK setup. Document overlapping durations and best-effort reporting.

No demo impact: existing standalone and Dot policies gain telemetry without call-site changes.
