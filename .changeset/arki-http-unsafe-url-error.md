---
'@arki/http': minor
---

The SSRF guard in `@arki/http/public-fetch` now throws `UnsafeUrlError` (code `ARKI_HTTP_E430`, with a `remediation`) for every URL it refuses: not http(s), not a URL, refused credentials, or a private, loopback or link-local address, whether typed, in the DNS answer, or behind a redirect. `safeFetchBytes`, `publicFetch` and `validatePublicURL` all throw it, and it is exported from `@arki/http/public-fetch` and the root entry. A refused URL is refused every time, so a caller can now tell it apart from a network failure and not retry it. Network failures, the size limit and the redirect limit keep throwing what they threw before. Messages are unchanged.
