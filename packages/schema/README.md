# @arki/schema

Standard Schema for every validator. It holds the [Standard Schema](https://standardschema.dev) types, a sync `parse` and an async `parseAsync` that return the schema's output or throw a coded error, helpers that read issue paths the same way for every validator, and a bridge that gives any schema a JSON Schema. It works with Zod, Valibot, ArkType or a hand-written schema, and has one dependency: the spec's types.

Two errors, kept apart on purpose: `SchemaError` means the **data** is wrong. `SchemaRunError` means the **schema** could not be run (it is async, it threw, or it was asked for a JSON Schema target it does not have). Never answer a `SchemaRunError` with a 400.

## Install

```sh
bun add @arki/schema
```

## Parse a value

`parse` returns the schema's output type, not its input type.

```ts run
import { z } from 'zod';

import { parse } from '@arki/schema';

const Age = z.string().transform(text => Number(text));
const age: number = parse(Age, '42');
if (age !== 42) throw new Error(`unexpected age: ${age}`);
```

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

## Errors

| Code               | Meaning                                                                         | What to do                                   |
| ------------------ | ------------------------------------------------------------------------------- | -------------------------------------------- |
| `ARKI_SCHEMA_E001` | `parse` got an async result from `validate`.                                    | Use `parseAsync`.                            |
| `ARKI_SCHEMA_E002` | The schema's `validate` threw or rejected. The thrown value is the `cause`.     | Fix the schema. This is a bug, not bad data. |
| `ARKI_SCHEMA_E003` | A `withJsonSchema` converter was asked for a target other than `draft-2020-12`. | Ask for `draft-2020-12`.                     |
