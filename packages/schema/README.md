# @arki/schema

Standard Schema for every validator. It holds the [Standard Schema](https://standardschema.dev) types, a sync `parse` and an async `parseAsync` that return the schema's output or throw a coded error, helpers that read issue paths the same way for every validator, and a bridge that gives any schema a JSON Schema. It works with Zod, Valibot, ArkType or a hand-written schema, and has one dependency: the spec's types.

Two errors, kept apart on purpose: `SchemaError` means the **data** is wrong. `SchemaRunError` means the **schema** could not be run (it is async, it threw, or it was asked for a JSON Schema target it does not have). Never answer a `SchemaRunError` with a 400.

## Install

```sh
bun add @arki/schema
```

## Quick start

`parse` returns the schema's output type, not its input type.

```ts run
import { z } from 'zod';

import { parse } from '@arki/schema';

const Age = z.string().transform(text => Number(text));
const age: number = parse(Age, '42');
if (age !== 42) throw new Error(`unexpected age: ${age}`);
```

For bad form input, turn the error into one message per field:

```ts from="examples/signup.ts#field-errors"
import * as v from 'valibot';

import { parse, pathOf, SchemaError } from '@arki/schema';

const Signup = v.object({ name: v.string(), age: v.number() });

/** Turn bad form input into one message per field. A broken schema is not bad data, so it passes through. */
export function fieldErrors(input: unknown): Record<string, string> {
  try {
    parse(Signup, input);
    return {};
  } catch (error) {
    if (!(error instanceof SchemaError)) throw error;
    const errors: Record<string, string> = {};
    for (const issue of error.issues) errors[pathOf(issue).map(String).join('.')] = issue.message;
    return errors;
  }
}
```

## When not to use this

- **To validate.** This package runs a schema; it does not define one. Bring Zod, Valibot, ArkType or your own.
- **When one validator is enough.** If your code only ever uses Zod, `schema.parse` is shorter. This package pays off when a library must accept any validator.
- **For JSON Schema other than draft 2020-12.** The bridge answers that one target only.

## Runtime support

The package uses no Node or Bun built-ins. It runs in Node, Bun, Deno and browsers, checked by `test:runtimes`. Hermes needs `HERMES_BIN` and has no row until a run records one.

<!-- runtimes:start -->

| Runtime | Result  | Version tested        | Date (UTC) |
| ------- | ------- | --------------------- | ---------- |
| node    | pass    | v26.11.1              | 2026-10-17 |
| bun     | pass    | 1.4.2                 | 2026-10-17 |
| deno    | pass    | 2.9.7                 | 2026-10-17 |
| browser | pass    | Chromium 156.0.8078.4 | 2026-10-17 |
| hermes  | not run | -                     | 2026-10-17 |

<!-- runtimes:end -->

## Public imports

- `@arki/schema`: the only entry. Everything in the API table below.

## Parse with an async schema

A schema with an async check makes `parse` throw `ARKI_SCHEMA_E001`. Use `parseAsync`, which awaits it. `parseAsync` always rejects and never throws.

```ts run
import { z } from 'zod';

import { parse, parseAsync, SCHEMA_ERROR_CODES, SchemaRunError } from '@arki/schema';

const Handle = z.string().refine(handle => Promise.resolve(handle.length > 2));

try {
  parse(Handle, 'ada');
  throw new Error('expected parse to refuse an async schema');
} catch (error) {
  if (!(error instanceof SchemaRunError) || error.code !== SCHEMA_ERROR_CODES.asyncResult) throw error;
}

const handle = await parseAsync(Handle, 'ada');
if (handle !== 'ada') throw new Error(`unexpected handle: ${handle}`);
```

## Read what is wrong

Bad data throws `SchemaError`. Its `issues` are the schema's own issues; its message is `formatIssues(issues)`. `pathOf` gives an issue's path as plain keys, whatever form the validator used.

```ts run
import * as v from 'valibot';

import { formatIssues, parse, pathOf, SchemaError } from '@arki/schema';

const User = v.object({ user: v.object({ age: v.number() }) });

try {
  parse(User, { user: { age: 'old' } });
  throw new Error('expected a SchemaError');
} catch (error) {
  if (!(error instanceof SchemaError)) throw error;
  const [issue] = error.issues;
  if (issue === undefined || pathOf(issue).join('.') !== 'user.age') throw new Error('unexpected path');
  if (error.message !== formatIssues(error.issues)) throw new Error('unexpected message');
}
```

## Give a schema a JSON Schema

Some validators cannot describe themselves as JSON Schema. `withJsonSchema` returns a new schema that validates like the original and answers the `draft-2020-12` target (the one OpenAPI 3.1 uses) with the JSON Schema you give. Any other target throws `ARKI_SCHEMA_E003`.

```ts run
import * as v from 'valibot';

import { hasJsonSchema, parse, withJsonSchema } from '@arki/schema';

const Name = withJsonSchema(v.pipe(v.string(), v.minLength(1)), { type: 'string', minLength: 1 });

if (!hasJsonSchema(Name)) throw new Error('expected a JSON Schema');
const json = Name['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
if (json['type'] !== 'string') throw new Error('unexpected JSON Schema');
if (parse(Name, 'Ada') !== 'Ada') throw new Error('validation changed');
```

## API

| Export                                                       | What it does                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `StandardSchemaV1`, `StandardJSONSchemaV1`                   | The spec types, re-exported with their namespaces (`StandardSchemaV1.Issue`, …). Import them from here. |
| `SchemaInput<S>`, `SchemaOutput<S>`                          | The type a schema accepts, and the type it returns.                                                     |
| `SchemaWithJson<I, O>`                                       | A Standard Schema that also has `~standard.jsonSchema`.                                                 |
| `parse(schema, value)`                                       | The output, or throws `SchemaError` / `SchemaRunError`. Sync schemas only.                              |
| `parseAsync(schema, value)`                                  | The output as a promise. Sync and async schemas. Never throws synchronously.                            |
| `SchemaError`                                                | Bad data. `issues` holds the schema's issues.                                                           |
| `SchemaRunError`, `SCHEMA_ERROR_CODES`, `SchemaRunErrorCode` | The schema could not be run. Coded, with a `remediation`.                                               |
| `pathOf(issue)`                                              | The issue's path as plain keys; `[]` for the whole value.                                               |
| `formatIssues(issues)`                                       | `"a.0.b: message; message"`.                                                                            |
| `isStandardSchema(value)`                                    | True for a Standard Schema v1, callable ones included.                                                  |
| `hasJsonSchema(schema)`                                      | True when the schema can describe itself as JSON Schema.                                                |
| `withJsonSchema(schema, input, output?)`                     | A new schema with a draft-2020-12 JSON Schema.                                                          |

## Failure behaviour

The package never returns a failure value. It returns the schema's output or throws one of two errors.

- **`SchemaError`**: the data is wrong. It has no code. `issues` says what is wrong, and the message is `formatIssues(issues)`. Handle it: show the user the message.
- **`SchemaRunError`**: the schema could not be run. It has a stable `code` and a `remediation`. Do not handle it as bad data. Fix the schema or the call.
- **`parseAsync` rejects** with the same two errors. It never throws before it returns the promise.

| Code               | Meaning                                                                         | What to do                                   |
| ------------------ | ------------------------------------------------------------------------------- | -------------------------------------------- |
| `ARKI_SCHEMA_E001` | `parse` got an async result from `validate`.                                    | Use `parseAsync`.                            |
| `ARKI_SCHEMA_E002` | The schema's `validate` threw or rejected. The thrown value is the `cause`.     | Fix the schema. This is a bug, not bad data. |
| `ARKI_SCHEMA_E003` | A `withJsonSchema` converter was asked for a target other than `draft-2020-12`. | Ask for `draft-2020-12`.                     |

## Limits

- **`parse` takes sync schemas only.** An async check makes it throw `ARKI_SCHEMA_E001`. Use `parseAsync`.
- **One JSON Schema target.** `withJsonSchema` answers `draft-2020-12`. Any other target throws `ARKI_SCHEMA_E003`.
- **The wrapper is a new object.** The result of `withJsonSchema` validates like the original but does not have its other methods, such as Zod's `.parse`.
- **Two copies break `instanceof`.** `error instanceof SchemaError` fails across two installed copies of the package. Keep one copy.
- **Paths are keys, not strings.** `pathOf` returns plain keys, so a key with a dot in it stays one segment.

The `parse` limit as code:

```ts run
import { z } from 'zod';

import { parse, SCHEMA_ERROR_CODES, SchemaRunError } from '@arki/schema';

try {
  parse(
    z.string().refine(value => Promise.resolve(value.length > 0)),
    'a',
  );
  throw new Error('expected an async schema to be refused');
} catch (error) {
  if (!(error instanceof SchemaRunError) || error.code !== SCHEMA_ERROR_CODES.asyncResult) throw error;
}
```

## Documentation

- [Agent guide](docs/agent-guide.md): tasks, step by step.
- [llms.txt](llms.txt): the map for agents.
- [CHANGELOG](CHANGELOG.md).

## Support

Report bugs and ask questions at https://github.com/arki-labs/arki/issues.
