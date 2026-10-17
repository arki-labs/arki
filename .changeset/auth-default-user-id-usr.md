---
'@arki/auth': minor
---

`defineAuthBackend`'s default `generateId` now gives users a `usr_` id from the package's own user id factory (`createUserId`, the `UserId` of `@arki/contracts`). It used to give `user_<hex>`, which no `userIdSchema` accepts. Every other model keeps `<model>_<hex>`. Apps that pass their own `generateId` are unchanged; existing `user_` rows need a data migration to the `usr_` prefix.
