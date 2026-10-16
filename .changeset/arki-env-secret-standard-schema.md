---
'@arki/env': minor
---

`secret()` takes any Standard Schema (zod, valibot, arktype, hand-written) and returns a Standard Schema, not a zod schema. `.optional()` is still there: it accepts a missing variable and leaves `undefined` unwrapped. The result no longer has zod methods such as `.parse`; use `secret(schema)['~standard'].validate(value)`.

A rejected secret's issues keep their path but get a fixed message, because some validators (valibot) repeat the received value in theirs and `defineEnv` logs issues.
