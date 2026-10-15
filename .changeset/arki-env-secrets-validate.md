---
'@arki/env': minor
---

**Validation now runs in production by default.** `defineEnv` used to skip validation whenever `NODE_ENV !== 'development'`, so an app without an explicit `skipValidation` booted production on an unchecked config. The default now skips only when `CI` is set (Docker build stages) or during `lint` runs, the same rule most apps already passed by hand. Apps that set `options.skipValidation` are unaffected.

New `secret(schema)`, `reveal(value)` and `Redacted` (from `@arki/env/core`): a secret variable becomes a `Redacted` value that prints as `[redacted]` in logs, JSON, template strings and `util.inspect`, and is read with a deliberate `reveal(env.KEY)`. `reveal` also accepts the raw string, for runs where validation is skipped.
