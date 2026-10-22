# @arki/failure for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. A failure is a frozen object `{ code, message, data, status, remediation }` with a hidden brand. A function returns it like any other value.
2. `defineFailure(code, options)` makes a definition. Calling the definition makes a failure.
3. Success has no wrapper. The return type is `Value | Failure<...>`, inferred.
4. The data schema is any Standard Schema; the foundation imports spec types directly and never depends on `@arki/schema`.
5. Misuse of the package throws `FailureError`. That is a bug in the caller, not a failure.
6. The core has no runtime built-ins. It runs in Node, Bun, Deno, browsers and Hermes.

## Task map

### Define and return a failure

1. Call `defineFailure('feature.reason', { status, data, message })` once, in a module the whole feature can import.
2. Return `Def(data)` where the thing is missing or refused.
3. Do not annotate the return type.

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

### Check a result

1. Call `isFailure(result)` and return it, or use `match` to handle each code.
2. Use `recover` to handle some codes and pass the rest on.

```ts from="examples/posts.ts#early-return"
export async function titleOf(id: string) {
  const post = await find(id);
  if (isFailure(post)) return post; // the failure joins this function's inferred result
  return post.title; // narrowed to Post
}
```

### Handle every code

```ts from="examples/posts.ts#match"
export async function label(id: string) {
  return match(await find(id), {
    ok: post => post.title,
    'post.not_found': failure => `missing ${failure.data.id}`,
  });
}
```

### Handle some codes

```ts from="examples/posts.ts#recover"
export async function titleOrDraft(id: string) {
  return recover(await find(id), { 'post.not_found': () => 'Untitled draft' });
}
```

### Cross an oRPC boundary

1. In the contract, add `.errors(errorMap(Def))`.
2. In the procedure, return `orThrowRpc(usecaseResult, errors)`.
3. On the client, call `reviveRpcError(error, [Def])` in a `catch`, rethrow unrelated errors (`undefined`), and handle the domain and canonical `REVIVAL_FAILURES` branches.

### Turn a throwing call into a failure

1. Wrap the call in `attempt(run, onThrow)`.
2. Return a failure from `onThrow`, or rethrow what you do not recognise.

### Lint discarded failures

1. Add `failure.configs.recommended` from `@arki/failure/eslint` to `eslint.config.js`.
2. Make sure TypeScript files use `typescript-eslint` with `projectService: true`.

## Rules that bite

- A discarded call drops its failure. Turn on `failure/must-use`.
- Truthiness does not narrow. `if (post)` and `post ?? fallback` keep the failure.
- `unknown`, `any` and `object` swallow failures from a return type.
- Wire data must be lossless JSON, accepted unchanged by its schema. `revive` returns typed protocol failures for invalid envelopes.
- A returned failure does not roll back a transaction. Throw inside it.
- `401` means "not signed in" only. Use `422` when an upstream refuses us.

## Errors

| Code                | Meaning                                       | What to do                                          |
| ------------------- | --------------------------------------------- | --------------------------------------------------- |
| `ARKI_FAILURE_E001` | `defineFailure` got an empty code or `ok`.    | Use a dotted code such as `post.not_found`.         |
| `ARKI_FAILURE_E002` | Status is not an integer from 400 to 599.     | Pass a valid status or none.                        |
| `ARKI_FAILURE_E003` | `match` met a code it has no handler for.     | Add the handler; fix the cast that hid it.          |
| `ARKI_FAILURE_E004` | `unreachable` was reached.                    | Handle the new case; validate data at the boundary. |
| `ARKI_FAILURE_E005` | `errorMap` got two definitions with one code. | Give each definition its own code.                  |
| `ARKI_FAILURE_E006` | Retired; use `InvalidEnvelope`.               | Check stored data; avoid transforming schemas.      |
| `ARKI_FAILURE_E007` | Retired; use `AsyncSchema`.                   | Use a synchronous schema for failure data.          |
| `ARKI_FAILURE_E008` | An `invariant` condition was falsy.           | Fix the caller that broke the assumption.           |

## Verify

```sh
bun run typecheck
bun run test
bun run test:docs
```

See [typed validation migration](upgrade-typed-validation.md) for canonical failures, parsing and versioned JSON transport.
