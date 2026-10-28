---
"@arki/resilience": minor
"@arki/embeddings": patch
"@arki/http": patch
"@arki/db": patch
---

Return canonical retry cancellation before dispatch and after cancelled rejected work, preserving completed outcomes and actual clock failure identity. Propagate the exact inferred RetryFailure union through helpers, composition and Dot; update Embeddings and HTTP policy types, Avocabo's injected policy type, RPC failure declarations and application template guidance. DB maps retry cancellation to its existing TransactionCancelled; Games Platform persists it as cancellation.

no demo impact: no demo declares the narrower retry-wait outcome type; application failure admission is migrated. Embeddings changes only its existing optional policy type/schema binding.
