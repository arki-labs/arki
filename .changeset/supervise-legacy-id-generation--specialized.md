---
'@arki/payments': minor
---

Share bounded Web Crypto generation across modern and legacy IDs. Legacy
`createId`, `createPrefixedId`, and factory `create`/`make`/`new` now return exact
canonical generation failures. Preserve stored formats and prefixes, including
legacy empty and punctuation prefixes, while removing the Cuid2 fallback to
`Math.random`. Infer stored types from the successful schema and handle failures
before side effects or string interpolation.

Modern declarations use `defineId` with `IdOf` inferred from the canonical schema.
Payment ID factory exports become browser-safe declarations; use `idColumns`
for their table helpers. Payment provider creates and billing persistence return
generation failures; webhook adapters must check these before acknowledgement.
AI tombstone columns use modern declarations. Flow stops on returned failures;
use `createFlow<State, Context>()(config)` to infer the exact node failure union.
Ordinary patches cannot disguise a canonical failure through structural typing.
