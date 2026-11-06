---
"@arki/http": minor
---

A thrown `HttpError` with a status below 500 no longer sets error status on its span. It still records `failure.code`. This matches returned failures: only a fault (status 500 or higher) is an error, so an expected refusal such as an `http.idempotency` reused key (422) or a cancelled request (499) does not page anyone. A thrown 5xx `HttpError` and any other throw still set error status.

Docs: README `## Observability`.
