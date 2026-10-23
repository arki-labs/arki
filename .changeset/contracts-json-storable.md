---
'@arki/contracts': minor
---

`@arki/contracts/drizzle` exports `JsonStorableSchema` and `jsonStorageSchema`: the schema rule `jsonColumn` requires and the refined schema it stamps on the column. `@arki/db`'s column kit uses the same pair for `c.json(name, schema)`, so insert and select schemas check kit JSON columns exactly as they check `jsonColumn`.
