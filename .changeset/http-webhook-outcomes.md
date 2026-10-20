---
"@arki/http": minor
"@arki/payments": patch
"@arki/journal": patch
---

Return exact canonical webhook signing, verification and request-preparation
failures, supervise Web Crypto and add safe default tracing. Declare
WEBHOOK_FAILURES on protected HTTP routes and narrow direct results before
accepting a delivery. Payments fails closed on returned verification failures;
the Journal inbox declares the new contract and outbound delivery returns signing failures without sending or acknowledging jobs. Returned signing failures need an explicit backoff retry predicate.
