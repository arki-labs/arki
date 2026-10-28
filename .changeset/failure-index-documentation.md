---
"@arki/failure": patch
"@arki/schedule": patch
"@arki/queue": patch
"@arki/embeddings": patch
"@arki/offline": patch
"@arki/journal": patch
---

Complete public error summaries and remediation metadata. The source error index now follows canonical factory aliases, checks duplicate original codes across packages, and enforces documentation for private libraries too. Runtime behavior and failure data are unchanged.

No demo impact: this changes error documentation and repository checks only.
