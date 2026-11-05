# Move legacy IDs to modern declarations

`createId` and `createPrefixedId` now
return their successful value or `IdGenerationFailure`, derived from the
`ID_GENERATION_FAILURES` definitions in `@arki/contracts`.

Both DB entry points share one implementation. Modern and legacy generation use
the same bounded Web Crypto sampler. Missing entropy returns
`RandomSourceUnavailable`; provider faults return `UnexpectedDefect` with a
private cause. The former Cuid2 implementation could capture a `Math.random`
fallback at import time. That fallback is gone.

Stored values do not need conversion. Prefixes are concatenated exactly as
supplied, without adding an underscore; legacy empty and punctuation prefixes
still work. New bodies retain 24 lowercase alphanumeric characters beginning
with a letter. Existing prefix-only validation is unchanged. The random
generation algorithm changes; deterministic Cuid2 sequences are not preserved.

Check generation before interpolation, insertion, signing, network requests or
counter updates:

```ts
import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';
import { idColumns } from '@arki/db/id';
import { isFailure } from '@arki/failure';

const recordId = defineId('record_');
type RecordId = IdOf<typeof recordId>;
const recordColumns = idColumns(recordId);
// Use recordColumns.primaryColumn() in the table definition.

function prepareRecord() {
  const id = recordId.create();
  if (isFailure(id)) return id;
  return { id };
}
```

`createIdFactory` is removed. Replace `createIdFactory(prefix)` with `defineId(prefix)` from `@arki/contracts`. Put the declaration in a browser-safe module and apply `idColumns(declaration)` only in server table modules. Declarations expose `prefix`, `schema`, `create` and `is`; replace `make()` and `new()` with `create()`, and the factory's column helpers with `idColumns(declaration)`.

Infer successful types from `IdOf<typeof recordId>`. A generator's
`ReturnType` now includes failures and must not be used as a stored ID type.
Forward failures unchanged and declare `ID_GENERATION_FAILURES` in an owning
transport's error map. Never interpolate a fallible call: JavaScript can turn
a failure into an apparent string ID.

Drizzle requires scalar defaults. The `idColumns` helpers bridge only at
that foreign callback; raw inserts can reject with `UnexpectedFailure`.
`runTransaction`, `runTransactionOnce` and `createUnitOfWork` roll back and
restore declared generation failures by identity. Callers using other insertion
boundaries must own that bridge explicitly.

A prefix alone does not separate two kinds that share it. Give such kinds a
`kind` (`defineId('id_', { kind: 'billing.refund' })`); do not claim raw
`string` or a renamed string alias is a branded ID.
