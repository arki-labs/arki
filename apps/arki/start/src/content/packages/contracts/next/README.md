# @arki/contracts

Shared Zod schemas and Drizzle contract helpers — branded ID-aware select / insert / update schemas with auto-applied column refinements.

## Install

```sh
npm install @arki/contracts
# or
bun add @arki/contracts
# or
pnpm add @arki/contracts
```

Dependencies: `zod` (v4) and `zod-form-data`.

The `@arki/contracts/drizzle` entry needs `drizzle-orm` (an optional peer dependency). The main entry never loads it.

## Quick start

Declare an id kind and a list order once. Parse with them.

```ts run expect
import { defineId, keyset, pageInput } from '@arki/contracts';
import { isFailure } from '@arki/failure';

const storyId = defineId('sty_');
const order = keyset({ createdAt: 'desc', id: 'desc' });

const id = storyId.create();
if (isFailure(id)) throw new Error(id.message); // This example's outer application boundary.
if (!storyId.is(id)) throw new Error('create() made an id that is() rejects');

console.log(storyId.schema.safeParse('pod_123').success);
console.log(pageInput(order).parse({}).limit);
```

```text
false
20
```

`'pod_123'` fails because its prefix is not `sty_`. An empty page input gets the default limit of 20.

## When not to use this

- You want a full schema library. This package re-exports Zod and adds ids, pagination and contract helpers. It does not replace Zod.
- You need offset pagination (`?page=3`). `keyset` only does "after this row".
- You need secret or signed cursors. A cursor is base64url JSON. It is opaque, not secret.
- You need ids that cannot be guessed to protect a resource. `defineId` makes random ids, but an id is a name, not a permission. Check access on the server.
- You do not use oRPC. Then skip `@arki/contracts/orpc`. The other entries still work on their own.

## Runtime support

The main entry and `@arki/contracts/orpc` run on Node, Bun, Deno, browsers and React Native (Hermes). `@arki/contracts/drizzle` needs `drizzle-orm`; `@arki/contracts/orpc` needs `@orpc/contract`. Cursors use `btoa`, `atob` and URI coding, not `TextDecoder`, which Hermes lacks. Default ID generation needs `crypto.getRandomValues`; UUID generation prefers `crypto.randomUUID` and otherwise uses secure random bytes. Plain Hermes has neither. Applications on runtimes without Web Crypto must initialize a provider backed by secure platform entropy that fails closed in every supported mode, including debugging. Contracts cannot certify entropy quality from returned bytes. `zod-form-data` loads on every runtime; plain Hermes has no `FormData` class (React Native adds one). `bun run test:runtimes` runs a smoke test of the built package on each runtime; the Hermes leg needs `HERMES_BIN`.

## Why

Drizzle's `$type<T>()` changes TypeScript types without validating values. Table validators therefore infer only what their runtime schemas check. `jsonColumn(name, schema)` declares JSONB storage from one stable schema and applies it at runtime. Explicit refinements reuse that schema to preserve precise validator types, because Drizzle does not retain schema types on built columns. Existing ID column metadata still checks prefixes at runtime.

## Usage

### Re-exported Zod surface

```ts
import { z } from '@arki/contracts';

const Email = z.email();
```

The package re-exports everything from `zod`, so you do not need a direct `zod` import alongside it.

### Form data helpers

```ts
import { formData } from '@arki/contracts';

const schema = formData.zfd.formData({
  name: formData.zfd.text(),
  age: formData.zfd.numeric(),
});
```

### Branded select / insert / update schemas

```ts run
import { pgTable, varchar } from 'drizzle-orm/pg-core';

import { defineId, z } from '@arki/contracts';
import { createSelectSchema, jsonColumn } from '@arki/contracts/drizzle';

const userId = defineId('usr_');
const profileSchema = z.object({ displayName: z.string() });
const users = pgTable('users', {
  id: varchar('id').$type<z.output<typeof userId.schema>>().primaryKey(),
  email: varchar('email').notNull(),
  profile: jsonColumn('profile', profileSchema),
});
const userSelect = createSelectSchema(users, {
  id: () => userId.schema,
  profile: () => profileSchema,
});
type User = z.output<typeof userSelect>;
const user: User = { id: 'usr_1', email: 'a@example.com', profile: null };
if (userSelect.parse(user).email !== 'a@example.com') throw new Error('select schema changed the row');
if (userSelect.safeParse({ ...user, profile: { displayName: 42 } }).success) throw new Error('invalid JSON accepted');
if (userSelect.safeParse({ ...user, id: 'org_42' }).success) throw new Error('wrong prefix accepted');
```

Callback refinements retain column nullability and insert defaults; bare schema replacements control their own optionality and nullability. Explicit refinements override `COLUMN_ZOD_SCHEMA` metadata. Unannotated JSONB, including a bare `$type<Shape>()`, retains Drizzle's generic JSON validator and type.

`jsonColumn` takes a stable storage schema: its output must be recursively JSON-compatible and assignable to its input, and parsing stored output must preserve the value. Validation narrowing and branded JSON values are supported; Date, bigint, Map, Set, functions and required undefined values are not. Its runtime output is checked as JSON, including finite numbers. It does not change Drizzle's JSONB driver codec. Apply a wire transform or codec in an explicit insert refinement, insert its parsed application output, then validate fetched rows against the stable storage schema. Do not tag a column with a wire transform that would run again on an already transformed value.

Breaking migration: replace `jsonb(name).$type<Shape>()` with `jsonColumn(name, storageSchema)` and reuse that schema in precise table refinements. Reuse each ID declaration's schema in refinements for branded output types. A `$type` annotation alone no longer makes the validator claim that type.

### Prefixed ids: `defineId`

Write the prefix once; the type, the schema and the generator come from it.
For new domain IDs, name the kind too. Different kinds remain distinct even when
their stored prefixes are identical.

```ts run
import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';
import { isFailure } from '@arki/failure';

export const storyId = defineId('sty_', { kind: 'story' });
export type StoryId = IdOf<typeof storyId>; // branded `sty_${string}`

const id = storyId.create(); // StoryId | IdGenerationFailure
if (isFailure(id)) throw new Error(id.message); // Handle or return this failure in application code.
const input = { id };
const parsed: StoryId = storyId.schema.parse(input.id); // StoryId, or a ZodError for 'pod_…'
if (!storyId.is(parsed)) throw new Error('is() rejected a parsed id'); // type guard
if (parsed.length !== 'sty_'.length + 24) throw new Error('create() makes the prefix plus 24 characters');
```

- **Browser-safe.** No Drizzle. A contract, a form and a client can import it.
  On the server, `idColumns(storyId)` from `@arki/db/id` turns the same
  declaration into columns.
- **Domain types are inferred from the schema.** `kind` is one non-empty literal
  name, such as `billing.refund`. `IdOf`, `schema`, `is` and `create` preserve its
  brand. A raw string or another kind cannot stand in for it. The one-argument
  form retains its existing prefix-only type for migrations.
- **Stored prefixes stay as they are.** The prefix is used exactly as given
  (letters, digits and `_`), so `defineId('hlgt_')` matches the rows already
  stored.
- **Generation returns exact failures.** Check `isFailure` before using the ID.
  Missing or malformed providers return `RandomSourceUnavailable`; thrown provider
  faults, invalid output and exhausted rejection sampling return `UnexpectedDefect`
  with a private cause. `ID_GENERATION_FAILURES` declares these for adapters.
  This small synchronous entropy operation needs no separate OTel span; its
  calling operation observes and reports the returned failure.
- **Stored generator formats are explicit.** Use `format: { alphabet, length }`
  for existing nanoid-style bodies. The alphabet has 2–256 distinct, non-surrogate
  UTF-16 characters; length is an integer from 1 to 256. Every position samples
  the same alphabet uniformly, including the first. Definition copies and freezes
  the format, so later caller mutations cannot change generation. Schemas still
  validate only the stored prefix.
- **The generator uses Web Crypto.** Default and custom bodies use `crypto.getRandomValues`;
  UUID-v4 declarations prefer `crypto.randomUUID`, falling back to 16 secure
  random bytes only when that method is not callable. Applications own any
  platform-backed provider initialization and must ensure it fails closed in
  every supported mode. There is no `Math.random` fallback.

`assertUniqueIdPrefixes(...ids)` checks one app's ids. The same prefix twice
is a compile error (with literal prefixes) and throws; a prefix that starts
another (`'sub'` and `'sub_'`) throws too, because `sub_abc` passes both
schemas. Call it once in a test with every declaration of the app.
It checks wire-format ambiguity, including branded declarations; brands cannot
distinguish identical bytes at runtime. See [domain ID migration](docs/upgrades/domain-ids.md)
for canonical parsing and external/numeric IDs.

### Keyset pagination: `keyset`, `pageInput`, `page`

Declare how a list is ordered — once, in `model/` — and use it in the
contract and (through `@arki/db/pagination`) in the repository:

```ts
import { oc } from '@orpc/contract';

import { keyset, page, pageInput, z } from '@arki/contracts';

const storyStatus = z.enum(['draft', 'published']);
const storySchema = z.object({ id: z.string(), status: storyStatus });

export const storyOrder = keyset({ createdAt: 'desc', id: 'desc' });

export const listStories = oc
  .input(pageInput(storyOrder).extend({ status: storyStatus.optional() })) // { cursor?, limit = 20 (max 100) }
  .output(page(storySchema)); // { items, nextCursor: string | null }
```

- **Why keyset, not offset:** with `OFFSET`, a row added while someone reads
  shifts every later page, so rows repeat or vanish. A cursor says "after this
  row", which stays true.
- **End the order on a unique key.** Rows with the same `createdAt` have no
  order of their own; `id` breaks the tie.
- **The cursor** is the last row's key values, base64url JSON — URL-safe,
  opaque to clients, not secret. A `Date` comes back a `Date`. A cursor another
  keyset made, or a hand-edited one, returns `InvalidCursor`; the
  `pageInput` schema reports invalid input. Unexpected codec defects reach the schema owner.
- **Codec results.** Check `order.encode(row)` and `order.decode(cursor)` with `isFailure` before using their values. `InvalidCursorValue` rejects missing keys, non-finite numbers, invalid Dates, Dates outside the decoder’s ISO format and cursors over 1024 characters. `CURSOR_FAILURES` contains the original definitions for adapter error maps.
- **"No more pages" is `nextCursor: null`**, decided by fetching one extra
  row — never guessed from a short page.

### Operations: `@arki/contracts/orpc`

An oRPC contract already knows each procedure's path, input, output, errors
and meta. `operations(contract)` turns that into plain data — one
**operation** per procedure — so the client can carry a procedure's identity
next to its query utils, and a policy written once on the contract (say,
`offlineSafe: true`) can be checked by the compiler where it is used.

```ts run
import { oc } from '@orpc/contract';

import { z } from '@arki/contracts';
import { operations } from '@arki/contracts/orpc';

const post = z.object({ id: z.string(), title: z.string() });
const createPost = post.omit({ id: true });

const contract = { posts: { create: oc.input(createPost).output(post) } };
const ops = operations(contract);

ops.posts.create.name; // 'posts.create' — the string the server stores as procedure_path
ops.posts.create.path; // ['posts', 'create']
ops.posts.create.meta; // the contract meta, value and type
if (ops.posts.create.name !== 'posts.create') throw new Error('operation name changed');
```

- **Why on the contract.** Types are written once, on the contract; the
  operation is inferred from it (`OperationOf<typeof contract.posts.create>`).
  Nothing is restated on the client.
- **Plain, frozen data.** No Proxy, no schemas: safe to log, compare by
  `name` and persist (`path` and `name`).
- **Fails loud at build time.** A key with `.` (the name would be
  ambiguous) or a reserved key (`~op`, `key`, `call`, `queryKey`,
  `queryOptions`, `infiniteKey`, `infiniteOptions`, `mutationKey`,
  `mutationOptions` — a query-utils group would shadow it) throws a
  `TypeError` naming the path.
- **Bundles.** The walk reads only path and meta, so a
  `minifyContractRouter` output works the same: an app can later ship a
  minified contract to the browser without its Zod schemas.
- **Carrying it.** `createOrpcUtils` (in `@fleet/tanstack-start/orpc/client`)
  puts each leaf's operation under `'~op'`; `operationOf(leaf)` reads it
  back, and throws for a value without one (a raw client, a forged object).

`@orpc/contract` is an optional peer: only this entry imports it.

## Public imports

| Import                    | Needs                  | What it holds                                                                |
| --------------------- | ------------------------------- | ------------------------------------------------------ |
| `@arki/contracts`         | `@arki/failure`, `zod`, `zod-form-data` | `z`, `formData`, `defineId`, `keyset`, `pageInput`, `page`, `ContractsError`, `InvalidCursor`, `InvalidCursorValue`, `CURSOR_FAILURES`, `RandomSourceUnavailable`, `ID_GENERATION_FAILURES` |
| `@arki/contracts/drizzle` | peer `drizzle-orm`     | `createSelectSchema`, `createInsertSchema`, `createUpdateSchema`             |
| `@arki/contracts/orpc`    | peer `@orpc/contract`  | `operations`, `operationAt`, `operationOf`                                   |

Main entry, `@arki/contracts` (no Drizzle):

- `formData` — re-exported `zod-form-data` namespace.
- `z`, `ZodError`, every Zod export — re-exported from `zod`.
- `UserId`, `userIdSchema` — shared id types.
- `defineId(prefix)`, `IdOf<typeof id>`, `IdDeclaration`, `assertUniqueIdPrefixes(...ids)` — prefixed ids declared once.
- `keyset(order)`, `pageInput(keyset, options?)`, `page(itemSchema)`, `Page<T>`, `Keyset`, `CursorValue` — keyset pagination.

oRPC entry, `@arki/contracts/orpc` (peer: `@orpc/contract`):

- `operations(contract)`, `Operations<C>` — the operation tree of a contract.
- `operationAt(contract, path)` — the operation at a path, or `undefined`.
- `Operation<I, O, E, M>`, `AnyOperation`, `OperationOf<C>`, `InputOf<Op>`, `OutputOf<Op>`, `ErrorOf<Op>`, `MetaOf<Op>` — the identity and its types.
- `OPERATION` (`'~op'`), `Identified<Op>`, `operationOf(carrier)` — a value that carries an operation.

Drizzle entry, `@arki/contracts/drizzle`:

- `createSelectSchema(table, refine?)` — branded select schema.
- `createInsertSchema(table, refine?)` — branded insert schema.
- `createUpdateSchema(table, refine?)` — every field optional, otherwise like insert.
- `jsonColumn(name, storageSchema)` — JSONB column with a runtime storage schema and inferred application type.
- `COLUMN_ZOD_SCHEMA` — `Symbol.for('@arki/contracts/columnZodSchema')` side-channel for ID factories.
- `bufferSchema`, `jsonSchema`, `literalSchema`, `createSchemaFactory` — re-exported from `drizzle-orm/zod`.

## Failure behaviour

Static definition misuse throws `ContractsError`, a `TypeError`. ID generation and cursor codecs return canonical failures; check them with their definitions or `isFailure`. Match on code, never on message.

```ts run expect
import { CONTRACTS_ERROR_CODES, ContractsError, defineId } from '@arki/contracts';

try {
  Reflect.apply(defineId, undefined, [42]);
} catch (error) {
  if (!(error instanceof ContractsError)) throw error;
  console.log(error.code === CONTRACTS_ERROR_CODES.invalidIdPrefix);
  console.log(error.remediation);
}
```

```text
true
Supply the stored prefix as a string; use an empty string for unprefixed IDs.
```

Schema `parse` calls throw a `ZodError` as Zod does. Use `safeParse` for input from outside.

| Code                  | Raised by                       | Meaning                                                |
| --------------------- | ------------------------------- | ------------------------------------------------------ |
| `ARKI_CONTRACTS_E001` | `defineId`                      | The prefix is not a string.              |
| `ARKI_CONTRACTS_E009` | `defineId`                      | The domain kind is missing, empty or not a string. |
| `ARKI_CONTRACTS_E010` | `defineId` | Invalid generation format; use `uuid`, omit format, or provide a valid alphabet/length object. |
| `ARKI_CONTRACTS_E002` | `assertUniqueIdPrefixes`        | Two prefixes are equal or one starts the other.        |
| `ARKI_CONTRACTS_E003` | legacy reserved exception code  | ID generation now returns `RandomSourceUnavailable`. |
| `ARKI_CONTRACTS_E004` | `keyset`                        | No keys in the static declaration.               |
| `ARKI_CONTRACTS_E005` | legacy reserved exception code | Cursor input now returns `InvalidCursor`.              |
| `ARKI_CONTRACTS_E006` | `operations`, `createOrpcUtils` | A contract key contains "." or uses a reserved name.   |
| `ARKI_CONTRACTS_E007` | `operationOf`                   | The value carries no operation.                        |

Cursor codecs return `contracts.invalid_cursor` or `contracts.invalid_cursor_value`, plus canonical `schema.validator_defect` / `failure.unexpected_defect` for unexpected faults. Causes stay private. These pure codecs need no separate OTel span; the calling query or transport owns the operation span.

## Limits

- **Limit per page.** `pageInput` accepts 1 to 100 rows. The default is 20. Change both with `defaultLimit` and `maxLimit`.

  ```ts run expect
  import { keyset, pageInput } from '@arki/contracts';

  const input = pageInput(keyset({ id: 'asc' }));
  console.log(input.safeParse({ limit: 100 }).success);
  console.log(input.safeParse({ limit: 101 }).success);
  ```

  ```text
  true
  false
  ```

- **Key values.** A keyset key may not be NULL in a row. Order by NOT NULL columns, and end on a unique one.
- **Cursors.** A cursor works only with the keyset that made it. Changing the order invalidates cursors already handed out.
- **Prefixes.** Letters, digits and `_`. No two prefixes in one app may be equal or start one another (`sub` and `sub_`).
- **Ids need secure randomness.** Default `create()` uses `crypto.getRandomValues`; UUID generation prefers `crypto.randomUUID`, with secure random bytes as its fallback. Rejection sampling stops after 32 batches of twice the body length (48 bytes for default bodies); a provider that never supplies accepted bytes returns `UnexpectedDefect`. Missing providers return `RandomSourceUnavailable`; thrown faults and malformed output return `UnexpectedDefect`. There is no `Math.random` fallback.
- **Operations.** A contract key may not contain `.` or use a name the query utils reserve.

## Documentation

`@arki/contracts` is framework-agnostic and works on its own. When you
compose it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

## Support

Questions and bugs: <https://github.com/arki-labs/arki/issues>. Include the package version, your runtime and the error `code`.

<!-- bench:start -->

## Benchmarks

Building and using Zod schemas from a 15-column Drizzle table, compared with drizzle-orm/zod (which @arki/contracts wraps) and a hand-written Zod object.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Build select schema (15 columns)

Usually done once at startup.

| Library                       | Time / op | vs fastest |
| ----------------------------- | --------: | ---------: |
| @arki/contracts createSelectSchema | 193.66 µs |      1.26× |
| drizzle-orm/zod createSelectSchema | 153.73 µs |    fastest |

### Build insert schema (15 columns)

| Library                       | Time / op | vs fastest |
| ----------------------------- | --------: | ---------: |
| @arki/contracts createInsertSchema | 148.37 µs |      1.60× |
| drizzle-orm/zod createInsertSchema |  92.97 µs |    fastest |

### Parse one valid row

@arki/contracts and the hand-written schema check the id prefix "usr_"; plain drizzle-orm/zod only checks that id is a string.

| Library                       | Time / op | vs fastest |
| ----------------------------- | --------: | ---------: |
| @arki/contracts select schema |   2.71 µs |      3.43× |
| drizzle-orm/zod select schema |   2.82 µs |      3.57× |
| hand-written z.object         |  790.4 ns |    fastest |

Read the rows with the contracts in mind:

- @arki/contracts calls drizzle-orm/zod and then adds branded types and the per-column runtime schemas stashed by ID factories; that extra work is the cost shown in the build rows.
- The hand-written schema does not read the table at all, so it only shows the floor for parsing.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT. See [LICENSE](./LICENSE).
