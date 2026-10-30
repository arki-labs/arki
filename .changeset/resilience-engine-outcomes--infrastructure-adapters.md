---
"@arki/http": minor
"@arki/db": patch
---

Return exact canonical engine refusals and final defects while preserving raw throw retry/fallback provenance. Remove obsolete operational error classes and guards; preserve static backoff diagnostics. Capture timeout/caller cancellation before observation. Infer heterogeneous policy unions.

Migrate HTTP response/network mapping, DB exhausted SQLSTATE conflicts, Embeddings defect admission and RPC consumers together. See the Resilience 0.2.0-to-0.3.0 upgrade guide. No demo impact: the affected app callers and generator admission guidance are migrated in place.
