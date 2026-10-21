---
'@arki/contracts': minor
---

`defineId(...)` default ids (and `createIdBody`, so `@arki/db`'s `createId` / `createPrefixedId` too) are cuid2 ids, generated with `@paralleldrive/cuid2`: 24 characters, a letter first, then letters and digits, a SHA3 of time, a counter, a host fingerprint and random salt. The shape is unchanged (today's ids already passed `isCuid`), so stored ids and schemas keep working. Every random bit still comes from Web Crypto, resolved per generation: an unusable provider answers `RandomSourceUnavailable`, a provider that breaks the protocol answers `UnexpectedDefect`. Rejection sampling is gone with the old construction. A cuid2 costs about 100 µs on Bun and Node, so it is for entity identities; `format: 'uuid'` (used by `@arki/http`'s `requestId`) is unchanged and stays under a microsecond.
