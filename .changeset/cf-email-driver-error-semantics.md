---
'@arki/emails': minor
---

Cloudflare Email Service driver error-semantics hardening: a send where every
recipient permanently bounced (nothing delivered or queued) now returns an
error (`CloudflareEmailServicePermanentBounce`) instead of a success with a
synthetic empty id; a partial bounce (≥1 delivered/queued) remains a success
and is now a documented contract; an HTTP error status with a parseable CF
error body now surfaces the CF error message + code (e.g. `code=10004`
rate-limit) instead of the bare `HTTP <status>`, so callers can classify
retryability.
