---
'@arki/schedule': minor
---

New entry `@arki/schedule/orpc`: serve feature schedules as one oRPC cron contract (RFC `docs/rfcs/2026-10-15-dot-feature-builder-cron.md`).

- `cronContract(specs)`: one `POST /<name>` procedure per schedule; you write the name and its 200 body schema (or `{ body, skipped }` for a legacy lock-held body).
- `cronRouter(os, contract, features, policy)`: a compile error when a name is not a schedule of any feature, or when a body schema is not exactly the run's value and no `respond` maps it.
- Replies `ok`, `fail`, `rethrow`, `skipped`; `cronErrorBody` for `OpenAPIHandler`, so an error answers exactly the policy's body; `validated(schema)` checks a value but keeps the original (key order included).
- Optional peers `@orpc/contract` and `@orpc/server`. No `node:` import.
