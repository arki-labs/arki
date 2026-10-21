# @arki/ts for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. Most of the package is types. Types cost nothing at runtime.
2. Three small runtime helpers exist: `once`, `lazyObject`, `resolveLazy`. `expectImportPure` lives on `@arki/ts/testing` and needs Node.
3. Every type has an `expectTypeOf` assertion in `src/types.test-d.ts`. Read it to see the exact result.
4. The helpers cover plain objects and string keys. They are small on purpose.

## Task map

### Type a lookup by dotted path

1. Build the union of valid paths with `RecordToPath<typeof value>`.
2. Constrain a generic to it: `P extends RecordToPath<T>`.
3. Return `PathValue<T, P>`.

```ts
import { expectTypeOf } from 'vitest';

import type { PathValue, RecordToPath } from '@arki/ts';

const flags = { beta: { search: true, chat: false } } as const;
declare function flag<P extends RecordToPath<typeof flags>>(path: P): PathValue<typeof flags, P>;

expectTypeOf(flag('beta.search')).toEqualTypeOf<true>();
```

### Convert API keys between snake_case and camelCase

1. Use `DeepSnakeToCamel<T>` for a response from a snake_case API.
2. Use `DeepCamelToSnake<T>` for a request body.
3. The runtime conversion is your code. The type only describes it.

```ts
import { expectTypeOf } from 'vitest';

import type { DeepSnakeToCamel } from '@arki/ts';

type ApiUser = { user_name: string; home_address: { zip_code: string } };
expectTypeOf<DeepSnakeToCamel<ApiUser>>().toEqualTypeOf<{ userName: string; homeAddress: { zipCode: string } }>();
```

### Build a shared object at import time without side effects

1. Wrap the construction in `lazyObject(() => create(...))`.
2. Export the result. Reading a property builds it, once.
3. Prove it with `expectImportPure` from `@arki/ts/testing`.

### Make a config field take a value or a function

1. Type it `Lazy<T>`.
2. Call `resolveLazy(field)` where the value is needed.

## Rules that bite

- `RecordToPath` stops at arrays. There is no `'list.0'`.
- `PathValue` rejects a path that is not in `RecordToPath`. The error is TS2344.
- `DeepPartial` also recurses into functions and class instances.
- `CamelToSnake` drops number and symbol keys. `SnakeToCamel` keeps them.
- `once` retries after a synchronous throw. It remembers a rejected promise.
- `@arki/ts/testing` spawns a subprocess. Do not import it in a browser bundle.
- Type assertions run in `bun run typecheck`, not in `bun run test`.

## Errors

| Code     | Meaning                                       | What to do                                                                   |
| -------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| none     | The package defines no error codes.           | Types fail at compile time. Runtime helpers throw what your callback throws. |
| `TS2344` | A path is not in `RecordToPath<T>`.           | Fix the path. The message lists the valid ones.                              |
| `TS2589` | A deep helper hit the compiler's depth limit. | Flatten the input type or apply the helper per branch.                       |

## Verify

```sh
bun run typecheck
bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
