---
"@arki/resilience": minor
---

Supervise policy event observers so synchronous throws, rejected promises and pending reporting cannot retry completed work, replace results, corrupt breaker accounting or block timeout settlement. Preserve synchronous cancellation requests and observe asynchronous logger returns. Default logger and Dot diagnostics now contain canonical failure codes instead of private callback messages or payloads.

Move required effects and control decisions from observers into the operation callback or explicit backoff predicate. See `docs/upgrades/0.2.0-to-0.3.0.md`. No demo impact: existing demos do not rely on observer exceptions or private error-message logging. Public operation failure unions and remaining engine throw bridges are unchanged.
