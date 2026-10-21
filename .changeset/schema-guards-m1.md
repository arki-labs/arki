---
'@arki/dot': patch
'@arki/cli': patch
---

Hand-written object guards now come from `@arki/schema` (`is(value, recordSchema)` or `plainObjectSchema`), per A-39. Replaced: the `isRecord`/`isPlainObject`/`isObject` helpers in `dot`, `cli`, `http`, `expr`, `lock`, `mail`, `embeddings` (its internal `isRecord`, not a public export), `testing` and `payments`, plus inline `typeof x === 'object' && x !== null` checks on unknown values. Behaviour is the same, except that the inline checks and `lock`'s guard no longer let arrays through. `@arki/expr` and `@arki/lock` now depend on `@arki/schema`.
