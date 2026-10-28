---
'@arki/async': minor
'@arki/ai': minor
'@arki/clock': patch
---

Return canonical owned cancellation, deadline and provider/callback defect outcomes from async waits and concurrency. Preserve fulfilled Failure elements, heterogeneous result inference, joined work and late settlement observation; contain foreign scope-listener failures. Add default operation telemetry without changing callback execution or exposing private causes. Retire migrated exception-only exports and update callers and runtime examples. AI Flow propagates retry-wait defects unchanged; Clock docs clarify its existing supervised sleep contract.

no demo impact: public examples and runtime smoke checks cover the changed behaviour; no separate demo application exists.
