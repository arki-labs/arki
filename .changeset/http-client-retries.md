---
'@arki/http': minor
---

The typed client retries and times out. `createClient` takes `policy` (any `@arki/resilience` policy without a fallback), `retryOn` (default `retryTransient`: network failures and 408/429/502/503/504, only for GET, HEAD, OPTIONS, PUT, DELETE or a request with an `idempotency-key`) and `timeoutMs` (throws `HttpError` 408, new code `ARKI_HTTP_E408`). Only what `retryOn` accepts goes back into the policy, so a POST is never sent twice by accident. `@arki/http/public-fetch` adds `publicFetch()`, the DNS-pinned SSRF guard as a `fetch` for the client, with a `timeoutMs` deadline (default 30 s); `safeFetchBytes` now shares its code, and a timeout during DNS rejects with the signal's reason instead of `Fetch timed out.`.
