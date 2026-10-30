---
"@arki/http": minor
---

`storedResponse` is now typed as a Standard Schema, not a Zod object, so `@arki/http/idempotency` no longer exposes Zod. `parse(storedResponse, value)` from `@arki/schema` works as before. Calling Zod methods on it (`storedResponse.parse(value)`, `.safeParse`) no longer compiles. `StoredResponse` is the same shape, now written as a plain type that an exact type test locks to the schema.

No demo impact: the only uses in the monorepo go through `parse(storedResponse, value)`.
