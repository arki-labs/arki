# @arki/schema

Standard Schema types, validation execution, issue helpers and a JSON Schema bridge. Bring Zod, Valibot, ArkType or your own validator. Execution is shared with `@arki/failure/schema`; the dependency graph is schema → failure → Standard Schema spec types.

## Install

```sh
bun add @arki/schema @arki/failure
```

## Quick start

`parse` returns the schema output or a canonical failure. Narrow the result before using its value.

```ts run
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { parse } from '@arki/schema';

const age = parse(z.string().transform(Number), '42');
if (isFailure(age)) throw new Error(age.message);
const output: number = age;
if (output !== 42) throw new Error('unexpected output');
```

For a form adapter that reports field errors:

```ts from="examples/signup.ts#field-errors"
import * as v from 'valibot';

import { InvalidInput, orThrow } from '@arki/failure';
import { parse, pathOf } from '@arki/schema';

const Signup = v.object({ name: v.string(), age: v.number() });

/** Turn invalid form input into field messages; schema defects cross this throwing form adapter explicitly. */
export function fieldErrors(input: unknown): Record<string, string> {
  const result = parse(Signup, input);
  if (!InvalidInput.is(result)) {
    orThrow(result);
    return {};
  }
  const errors: Record<string, string> = {};
  for (const issue of result.data.issues) errors[pathOf(issue).map(String).join('.')] = issue.message;
  return errors;
}
```

## Async validation

`parseAsync` resolves to output or `InvalidInput` / `ValidatorDefect`. `parse` additionally returns `AsyncSchema` when a validator requires awaiting. Rejected promises received by sync parsing are observed.

```ts run
import { z } from 'zod';

import { AsyncSchema, isFailure } from '@arki/failure';
import { parse, parseAsync } from '@arki/schema';

const Handle = z.string().refine(value => Promise.resolve(value.length > 2));
if (!AsyncSchema.is(parse(Handle, 'ada'))) throw new Error('expected async mismatch');
const handle = await parseAsync(Handle, 'ada');
if (isFailure(handle)) throw new Error(handle.message);
if (handle !== 'ada') throw new Error('unexpected handle');
```

## Failure behavior

| Result                    | Meaning                                       | Handle with                                          |
| ------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| Output                    | Validated, possibly transformed value         | Use after narrowing                                  |
| `schema.invalid_input`    | Invalid data                                  | `InvalidInput.is(result)`; read `result.data.issues` |
| `schema.async_required`   | Sync parse received async validation          | Use `parseAsync`                                     |
| `schema.validator_defect` | Schema access, invocation or rejection failed | Fix the validator; never map to HTTP 400             |

Definitions are exported from `@arki/failure`. Their `.is` guards work across package copies. `orThrow(result)` explicitly bridges into a foreign throwing API through `UnexpectedFailure`; parsing itself returns failures.

## Throwing channel: `is`, `assert`, `ensure`

`parse` is for expected failure: bad user data is returned. `assert` and `ensure` are for bugs: a value the code already trusted is wrong, so they throw `AssertError` (`ARKI_SCHEMA_E004`). Both report the same issues.

- `is(value, schema)` is a guard. A rejection is `false`.
- `assert(value, schema, options?)` narrows the variable to the schema's input type. It never transforms.
- `ensure(value, schema, options?)` returns the schema's output: a throwing `parse`.
- `options.at` labels the value (`"PORT"`). `options.message` is a string or a function built only on failure.

The error message lists the issues with paths. It never contains the value, because asserted values are often secrets: the offending value is redacted out of each issue message. An async schema throws `ARKI_SCHEMA_E005` at once. `is` throws too, because `false` would silently mean "invalid" for data that may be fine.

```ts run
import { z } from 'zod';

import { AssertError, ensure } from '@arki/schema';

const port = ensure('8080', z.coerce.number(), { at: 'PORT' });
if (port !== 8080) throw new Error('unexpected port');
try {
  ensure('x', z.coerce.number().int(), { at: 'PORT' });
} catch (error) {
  if (!(error instanceof AssertError)) throw error;
}
```

Every check of an unknown value is a schema. `recordSchema` accepts a non-null object that is not an array. `plainObjectSchema` also needs an `Object.prototype` or `null` prototype, so class instances and dates are out. Use them as `is(value, recordSchema)` or `assert(value, plainObjectSchema)`; each failure is one fixed issue with no value in it.

## JSON Schema

`withJsonSchema(schema, input, output?)` wraps a schema with JSON Schema converters. The output description defaults to input. The wrapper preserves validation receiver binding and answers only `draft-2020-12`; another target throws `SchemaRunError` with `ARKI_SCHEMA_E003`. This converter error is separate from validation failures.

```ts run
import * as v from 'valibot';

import { hasJsonSchema, parse, withJsonSchema } from '@arki/schema';

const Name = withJsonSchema(v.string(), { type: 'string' });
if (!hasJsonSchema(Name)) throw new Error('expected JSON Schema');
if (parse(Name, 'Ada') !== 'Ada') throw new Error('validation changed');
```

## API

| Export                                                       | Purpose                                  |
| ------------------------------------------------------------ | ---------------------------------------- |
| `StandardSchemaV1`, `StandardJSONSchemaV1`                   | Canonical spec types                     |
| `SchemaInput<S>`, `SchemaOutput<S>`                          | Infer input and output                   |
| `SchemaWithJson<I, O>`                                       | Validation and JSON Schema in one schema |
| `parse`, `parseAsync`                                        | Output or exact canonical failures       |
| `is`, `assert`, `ensure`, `AssertOptions`                    | Throwing channel for bugs                |
| `AssertError`, `AssertErrorCode`                             | Coded error with `issues`; no raw value  |
| `recordSchema`, `plainObjectSchema`                          | Object-shape checks as schemas           |
| `pathOf(issue)`                                              | Path as plain keys                       |
| `formatIssues(issues)`                                       | All issue messages with paths            |
| `isStandardSchema(value)`                                    | Recognize object and callable schemas    |
| `hasJsonSchema(schema)`                                      | Narrow to a schema with converters       |
| `withJsonSchema`                                             | Add draft-2020-12 converters             |
| `SchemaRunError`, `SCHEMA_ERROR_CODES`, `SchemaRunErrorCode` | Unsupported JSON Schema target error     |

## Runtime support

No Node or Bun built-ins are used. The table records the previous smoke run; rerun `test:runtimes` after building to verify the current tree.

<!-- runtimes:start -->

| Runtime | Result  | Version tested        | Date (UTC) |
| ------- | ------- | --------------------- | ---------- |
| node    | pass    | v26.11.1              | 2026-10-17 |
| bun     | pass    | 1.4.2                 | 2026-10-17 |
| deno    | pass    | 2.9.7                 | 2026-10-17 |
| browser | pass    | Chromium 156.0.8078.4 | 2026-10-17 |
| hermes  | not run | -                     | 2026-10-17 |

<!-- runtimes:end -->

## Limits

- This package executes validators; it does not define one.
- Sync `parse` cannot await async checks.
- JSON Schema converters only support draft-2020-12.
- The wrapper keeps Standard Schema behavior, not the original validator's extra methods.
- Capability predicates return `false` for inaccessible or malformed protocols. They observe native promises with usable constructor/species hooks once, without awaiting them or invoking arbitrary `then` accessors. A provider that blocks handler registration retains responsibility for its own rejection.
- `pathOf` returns keys, so a field name containing a dot remains one segment.

## Documentation

- [Agent guide](docs/agent-guide.md)
- [llms.txt](llms.txt)
- [Changelog](CHANGELOG.md)
