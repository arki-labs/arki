# Typed validation migration

This breaking minor release makes `@arki/failure` the validation foundation. The dependency direction is `@arki/schema → @arki/failure → @standard-schema/spec` (spec types only). There is no new validator dependency.

## Parsing

`parse` and `parseAsync` return the schema output on success. Check the result before using it:

```ts run
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { parse } from '@arki/failure/schema';

function parseName(raw: unknown) {
  const name = parse(z.string(), raw);
  if (isFailure(name)) return name;
  return name.toUpperCase();
}
if (parseName('Ada') !== 'ADA') throw new Error('Expected a valid name.');
```

Import `parse` from `@arki/schema` or `@arki/failure/schema`, and `isFailure` from `@arki/failure`. `InvalidInput.data.issues` replaces `SchemaError.issues`. `AsyncSchema` replaces the synchronous parser's async-result exception. `ValidatorDefect` represents a validator throwing, rejecting, or returning an invalid Standard Schema result. Defect causes are private; public messages contain no caught exception text.

`SchemaError` and the parse-specific `SCHEMA_ERROR_CODES.asyncResult`/`validatorThrew` exports are removed. `SchemaRunError` remains for the JSON Schema bridge's unsupported target. Use `orThrow(parse(...))` only where an external callback contract requires exceptions; it throws `UnexpectedFailure` with the original failure attached. It is not an alternate parsing API.

Generic adapters can use `isSchemaFailure`/`isAsyncSchemaFailure` for the canonical validation family. `SchemaFailure` and `AsyncSchemaFailure` are inferred from the parser; do not restate their unions. Successful values that are themselves failures still follow ordinary failure-value semantics.

Declare validation failures once on a shared RPC builder with `.errors(errorMap(...SCHEMA_FAILURES))`. Import `SCHEMA_FAILURES` from `@arki/failure` and `errorMap` from `@arki/failure/orpc`. Procedures inherit the definitions, including validation failures returned by Journal commands after transport validation succeeds.

## Stored and remote failures

`revive(value, definitions)` reads both legacy versionless `{code, data}` records and version 1 envelopes. It reconstructs metadata from the local definition and ignores remote brand, status, message, remediation and cause.

| Input                            | Result                                          |
| -------------------------------- | ----------------------------------------------- |
| Unrelated value                  | `undefined`                                     |
| Valid known code and data        | The corresponding typed failure                 |
| Unknown code                     | `InvalidEnvelope`, reason `unknown_code`        |
| Invalid known data               | `InvalidEnvelope`, reason `invalid_data`        |
| Unsupported protocol version     | `InvalidEnvelope`, reason `unsupported_version` |
| Async schema in sync revival     | `AsyncSchema`                                   |
| Broken validator                 | `ValidatorDefect`                               |
| Broken local message constructor | `UnexpectedDefect`                              |

`revive(value, definitions, { onInvalid })` optionally maps only decoding failures. A valid declared canonical failure bypasses that callback, so a transport can preserve it without confusing it with its own protocol errors.

`reviveJson(text, definitions)` also returns `InvalidEnvelope` for malformed JSON. `REVIVAL_FAILURES` is the reusable definition list; `RevivalFailure` is its inferred union. `reviveRpcError` adds that same precise union for actual oRPC errors and returns `undefined` for unrelated errors.

Use `serialize(failure, definitions)` for new stored messages. Handle a returned failure before JSON encoding. A successful envelope contains only `version: 1`, `code`, and optional validated `data`; causes are never included.

Wire data must be lossless JSON and validation must leave that JSON unchanged. Non-finite numbers, negative zero, Dates, bigints, maps, sets, sparse arrays, cycles, getters and serialization hooks are rejected. A transforming domain schema cannot decode its output twice. Use a separate wire definition with JSON-safe output, then explicitly convert to the domain representation. No implicit codec migration is attempted. Legacy records with non-JSON/transformed data must be migrated to that definition before reading them with the new boundary.

`errorMap` exposes an output-only Standard Schema wrapper applying these same JSON rules. It no longer exposes the original validator object by identity. This prevents oRPC error validation from transforming already-produced failure data again.

## Consumers

Queue workers bridge failures into BullMQ/pg-boss exceptions. Journal event validation and writes carry canonical failures and reject invalid events before insertion. Mail propagates validator defects. HTTP, environment loading and third-party validation hooks retain explicit exception bridges where their foreign contract requires them; later framework tasks extend their public typed boundary families.

Invalid static `defineFailure` declarations still throw `FailureError`. Do not change definition variables into `Definition | Failure`. `UnexpectedFailure` remains the explicit Error bridge; `UnexpectedDefect` is a separate returned failure definition.
