---
'@arki/admin': minor
---

Expected outcomes of the signed protocol and the Coolify API are returned `@arki/failure` failures, not thrown `AdminError`s. `createForemanClient` calls (`negotiate`, `manifest`, `read`, `preview`, `execute`), `createCoolifyClient`, `createCoolifyEnvWriter`, `confirmHint` and `parseWebhookHint` return the value or an `Admin*` failure (see the Failures section of the README); the dispatcher builds its wire answers from the same failures and keeps the stable `ARKI_ADMIN_E0NN` wire codes. `fetchFleetSnapshot` returns `{ ok: false, failure }` instead of `{ ok: false, error: string }`. `createFleetHandler` no longer puts the provider's error message or the schema issues on the wire: `502 { error: "snapshot_failed" }` and `500 { error: "invalid_snapshot" }`. `AdminError` is thrown for bugs only. Docs: README updated.
