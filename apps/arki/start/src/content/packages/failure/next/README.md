# @arki/failure

Typed expected failures for TypeScript, with no wrapper and no runtime. Define a failure once, return it like any value, and the compiler makes every caller handle it.

- **No wrapper on success.** A function returns the post itself, or a failure. There is no `ok(…)` to add and no `.value` to unwrap, and existing code gains failures one `return` at a time.
- **Errors in the type, inferred.** A function's return type lists every failure it can produce, including the ones it passes on with `if (isFailure(x)) return x`. Nobody writes the union down.
- **Written once.** Code, status, data schema, message template and remediation live in `defineFailure`. Failure values, `match` and `recover` handlers, oRPC error maps and `revive` all take their types from it.
- **Any schema.** The data schema is any [Standard Schema](https://standardschema.dev): Zod 4, Valibot, ArkType. The core depends only on the canonical Standard Schema types; it has no runtime dependency on a validator or `@arki/schema`.
- **Caught when ignored.** The `must-use` lint rule reports a call whose failure is thrown away. `no-blind-accept` reports `accept(r)` of a failure not checked by kind.
- **Bugs still throw.** A failure is something the caller should handle ("not found", "email taken", "card declined"). A bug is not; keep throwing those.
- **Every runtime.** Node, Bun, Deno, browsers and React Native (Hermes), checked by `test:runtimes`.

## Install

```bash
bun add @arki/failure
```

Peers: `eslint`, `@typescript-eslint/utils` and `typescript` for the `/eslint` entry; `@orpc/client` for the `/orpc` entry. Each is optional.

## Quick start

```ts run expect
import { z } from 'zod';

import { defineFailure, isFailure } from '@arki/failure';

const EmailTaken = defineFailure('user.email_taken', {
  status: 409,
  data: z.object({ email: z.string() }),
  message: 'email {email} is taken',
});

const taken = new Set(['ada@example.com']);
const signUp = (email: string) => (taken.has(email) ? EmailTaken({ email }) : { email });

const result = signUp('ada@example.com');
if (!isFailure(result)) throw new Error('expected a failure');
console.log(result.status, result.message);
```

```text
409 email ada@example.com is taken
```

App-shaped blocks import their names from [the docs fixture](docs/examples/fixture.ts): an in-memory post repository, the example failures, and small stand-ins for an export step, a feed and an RPC client.

`signUp` returns `{ email } | Failure<'user.email_taken', { email: string }>`. Nobody wrote that type. The compiler infers it, and `result.email` is a type error until `isFailure` has run.

## When not to use this

- **For bugs.** A null you did not expect, a broken invariant or a failed assertion should throw. A failure is for things the caller can handle.
- **When a framework needs an exception.** A transaction wrapper or a job runner that retries on a throw does nothing with a returned value. Throw inside it, or turn the failure into a throw with `orThrow`.
- **When you need an effect system.** Retries, scheduling, resources and dependency injection in one type are what Effect does. This package only makes failures visible.
- **For one-off scripts.** A thrown error with a clear message is enough when no caller handles it.

## Runtime support

Node, Bun, Deno, browsers and React Native (Hermes). The core uses no runtime built-ins. The `/eslint` entry runs in Node and Bun only, where ESLint runs.

## Public imports

- `@arki/failure`: `defineFailure`, `isFailure`, `match`, `recover`, `orThrow`, `attempt`, `revive`, `findCause`, `partition`, `collect`, `stoppable`, `assertNever`, `FailureError` and the types.
- `@arki/failure/orpc`: `errorMap`, `orThrowRpc`, `reviveRpcError`, `rpcFailureDefinitions`, `RPC_FAILURE_DEFINITION`.
- `@arki/failure/eslint`: the `must-use` and `no-blind-accept` rules, and `configs.recommended`.

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

```ts from="examples/posts.ts#define"
import { z } from 'zod';

import { defineFailure, isFailure, match, recover } from '@arki/failure';

export const PostNotFound = defineFailure('post.not_found', {
  status: 404,
  data: z.object({ id: z.string() }),
  message: 'no post {id}',
});

type Post = { id: string; title: string };
const posts = new Map<string, Post>([['p1', { id: 'p1', title: 'Hello' }]]);

export const find = async (id: string) => posts.get(id) ?? PostNotFound({ id });
```

Pass a cause as the last argument: `SyncFailed({ feed }, { cause: dbFailure })`, or `Timeout({ cause: error })`.

A definition also has `code`, `status`, `remediation`, `dataSchema`, and `is(value)`, which is true for its own failures only.

A **failure value** is a frozen object, `{ code, message, data, status, remediation }`, plus `cause`. It serialises to clean JSON for logs and queues; the brand and the cause stay out of the JSON.

### Choosing a status

- **4xx** means the caller can fix it: bad input, a missing post, a taken email.
- **422** when an upstream service refuses us but our own user is fine, such as "Notion rejected the token".
- **401** only for "you are not signed in". A client may sign the user out on a 401, so never use it for an upstream answer.
- **503** when an upstream service is unavailable and a later try may work.

When a failure carries an upstream service's HTTP status in its data, name that field `upstreamStatus`, so it is never confused with the failure's own `status`.

```ts
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

export const NotionTokenRejected = defineFailure('export.notion_token_rejected', { status: 422 });
export const NotionUnavailable = defineFailure('export.notion_unavailable', {
  status: 503,
  data: z.object({ upstreamStatus: z.number().optional() }),
});
```

## Check

### `isFailure(value)`

True for any failure value. Narrows `T | Failure` both ways. Passing a promise is a type error, because a forgotten `await` would always answer "not a failure".

### Early return

There is no special syntax. Check and return:

```ts from="examples/posts.ts#early-return"
export async function titleOf(id: string) {
  const post = await find(id);
  if (isFailure(post)) return post; // the failure joins this function's inferred result
  return post.title; // narrowed to Post
}
```

### Nothing, or a failure

A function with no success value returns `undefined` or a failure. Callers check with `isFailure`.

```ts run
import { isFailure, type Failure } from '@arki/failure';

import { PostId, PostNotFound, repo } from './fixture.ts';

async function remove(id: PostId): Promise<undefined | Failure<'post.not_found', { id: PostId }>> {
  if (!(await repo.delete(id))) return PostNotFound({ id });
  return;
}

async function removeOrStop(id: PostId) {
  const removed = await remove(id);
  if (isFailure(removed)) return removed;
  return 'removed';
}

const got = [await removeOrStop('p1'), await removeOrStop('p1')];
if (got[0] !== 'removed' || typeof got[1] === 'string') throw new Error('expected removed, then a failure');
```

### Partial success

When some work succeeded before an expected failure, return the success value with the failure inside it. Do not throw the progress away. `Stoppable<Value, Failures>` is that shape: `Value & { readonly stoppedBy?: Failures }`. Build it with `stoppable(value, stoppedBy?)`, and the return type is inferred, so you write no annotation.

```ts run
import { isFailure, stoppable } from '@arki/failure';

import { items, save, send, type Item } from './fixture.ts';

async function exportAll(items: Item[]) {
  const delivered: Item[] = [];
  for (const item of items) {
    const sent = await send(item);
    if (isFailure(sent)) return stoppable({ delivered }, sent); // 40 items out, then the token was refused
    delivered.push(item);
  }
  return stoppable({ delivered });
} // Promise<Stoppable<{ delivered: Item[] }, FailureOf<typeof send>>>

async function exportAndKeep(items: Item[]) {
  const result = await exportAll(items);
  save(result.delivered); // keep what was already sent
  if (result.stoppedBy) return result.stoppedBy; // typed, with no `'stoppedBy' in result` check
  return result;
}

const stopped = await exportAndKeep(items);
if (!isFailure(stopped)) throw new Error('expected the token failure');
const all = await exportAll(items.slice(0, 2));
if ('stoppedBy' in all || all.delivered.length !== 2) throw new Error('a finished result has no stoppedBy key');
```

`stoppable` returns a shallow copy of `value`. It adds the `stoppedBy` key only when you pass a failure, so a finished result has no `stoppedBy` key at all.

This is not "data that is itself a failure" (see Pitfalls): here the failure is a field of the result, not the result.

## Handle

### `match(value, handlers)`

One handler for the success value (`ok`) and one for each failure code the value can carry. A value that can only be a failure, such as one from `reviveRpcError`, takes no `ok`. A missing handler is a type error. A handler for a code the value can no longer carry is also a type error, so adding or removing a failure updates every `match`. Returns the union of what the handlers return.

```ts from="examples/posts.ts#match"
export async function label(id: string) {
  return match(await find(id), {
    ok: post => post.title,
    'post.not_found': failure => `missing ${failure.data.id}`,
  });
}
```

### `recover(value, handlers)`

Handle some failures and pass the rest through. The result type drops the handled codes and adds what their handlers return.

```ts from="examples/posts.ts#recover"
export async function titleOrDraft(id: string) {
  return recover(await find(id), { 'post.not_found': () => 'Untitled draft' });
}
```

### `orThrow(value)`

The success value, or throw the failure as an `UnexpectedFailure` (with `failure`, `code`, `status`, `remediation` and the failure's `cause`). Use it where a failure would be a bug: a seed script, a test, an id you created a moment ago. It takes a promise too, so `orThrow(find(id))` cannot forget the `await`.

### `assertNever(value, message?)`

Put it in the `default` of a `switch` over a union. When the union gains a member, the call stops compiling. If it is reached anyway (bad data at runtime), it throws `ARKI_FAILURE_E004`.

## Boundaries

### `attempt(run, onThrow)`

Run code that throws (`JSON.parse`, `fetch`, a driver, an SDK) and turn a throw, or a rejected promise, into the value `onThrow` returns. The mapper is required, so no failure is ever typed `unknown`. It may rethrow what it does not recognise, which keeps unknown errors as bugs. Returning a plain value works like Laravel's `rescue()`.

```ts run
import { attempt } from '@arki/failure';

import { fetchPage, InvalidJson, text, url } from './fixture.ts';

const body = attempt(
  () => JSON.parse(text) as unknown,
  cause => InvalidJson({ reason: String(cause) }),
);
const page = await attempt(
  () => fetchPage(url),
  () => null,
);
if (page !== 'page body' || typeof body !== 'object') throw new Error('expected the parsed body and the page');
```

### `revive(value, definitions)`

A failure that went through JSON is a plain object again. `revive` validates the envelope and reconstructs a known failure using local definitions. It returns `undefined` for unrelated values, `InvalidEnvelope` for unknown codes, malformed data or unsupported versions, `AsyncSchema` for an async validator, and `ValidatorDefect` or `UnexpectedDefect` for broken validators or constructors. `REVIVAL_FAILURES` is the runtime list of these boundary failures; `RevivalFailure` is inferred from it.

`serialize(failure, definitions)` produces a version 1 envelope with only `version`, `code` and optional validated `data`. `revive` also reads legacy versionless `{code, data}` records. Remote status, message, brand and cause are ignored. `reviveJson(text, definitions)` additionally handles malformed JSON as `InvalidEnvelope`.

Wire data must be lossless JSON and its schema must accept that data unchanged. Dates, bigints, cycles, getters, `toJSON` hooks and transforms that change the output are rejected. Use a separate JSON-safe wire definition for those domain values; no implicit codec or double transformation occurs.
```ts run
import { revive } from '@arki/failure';

import { EmailTaken, message, PostNotFound } from './fixture.ts';

const failure = revive(JSON.parse(message), [PostNotFound, EmailTaken]);
if (failure?.code !== 'user.email_taken') throw new Error('expected the email failure back');
```

### `findCause(value, definitionOrErrorClass)`

Walks the `cause` chain, starting with the value itself, like Go's `errors.As`. It returns the first link that is a failure of the definition, or an instance of the error class.

```ts run
import { findCause } from '@arki/failure';

import { ConnectionError, DbTimeout, error, syncFailure } from './fixture.ts';

const timeout = findCause(syncFailure, DbTimeout); // typed, or undefined
const socket = findCause(error, ConnectionError);
if (timeout === undefined || socket === undefined) throw new Error('expected both causes');
```

### `partition(values)` and `collect(values)`

`partition` splits values into successes and failures. `collect` returns every success, typed per position like `Promise.all`, or the first failure.

```ts run
import { collect, partition } from '@arki/failure';

import { a, b, find, findAuthor, ids } from './fixture.ts';

const [posts, missing] = partition(await Promise.all(ids.map(id => find(id))));
const pair = collect([await find(a), await findAuthor(b)]); // [Post, Author] | the first failure
if (posts.length !== 1 || missing.length !== 1 || !Array.isArray(pair)) throw new Error('unexpected split');
```

## Types

- `Failure<Code, Data>`: a failure value.
- `FailureOf<typeof fn>` and `SuccessOf<typeof fn>`: the failures and the success value a function returns, sync or async.
- `Result<Value, Failures>`: `Value | Failures`, for a return type written by hand (a port or an interface).
- `Stoppable<Value, Failures>`: `Value & { readonly stoppedBy?: Failures }`, a partial success (see above).
- `FailureDefinition<Code, Schema>`, `MatchHandlers<Value>`, `RecoverHandlers<Value>`.
- `DataOf<Schema>`: the data a failure carries, the schema's **output** type (the live value), or `undefined` without a schema.

## Lint: `@arki/failure/eslint`

A failure is a return value, so the compiler checks it only when the value is used. A call whose result is thrown away drops its failure silently:

```ts
import { id, a, b, remove } from './fixture.ts';

await remove(id); // ✗ failure/must-use: this call can return a failure ("post.not_found") and its result is thrown away
void (await remove(id)); // ✗ `void` hides the failure too
await Promise.all([remove(a), remove(b)]); // ✗ each item's failure is dropped (same for Promise.allSettled)

// eslint-disable-next-line failure/must-use -- the post may already be gone, and either way we are done
await remove(id); // ✓ dropped on purpose, with the reason in the comment
```

The disable comment is the only deliberate discard. A kept value (`const result = await remove(id)`) is left to the compiler and the unused-variable rules.

The rule also checks callbacks passed to `void` signatures, including function references and callback properties. Return a failure only where the receiving API preserves that result; otherwise handle it inside the callback. Discarded arrays, tuples, settled promise results and iterator reads retain their element failures through forwarding helpers. Arbitrary object fields and cold iterable construction are outside this rule's result protocols.

`no-blind-accept` guards a helper that lets one checked refusal through, such as `accept` on an `@arki/journal` command context. Accepting any failure accepts every refusal, including codes the callee adds later, so check the kind first:

```ts
import { isFailure } from '@arki/failure';

import { accept, Busy, OutOfStock, r } from './fixture.ts';

if (isFailure(r)) accept(r); // ✗ failure/no-blind-accept: any failure, not one you checked
accept(r); // ✗ not checked at all
if (OutOfStock.is(r)) accept(r); // ✓ one kind
if (OutOfStock.is(r) || Busy.is(r)) accept(r); // ✓ each kind checked by name
```

"Checked by kind" comes from types and the nearest condition about the value. Every part must be a failure with a literal `code`. Each `||` branch must check one named kind or compare `code` to one literal value. A bare `isFailure` is rejected even when the result currently has only one refusal. A preceding `if (!guard) return` or `throw` is checked the same way. A directly constructed failure remains valid. Const aliases preserve the checked value's identity. Multiple codes checked through a `switch` or more complex control flow still require an enclosing kind check. The checked calls default to `accept`, including member calls, static computed properties, imported aliases and local const aliases; set `names` to check others: `'failure/no-blind-accept': ['error', { names: ['accept', 'handled'] }]`. Mutable helper aliases are not followed. A call whose argument cannot be a failure (such as `dialog.accept('yes')`) is left alone.

```js skip="needs an app's eslint config and typescript-eslint"
// eslint.config.js
import tseslint from 'typescript-eslint';

import failure from '@arki/failure/eslint';

export default [
  // The rules are type-aware: TypeScript files need the typescript-eslint parser with projectService.
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
import { oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import { z } from 'zod';

import { errorMap, orThrowRpc } from '@arki/failure/orpc';

import { PostId, PostNotFound, PostSchema, type AppContext } from './fixture.ts';

// entrypoints/rpc.ts
export const rpc = {
  byId: oc.errors(errorMap(PostNotFound)).input(z.object({ id: PostId })).output(PostSchema),
};

// entrypoints/procedures.ts
const impl = implement(rpc).$context<AppContext>();
export const procedures = {
  byId: impl.byId.handler(({ context, input, errors }) => orThrowRpc(context.usecases.find(input.id), errors)),
};
```

- `errorMap(...definitions)` builds the contract's error map. Two definitions with one code throw `ARKI_FAILURE_E005`.
- `rpcFailureDefinitions(contract['~orpc'].errorMap)` recovers those same canonical definitions for another adapter. `errorMap` retains each reference under `RPC_FAILURE_DEFINITION`, an enumerable symbol preserved by native contract copies and omitted by JSON. Adapters can pass the inferred list to `reviveRpcError` without redeclaring failures.
- `orThrowRpc(value, errors)` returns the value, or throws the failure through the handler's `errors`: the typed `ORPCError` the contract declares, with the failure's message and data. The client gets it as `defined: true`.
- `orThrowRpc(value, errors, success)` throws the failure the same way, or returns `success`. It is for a usecase that returns nothing or a failure: `return orThrowRpc(await disconnect(id), errors, { success: true })`.
- A failure the usecase can return but the contract does not list is a compile error: `Property '"post.locked"' is missing in type …`. Add its definition to `errorMap(...)`. If the types are bypassed anyway, the failure arrives as undeclared (`defined: false`).
- Forgetting `orThrowRpc` is a compile error: `Post | Failure` is not the procedure's output.
- `reviveRpcError(error, definitions)` is the client side: a caught `ORPCError` whose code is one of the definitions becomes the live failure, its data checked like `revive`. Non-oRPC errors return `undefined`; unknown codes or invalid data return typed protocol failures. Then `match` on the failure as the backend does.

```ts run
import { isFailure } from '@arki/failure';
import { reviveRpcError } from '@arki/failure/orpc';

import { client, PostNotFound } from './fixture.ts';

const id = 'missing';
const post = await client.posts.byId({ id }).catch((error: unknown) => {
  const failure = reviveRpcError(error, [PostNotFound]);
  if (failure === undefined) throw error;
  return failure;
}); // Post | Failure<'post.not_found', …>
if (!isFailure(post)) throw new Error('expected the failure');
```

`@orpc/client` is an optional peer dependency, needed only for this entry. The entry imports nothing from `@orpc/server`, so contract files and client code that use it can ship to browsers.

## Adopting in an app

An app that adopts the package meets three gates:

- **The contract lint.** Contract files may import only an allow-list. The workspace's `tooling/eslint/feature-layers.js` already allows `@arki/failure/orpc`.
- **The browser package list.** An app's import-purity and rpc-purity checks list the packages the browser may load. Add `@arki/failure` and `@arki/failure/orpc`; the app template already has them.
- **The definitions as runtime values.** The client needs the definitions themselves, for `reviveRpcError`, not only their types. Export them from a narrow backend entry next to the contract, such as a `./posts/failures` entry, so the browser does not load the rest of the backend.

## Failure behaviour

The package returns typed domain, validation and protocol failures. Owned boundaries return distinct defects with private causes. Invalid static definitions and explicit exception bridges still throw.

- **Expected failures are values.** `defineFailure(...)(data)` makes one. Your functions return it. Check with `isFailure` or `Def.is`, then use `match` or `recover`.
- **Misuse throws `FailureError`.** A bad status, a missing handler or a duplicate code is a bug in the calling code. Do not catch it. Fix the call. Match on `error.code`, never on the message.
- **`orThrow` and `orThrowRpc` throw on purpose.** `orThrow` throws an `UnexpectedFailure` that keeps `failure`, `code`, `status`, `remediation` and the `cause`. Use it only where a failure would be a bug.
- **`revive` returns typed protocol failures.** Unknown codes are distinct from unrelated values.

A `FailureError` has a stable `code` and a one-sentence `remediation`. Each code has a page at `https://arki.dev/errors/<code>`.

| Code                | When                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `ARKI_FAILURE_E001` | `defineFailure` got an empty code, or the reserved code `ok`.                                    |
| `ARKI_FAILURE_E002` | `defineFailure` got a status that is not an integer from 400 to 599.                             |
| `ARKI_FAILURE_E003` | `match` met a failure code it has no handler for (types were bypassed).                          |
| `ARKI_FAILURE_E004` | `assertNever` was reached.                                                                       |
| `ARKI_FAILURE_E005` | `errorMap` got two definitions with the same code.                                               |
| `ARKI_FAILURE_E006` | Retired: revival now returns `InvalidEnvelope` with reason `invalid_data`. |
| `ARKI_FAILURE_E007` | Retired: revival now returns `AsyncSchema`.        |

## Limits

- **A failure is a plain frozen object, not an `Error`.** It has no stack trace. Log `failure.code` and `failure.data`, and keep the `cause` chain for the stack of a caught error.
- **A returned failure does not roll back.** A database transaction callback that returns a failure commits. Throw inside the transaction, or use a helper that rolls back on a returned failure.
- **Codes are unique per app.** The package cannot see another definition with the same code until `errorMap` receives both.
- **Status is 400 to 599.** `defineFailure` throws `ARKI_FAILURE_E002` for anything else.
- **Failure data must pass its own schema.** Wire validation is synchronous and must accept its own JSON output unchanged; otherwise the boundary returns a typed failure.
- **The compiler only sees what the return type shows.** A function that returns `unknown` or `any` hides its failures. The lint rule `must-use` only checks calls it can type.

The status boundary, as code:

```ts run expect
import { defineFailure, FAILURE_ERROR_CODES, FailureError } from '@arki/failure';

try {
  defineFailure('thing.broken', { status: 200 });
  throw new Error('expected defineFailure to refuse status 200');
} catch (error) {
  if (!(error instanceof FailureError) || error.code !== FAILURE_ERROR_CODES.invalidStatus) throw error;
  console.log(error.code);
}
```

```text
ARKI_FAILURE_E002
```

## Pitfalls

- **A discarded call drops its failure.** Turn on the `must-use` rule.
- **`accept` after `isFailure` accepts every refusal.** Check the kind with `Def.is` first; the `no-blind-accept` rule reports it.
- **`unknown`, `any` and `object` swallow failures.** A function whose return type widens to one of them loses its failures from the type. Parse with a schema instead of casting to `unknown`, and assert `FailureOf<typeof fn>` in a test when it matters.
- **Truthiness does not narrow.** A failure is an object, so `if (post)` and `post ?? fallback` do not remove it. Use `isFailure`.
- **A data schema must accept its own output.** `revive` rejects a wire value when validation changes it; represent transformed domain data with a separate JSON-safe definition.
- **Data that is itself a failure is ambiguous.** Do not return stored failures as success data; wrap them (`{ failure }`).

## Why no wrapper?

- **Effect** puts failures in an `Effect<A, E, R>` type that needs its runtime and its own ecosystem. This package gives the visible-failure part with plain functions that work with every library.
- **neverthrow, true-myth and Effect's `Result`** wrap both sides in an object. Every success needs `ok(…)`, every caller needs `.value`, and every boundary that expects plain values (Drizzle, oRPC outputs, React Query) needs an unwrap. Here the success is the value itself, and the definition carries the code, status, data schema and message that boundaries read.

Research behind the design: `docs/arki/research/07-result/` in the Arki monorepo.

## Documentation

- [Agent guide](docs/agent-guide.md): tasks, step by step.
- [llms.txt](llms.txt): the map for agents.
- [CHANGELOG](CHANGELOG.md).

## Support

Report bugs and ask questions at https://github.com/arki-labs/arki/issues.

## Validation foundation: `@arki/failure/schema`

`parse(schema, input)` returns the schema output or `InvalidInput`, `AsyncSchema`, or `ValidatorDefect`. `parseAsync` returns output or `InvalidInput`/`ValidatorDefect`. Their exact failure types are `SchemaFailure` and `AsyncSchemaFailure`. `InvalidInput.data.issues` contains normalized issue messages and paths. Defect messages are safe; their caught causes are private.

`@arki/schema` reexports these functions and provides issue formatting and JSON Schema helpers. There is one executor and no dependency cycle. Use `orThrow` only at an explicit foreign API that requires exceptions. See [the migration guide](docs/upgrade-typed-validation.md).
