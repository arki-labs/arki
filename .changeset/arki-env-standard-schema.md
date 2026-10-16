---
'@arki/env': minor
---

`defineEnv()` `server`, `client` and `shared` take records of any Standard Schema (Zod, Valibot, ArkType, hand-written), not only `ZodType`; values are typed as each schema's output.
`@arki/env/dot`: `EnvDotOptions`, `EnvServices` and `env()` take `Record<string, StandardSchemaV1>` instead of `Record<string, ZodType>`.
