---
"@arki/lock": minor
"@arki/schedule": minor
---

Return canonical lock cancellation, backend, ownership-loss and release outcomes; preserve callback failure identity and supervise defects without replay. Add nominal resource/owner/fence identities, schema restoration, and default OpenTelemetry spans and bounded counters. Named stores, DDL and disposal own their operational failures. Schedule admits the exact canonical lock union and never treats provider failure as contention. Immediate application consumers propagate outcomes; native RPC and disposal protocols retain explicit typed bridges.

Breaking: branch all failures before using a callback or guard result; parse low-level keys, owner tokens and fences through `@arki/lock/zod`. Manual release and extension return failures; successful-callback cleanup preserves the completed result and reports uncertainty. Leadership stops on callback failure, defect or lost ownership. Existing key bytes, fencing and late-grant return remain unchanged.

Docs and examples describe the changed behavior. No demo impact: this package has no standalone demo application.
