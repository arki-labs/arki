---
"@arki/auth": minor
---

Preserve completed authentication when event correlation ID generation fails. Correlation IDs use the canonical branded AuthRequestId type, keep inbound header values unchanged, and report exact generation failures while omitting only the correlated event. Add safe default OpenTelemetry spans for HTTP authentication, principal reads, native sign-in, and observers without configuring an SDK.
