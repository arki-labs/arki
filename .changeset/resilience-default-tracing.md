---
"@arki/resilience": patch
---

Trace owned logical policy calls, retry attempts/waits, circuit breaker, timeout and bulkhead execution by default. Preserve raw fallback provenance, precise outcomes and async caller context. Broken telemetry cannot repeat work, hide refusal or block settlement. Applications configure the SDK; no payloads or exception messages are recorded.

Docs describe span ownership and safe attributes. No demo impact: existing policy consumers receive instrumentation without API changes.
