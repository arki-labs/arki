# @arki/failure

Typed expected failures for TypeScript, with no wrapper and no runtime. Define a failure once, return it like any value, and the compiler makes every caller handle it.

```ts
import { defineFailure, isFailure } from '@arki/failure';

export const PostNotFound = defineFailure('post.not_found', {
  status: 404,
  data: z.object({ id: PostId }),
  message: 'no post {id}',
});

const find = async (id: PostId) => (await repo.find(id)) ?? PostNotFound({ id });
//    ^? (id: PostId) => Promise<Post | Failure<'post.not_found', { id: PostId }>>

const post = await find(id);
post.title; // ✗ type error: the failure has no title, so check first
if (isFailure(post)) return post; // early return: the failure joins this function's inferred result
post.title; // ✓ narrowed to Post
```

- **No wrapper on success.** A function returns the post itself, or a failure. There is no `ok(…)` to add and no `.value` to unwrap, and existing code gains failures one `return` at a time.
- **Errors in the type, inferred.** A function's return type lists every failure it can produce, including the ones it passes on with `if (isFailure(x)) return x`. Nobody writes the union down.
- **Written once.** Code, status, data schema, message template and remediation live in `defineFailure`. Failure values, `match` and `recover` handlers, oRPC error maps and `revive` all take their types from it.
- **Any schema.** The data schema is any [Standard Schema](https://standardschema.dev): Zod 4, Valibot, ArkType. The core depends only on `@arki/schema`.
- **Caught when ignored.** The `must-use` lint rule reports a call whose failure is thrown away.
- **Bugs still throw.** A failure is something the caller should handle ("not found", "email taken", "card declined"). A bug is not; keep throwing those.
- **Every runtime.** Node, Bun, Deno, browsers and React Native (Hermes), checked by `test:runtimes`.

```bash
bun add @arki/failure
```

## Define

### `defineFailure(code, { data?, message?, status?, remediation? }?)`

Names one kind of failure and returns its **definition**. Call the definition to make a failure value: `PostNotFound({ id })`, or `Unauthorized()` when it has no data.

| Option        | Default  | What it is                                                                                                         |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `data`        | none     | Schema of the data the failure carries. Without it, the definition takes no data.                                  |
| `message`     | the code | A template such as `'no post {id}'`, or a function of the data. A `{key}` that is not in the data is a type error. |
| `status`      | `400`    | HTTP status a boundary answers with, 400–599.                                                                      |
| `remediation` | none     | What the caller can do about it, in one sentence.                                                                  |

The code must be unique in your app; a dotted `feature.reason` code such as `post.not_found` works well. `ok` is reserved.

Pass a cause as the last argument: `SyncFailed({ feed }, { cause: dbFailure })`, or `Timeout({ cause: error })`.

A definition also has `code`, `status`, `remediation`, `dataSchema`, and `is(value)`, which is true for its own failures only.

A **failure value** is a frozen object, `{ code, message, data, status, remediation }`, plus `cause`. It serialises to clean JSON for logs and queues; the brand and the cause stay out of the JSON.

### Choosing a status

- **4xx** means the caller can fix it: bad input, a missing post, a taken email.
- **422** when an upstream service refuses us but our own user is fine, such as "Notion rejected the token".
- **401** only for "you are not signed in". A client may sign the user out on a 401, so never use it for an upstream answer.
- **503** when an upstream service is unavailable and a later try may work.

```ts
export const NotionTokenRejected = defineFailure('export.notion_token_rejected', { status: 422 });
export const NotionUnavailable = defineFailure('export.notion_unavailable', { status: 503 });
```

## Check

### `isFailure(value)`

True for any failure value. Narrows `T | Failure` both ways. Passing a promise is a type error, because a forgotten `await` would always answer "not a failure".

### Early return

There is no special syntax. Check and return:

```ts
async function publish(id: PostId) {
  const post = await find(id);
  if (isFailure(post)) return post;
  const author = await findAuthor(post.authorId);
  if (isFailure(author)) return author;
  return render(post, author);
}
// ^? Promise<Page | Failure<'post.not_found', …> | Failure<'author.banned', …>>
```

### Nothing, or a failure

A function with no success value returns `undefined` or a failure. Callers check with `isFailure`.

```ts
async function remove(id: PostId): Promise<undefined | Failure<'post.not_found', { id: PostId }>> {
  if (!(await repo.delete(id))) return PostNotFound({ id });
  return undefined;
}

const removed = await remove(id);
if (isFailure(removed)) return removed;
```

### Partial success

When some work succeeded before an expected failure, return the success value with the failure inside it. Do not throw the progress away.

```ts
async function exportAll(items: Item[]) {
  const delivered: Item[] = [];
  for (const item of items) {
    const sent = await send(item);
    if (isFailure(sent)) return { delivered, stoppedBy: sent }; // 40 items out, then the token was refused
    delivered.push(item);
  }
  return { delivered };
}
// the caller gets { delivered, stoppedBy?: failure } and keeps what was already sent
```

This is not "data that is itself a failure" (see Pitfalls): here the failure is a field of the result, not the result.

## Handle

### `match(value, handlers)`

One handler for the success value (`ok`) and one for each failure code the value can carry. A value that can only be a failure, such as one from `reviveRpcError`, takes no `ok`. A missing handler is a type error. A handler for a code the value can no longer carry is also a type error, so adding or removing a failure updates every `match`. Returns the union of what the handlers return.

```ts
const label = match(await find(id), {
  ok: post => post.title,
  'post.not_found': failure => `missing ${failure.data.id}`,
});
```

### `recover(value, handlers)`

Handle some failures and pass the rest through. The result type drops the handled codes and adds what their handlers return.

```ts
const post = recover(await find(id), { 'post.not_found': () => draft(id) });
//    ^? Post | Draft | Failure<'db.timeout', …>
```

### `orThrow(value)`

The success value, or throw the failure as an `UnexpectedFailure` (with `failure`, `code`, `status`, `remediation` and the failure's `cause`). Use it where a failure would be a bug: a seed script, a test, an id you just created. It takes a promise too, so `orThrow(find(id))` cannot forget the `await`.

### `assertNever(value, message?)`

Put it in the `default` of a `switch` over a union. When the union gains a member, the call stops compiling. If it is reached anyway (bad data at runtime), it throws `ARKI_FAILURE_E004`.

## Boundaries

### `attempt(run, onThrow)`

Run code that throws (`JSON.parse`, `fetch`, a driver, an SDK) and turn a throw, or a rejected promise, into the value `onThrow` returns. The mapper is required, so no failure is ever typed `unknown`. It may rethrow what it does not recognise, which keeps unknown errors as bugs. Returning a plain value works like Laravel's `rescue()`.

```ts
const body = attempt(
  () => JSON.parse(text) as unknown,
  cause => InvalidJson({ reason: String(cause) }),
);
const page = await attempt(
  () => fetchPage(url),
  () => null,
);
```

### `revive(value, definitions)`

A failure that went through JSON (a queue, a journal row, a worker message) is a plain object again. `revive` returns the live failure for one of the definitions you expect, matched by code, and checks its data with that definition's schema. It returns `undefined` for anything else. Data that does not match throws `ARKI_FAILURE_E006`, and an asynchronous schema throws `ARKI_FAILURE_E007`; each keeps the `@arki/schema` error as its `cause`. A validator that throws is a bug, not bad data: its `SchemaRunError` (`ARKI_SCHEMA_E002`) passes through unwrapped.

```ts
const failure = revive(JSON.parse(message), [PostNotFound, EmailTaken]);
```

### `findCause(value, definitionOrErrorClass)`

Walks the `cause` chain, starting with the value itself, like Go's `errors.As`. It returns the first link that is a failure of the definition, or an instance of the error class.

```ts
const timeout = findCause(syncFailure, DbTimeout); // typed, or undefined
const socket = findCause(error, ConnectionError);
```

### `partition(values)` and `collect(values)`

`partition` splits values into successes and failures. `collect` returns every success, typed per position like `Promise.all`, or the first failure.

```ts
const [posts, missing] = partition(await Promise.all(ids.map(id => find(id))));
const pair = collect([await find(a), await findAuthor(b)]); // [Post, Author] | the first failure
```

## Types

- `Failure<Code, Data>`: a failure value.
- `FailureOf<typeof fn>` and `SuccessOf<typeof fn>`: the failures and the success value a function returns, sync or async.
- `Result<Value, Failures>`: `Value | Failures`, for a return type written by hand (a port or an interface).
- `FailureDefinition<Code, Schema>`, `MatchHandlers<Value>`, `RecoverHandlers<Value>`.
- `DataOf<Schema>`: the data a failure carries, the schema's **output** type (the live value), or `undefined` without a schema.

## Lint: `@arki/failure/eslint`

A failure is a return value, so the compiler checks it only when the value is used. A call whose result is thrown away drops its failure silently:

```ts
await remove(id); // ✗ failure/must-use: this call can return a failure ("post.not_found") and its result is thrown away
void (await remove(id)); // ✓ discarded on purpose
```

```js
// eslint.config.js
import tseslint from 'typescript-eslint';

import failure from '@arki/failure/eslint';

export default [
  // The rule is type-aware: TypeScript files need the typescript-eslint parser with projectService.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: { parser: tseslint.parser, parserOptions: { projectService: true } },
  },
  failure.configs.recommended, // TypeScript files only, so .js files such as this one are left alone
];
```

Peers for this entry: `eslint`, `@typescript-eslint/utils`, `typescript`.

## oRPC: `@arki/failure/orpc`

The contract lists failures by definition, and the procedure hands the usecase's result to `orThrowRpc` with the handler's `errors`. Code, status and data come from one `defineFailure`, and a failure the contract does not list is a compile error, so the contract and the usecase cannot drift.

```ts
import { errorMap, orThrowRpc } from '@arki/failure/orpc';

// entrypoints/rpc.ts
byId: oc.errors(errorMap(PostNotFound)).input(z.object({ id: PostId })).output(PostSchema),

// entrypoints/procedures.ts
byId: impl => impl.byId.handler(({ context, input, errors }) => orThrowRpc(context.usecases.find(input.id), errors)),
```

- `errorMap(...definitions)` builds the contract's error map. Two definitions with one code throw `ARKI_FAILURE_E005`.
- `orThrowRpc(value, errors)` returns the value, or throws the failure through the handler's `errors`: the typed `ORPCError` the contract declares, with the failure's message and data. The client gets it as `defined: true`.
- A failure the usecase can return but the contract does not list is a compile error: `Property '"post.locked"' is missing in type …`. Add its definition to `errorMap(...)`. If the types are bypassed anyway, the failure arrives as undeclared (`defined: false`).
- Forgetting `orThrowRpc` is a compile error: `Post | Failure` is not the procedure's output.
- `reviveRpcError(error, definitions)` is the client side: a caught `ORPCError` whose code is one of the definitions becomes the live failure, its data checked like `revive`. Anything else returns `undefined`, so rethrow it. Then `match` on the failure as the backend does.

```ts
const post = await client.posts.byId({ id }).catch((error: unknown) => {
  const failure = reviveRpcError(error, [PostNotFound]);
  if (failure === undefined) throw error;
  return failure;
}); // Post | Failure<'post.not_found', …>
```

`@orpc/client` is an optional peer dependency, needed only for this entry. The entry imports nothing from `@orpc/server`, so contract files and client code that use it can ship to browsers.

## Errors

Mistakes in how the package is used are thrown as `FailureError` with a stable `code` and a one-sentence `remediation`. Match on the code, never on the message.

| Code                | When                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `ARKI_FAILURE_E001` | `defineFailure` got an empty code, or the reserved code `ok`.                                    |
| `ARKI_FAILURE_E002` | `defineFailure` got a status that is not an integer from 400 to 599.                             |
| `ARKI_FAILURE_E003` | `match` met a failure code it has no handler for (types were bypassed).                          |
| `ARKI_FAILURE_E004` | `assertNever` was reached.                                                                       |
| `ARKI_FAILURE_E005` | `errorMap` got two definitions with the same code.                                               |
| `ARKI_FAILURE_E006` | `revive` got data that does not match the definition's schema. The `cause` is the `SchemaError`. |
| `ARKI_FAILURE_E007` | `revive` got a schema that validates asynchronously. The `cause` is the `SchemaRunError`.        |

## Pitfalls

- **A discarded call drops its failure.** Turn on the `must-use` rule.
- **`unknown`, `any` and `object` swallow failures.** A function whose return type widens to one of them loses its failures from the type. Parse with a schema instead of casting to `unknown`, and assert `FailureOf<typeof fn>` in a test when it matters.
- **Truthiness does not narrow.** A failure is an object, so `if (post)` and `post ?? fallback` do not remove it. Use `isFailure`.
- **A data schema must accept its own output.** `revive` validates the JSON of the live value, so a schema such as `z.string().transform(Number)` makes `revive` throw `ARKI_FAILURE_E006` on its own failures.
- **Data that is itself a failure is ambiguous.** Do not return stored failures as success data; wrap them (`{ failure }`).

## Why no wrapper?

- **Effect** puts failures in an `Effect<A, E, R>` type that needs its runtime and its own ecosystem. This package gives the visible-failure part with plain functions that work with every library.
- **neverthrow, true-myth and Effect's `Result`** wrap both sides in an object. Every success needs `ok(…)`, every caller needs `.value`, and every boundary that expects plain values (Drizzle, oRPC outputs, React Query) needs an unwrap. Here the success is the value itself, and the definition carries the code, status, data schema and message that boundaries read.

Research behind the design: `docs/arki/research/07-result/` in the Arki monorepo.
