# @arki/schema for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. A schema is any value with a `~standard` property that follows Standard Schema v1: Zod 4, Valibot, ArkType, or a hand-written object. This package never validates on its own; it runs the schema's `validate`.
2. `parse` and `parseAsync` return the schema's **output** type (`SchemaOutput<S>`), which can differ from its input type when the schema transforms.
3. There are two error classes. `SchemaError` (with `issues`) means the value does not match. `SchemaRunError` (with a `code` and a `remediation`) means the schema could not be run.
4. `pathOf` and `formatIssues` read issues the same way for every validator: Valibot's `{ key }` segments and ArkType's path arrays come out as plain arrays of keys.
5. `withJsonSchema` gives any schema a draft-2020-12 JSON Schema. The result is a new object; the original's own methods (such as zod's `.parse`) are not on it.
6. The package uses no Node or Bun built-ins. It runs in Node, Bun, Deno, browsers and Hermes.

## Task map

### Parse a value

1. Import `parse`.
2. Call it with the schema and the unknown value. Use the returned value, not the input.

```ts
import { z } from 'zod';

import { parse } from '@arki/schema';

const Port = z.coerce.number().int().min(1);
export const port: number = parse(Port, '8080');
```

### Parse with an async schema

1. Use `parseAsync` when any check is async (zod `refine(async …)`, valibot `pipeAsync`).
2. Await it. It rejects; it never throws synchronously.

```ts
import { z } from 'zod';

import { parseAsync } from '@arki/schema';

const Email = z.email().refine(email => Promise.resolve(!email.endsWith('@example.com')));
export const email: Promise<string> = parseAsync(Email, 'ada@arki.dev');
```

### Report bad data

1. Catch `SchemaError`. Let `SchemaRunError` through: it is a bug.
2. Use `pathOf(issue)` for field names and `formatIssues(issues)` for one line of text.

```ts
import * as v from 'valibot';

import { parse, pathOf, SchemaError } from '@arki/schema';

const Signup = v.object({ name: v.string(), age: v.number() });

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

### Accept any schema at runtime

1. Type the parameter as `StandardSchemaV1<unknown, Output>` so the output type flows to the caller.
2. Use `isStandardSchema` when the value comes from configuration or plugins.

```ts
import type { StandardSchemaV1 } from '@arki/schema';
import { isStandardSchema, parse } from '@arki/schema';

export function readSetting<Output>(schema: StandardSchemaV1<unknown, Output>, raw: unknown): Output {
  return parse(schema, raw);
}

export const looksLikeSchema = (value: unknown): boolean => isStandardSchema(value);
```

### Give a schema a JSON Schema

1. Check `hasJsonSchema(schema)` first: Zod 4 and ArkType already describe themselves; Valibot does not.
2. Otherwise wrap it with `withJsonSchema(schema, inputJson, outputJson?)`.
3. Ask the converter for `draft-2020-12` only.

```ts
import * as v from 'valibot';

import type { SchemaWithJson } from '@arki/schema';
import { hasJsonSchema, withJsonSchema } from '@arki/schema';

const Name = v.string();
export const named: SchemaWithJson<string> = hasJsonSchema(Name) ? Name : withJsonSchema(Name, { type: 'string' });
```

## Rules that bite

- Sync `parse` throws `ARKI_SCHEMA_E001` on an async schema, and drops the pending result without an unhandled rejection. Use `parseAsync`.
- `SchemaError` means bad data; `SchemaRunError` means a broken or misused schema. Never map `ARKI_SCHEMA_E002` to an HTTP 400: the validator has a bug.
- `withJsonSchema` answers only `draft-2020-12`. Other targets throw `ARKI_SCHEMA_E003`, as the spec asks of converters.
- Import `StandardSchemaV1` and the other spec types from `@arki/schema`, never from `@standard-schema/spec`. `@typescript-eslint/no-restricted-imports` enforces it outside this package.
- `instanceof SchemaError` fails across two installed copies of this package. Keep one copy.
- Valibot 1.5 has no `~standard.jsonSchema`; Zod 4.6 and ArkType 2.2 have one. The vendor tests assert this.

## Errors

| Code               | Meaning                                                                         | What to do               |
| ------------------ | ------------------------------------------------------------------------------- | ------------------------ |
| `ARKI_SCHEMA_E001` | `parse` got an async result from `validate`. The message names the vendor.      | Use `parseAsync`.        |
| `ARKI_SCHEMA_E002` | The schema's `validate` threw or rejected. The thrown value is the `cause`.     | Fix the schema.          |
| `ARKI_SCHEMA_E003` | A `withJsonSchema` converter was asked for a target other than `draft-2020-12`. | Ask for `draft-2020-12`. |

`SchemaError` has no code: it is the "bad data" answer, and its `issues` say what is wrong.

## Verify

```sh
bun run typecheck
bun run test
bun run lint
bun run build && bun run test:runtimes
bun run test:docs
```
