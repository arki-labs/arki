---
'@arki/admin': minor
---

Foreman protocol 2. `@arki/admin/server` adds `createForemanHandler`: Ed25519-signed envelopes (`aud`, `iat`, nonce, method, path, body hash, scopes, and a permit with the pinned `schemaHash` on executes), separate read and execute key rings with `*_NEXT` rotation overlap, a 60 s clock-skew window, replay protection through any `NonceStore` (an `@arki/kv` `KV` fits), scope checks, and an explicit `writes: 'off'` that refuses every execute. Every response carries a proof signed by the app's identity key. The new `@arki/admin/client` entry adds `createForemanClient` (signs calls, verifies each response proves the expected target, negotiates protocol 1 or 2), `signRequest` and `generateForemanKeyPair`. Protocol 1 (`/api/fleet`) is unchanged. New error codes `ARKI_ADMIN_E007`–`E016`.
