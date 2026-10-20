---
"@arki/http": minor
---

Infer nominal request and idempotency owner IDs from canonical declarations.
Return precise generation failures before protected work, admit framework
request failures in typed clients, and add default request/idempotency OTel spans.

ResponseCache owner fixtures must use idempotencyOwnerId.schema. Keep the whole
IDEMPOTENCY_FAILURES tuple on protected routes; it now includes generation
failures. Stored/header strings are unchanged. See docs/upgrade-identities.md.
