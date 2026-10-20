# Typed ID generation

`defineId(prefix).create()` now returns the unchanged ID string or an exact
`IdGenerationFailure`. `RandomSourceUnavailable` means the runtime has no usable
Web Crypto provider. `UnexpectedDefect` reports a broken provider with a private
cause. Both definitions come from `ID_GENERATION_FAILURES`.

1. Narrow with `isFailure` before interpolation, storage or further work. Native
   handlers return the failure and declare `ID_GENERATION_FAILURES` in their
   existing failure/error map. Do not wrap public generators in `orThrow`.
2. Derive stored ID types from `IdOf<typeof declaration>` or
   `z.output<typeof declaration.schema>`. `ReturnType<typeof declaration.create>`
   now includes failures and is inappropriate for an ID field.
3. Auth's four ID generators forward the same exact outcomes. Auth schemas still
   accept plain strings and return their precise prefixed ID.
4. `idColumns` bridges only at Drizzle's foreign string callback. Owned DB
   transactions restore admitted canonical failures, roll back, and return the
   original object without retrying it. `TRANSACTION_FAILURES` includes the ID
   definitions.
5. FS `createUpload` returns an ID failure before inserting or signing.
   `CREATE_UPLOAD_FAILURES` drives both its return type and native RPC map.
6. Test fixture setup can use `orThrow` to fail the test immediately. Runtime
   code must propagate or handle the failure at its owning boundary.

Prefixes and successful ID format do not change. Sampling uses Web Crypto only;
there is no `Math.random` fallback. Providers must implement the synchronous
Web Crypto buffer protocol. Broken output, rejected asynchronous output and
exhausted rejection sampling return a defect instead of yielding partial IDs.

Legacy DB `createId`, `createPrefixedId` and `createIdFactory` have not migrated
in this slice. Their duplicate implementations and consumer graph remain T08
work. The framework migration is still active.
