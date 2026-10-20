---
"@arki/http": minor
---

Return precise HTTP idempotency preparation failures before cache acquisition or application execution. Scope callbacks can return inferred canonical failures; every protected route must declare them alongside the complete IDEMPOTENCY_FAILURES tuple.

Unreadable request bodies, unavailable SHA-256 and observed cancellation have distinct outcomes. Thrown scopes and broken hashing providers become supervised defects with private causes. Key and fingerprint bytes remain compatible. See docs/upgrade-idempotency.md.
