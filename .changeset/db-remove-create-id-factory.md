---
'@arki/db': minor
'@arki/dot': patch
---

Removed `createIdFactory` from `@arki/db`. Its id type came from the prefix alone, so two kinds with the same prefix were interchangeable. Migration: declare the id with `defineId(prefix)` from `@arki/contracts` and get its columns with `idColumns(declaration)` from `@arki/db/id`. Replace `make()` and `new()` with `create()`. `createId` and `createPrefixedId` stay. The `dot new` stack template now declares its note id this way and adds `@arki/contracts` to the generated `package.json`.
