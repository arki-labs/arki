---
'@arki/http': minor
---

`validatePublicURL`, `safeFetchBytes` and `publicFetch` from `@arki/http/public-fetch` no longer throw for expected refusals. `validatePublicURL` and `safeFetchBytes` return `UnsafeUrl` (with a `reason`), `RedirectLimit`, `ResponseTooLarge`, `NetworkFailure`, `RequestTimeout` or `RequestCancelled`; `UnsafeUrlError` and error code `ARKI_HTTP_E430` are removed. `publicFetch` still has to resolve a `Response` or reject, so it rejects the way `fetch` does for a network error: a `TypeError` whose `cause` is the failure (a caller abort rejects with the signal's reason). The 500 envelope of an unexpected handler error now shows its message only under `NODE_ENV=development`; every other value, including `test` and an unset variable, answers `internal error`. No docs impact beyond the updated README section. No demo impact.
