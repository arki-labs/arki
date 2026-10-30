# @arki/ts

TypeScript helper types for object shapes, key casing and dotted paths, plus two tiny runtime helpers (`once`, `lazyObject`) and an import-purity test helper. The types cost the compiler little to resolve (see Benchmarks).

## Install

```sh
bun add @arki/ts
# or
npm install @arki/ts
```

## Quick start

Read a setting by its dotted path, and let the compiler know the exact type at that path. A wrong path is a compile error.

```ts
import { expectTypeOf } from 'vitest';

import type { DeepPartial, PathValue, RecordToPath } from '@arki/ts';

const defaults = { http: { port: 8080, host: 'localhost' } } as const;

type SettingPath = RecordToPath<typeof defaults>; // 'http' | 'http.port' | 'http.host'
declare function getSetting<P extends SettingPath>(path: P): PathValue<typeof defaults, P>;

const port = getSetting('http.port'); // type: 8080
expectTypeOf(port).toEqualTypeOf<8080>();
// getSetting('http.prot'); // compile error: not a path of defaults

type Overrides = DeepPartial<typeof defaults>; // every level optional: { readonly http?: { readonly port?: 8080; ... } }
```

`src/types.test-d.ts` holds one `expectTypeOf` assertion for every helper below. The build fails when a promise in this README stops being true.

## When not to use this

- You need arrays and tuples handled inside paths (`'list.0.id'`). `RecordToPath` stops at an array: the list is a leaf.
- You need many key styles (kebab, Pascal, constant case). `DeepSnakeToCamel` converts snake_case only. Use `type-fest` for more styles, at a higher compile cost.
- You need branded types, schema inference or validation. Use `@arki/schema`.
- You need a runtime check that a value has a shape. Types vanish at runtime. Validate with a schema.

## Runtime support

The main entry (`@arki/ts`) and the type-only subpaths (`/prettify`, `/utils`) are portable. The only runtime code is `once` and `lazyObject`, which use `Proxy` and no `node:*` imports, so they run on Node, Bun, Deno, browsers and React Native (Hermes). `@arki/ts/testing` is the one Node-only entry: it spawns a subprocess to check import purity. `bun run test:runtimes` runs a smoke test of the portable entries on each runtime. The Hermes leg needs `HERMES_BIN` and prints `INCOMPLETE` when it is missing.

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

| Import              | Exports                                               |
| ------------------- | ----------------------------------------------------- |
| `@arki/ts`          | everything below except `expectImportPure`            |
| `@arki/ts/utils`    | the casing, path and shape types (types only)         |
| `@arki/ts/prettify` | `Prettify` (type only)                                |
| `@arki/ts/testing`  | `expectImportPure`, `ImportPurityOptions` (Node only) |

### Object shape helpers

- `Prettify<T>`: flatten an intersection so the IDE shows the resolved shape.
- `DeepPartial<T>`: recursively mark every property optional.
- `DeepRequired<T>`: recursively mark every property required.
- `Nullable<T, K>`: make selected keys nullable.
- `Without<T, W>`: an `Omit` variant that does not flatten unions.
- `Serializable<T>`: strip function members.

### Casing

- `SnakeToCamel<T>` and `DeepSnakeToCamel<T>`: convert snake_case to camelCase, one level or all levels.
- `CamelToSnake<T>` and `DeepCamelToSnake<T>`: the reverse.

### Path helpers

- `RecordToPath<T>`: the union of all nested keys (`'a' | 'a.b' | 'c'`).
- `PathValue<T, P>`: the type at a dotted path.

### Misc

- `Autocomplete<U, T>`: a union that still autocompletes its literal members.

### Runtime helpers

- `once(compute)`: run `compute` on the first call and return the same result after that.
- `lazyObject(build)`: an object whose construction waits for its first property access.

```ts run
import { lazyObject } from '@arki/ts';

const builds: string[] = [];
const settings = lazyObject(() => {
  builds.push('built');
  return { url: 'postgres://localhost/app' };
});
// Nothing was built when the module loaded.
const count = (): number => builds.length;
if (count() !== 0) throw new Error('built too early');
if (settings.url !== 'postgres://localhost/app') throw new Error('wrong value');
if (settings.url !== 'postgres://localhost/app' || count() !== 1) throw new Error('should build once');
```

## Failure behaviour

The types never throw. A wrong use is a compile error. `PathValue<Config, 'http.missing'>` fails with TS2344, and the message lists the valid paths.

The runtime helpers throw only what your code throws:

- `once(compute)`: a synchronous throw is not remembered, so the next call retries. A rejected promise that `compute` returns is remembered. Add your own retry when an async boot may fail.
- `lazyObject(build)`: `build` runs on the first property access, so a failure appears there, not at import. The next access retries.
- `expectImportPure` throws a plain `Error` with the subprocess output when an import reads the environment, throws or does not finish. It also throws when you pass no entry paths. The package defines no error codes.

## Limits

- `RecordToPath` and `PathValue` treat arrays as leaves. `RecordToPath<{ list: { id: number }[] }>` is `'list'`, not `'list.0'`.
- A key that contains a dot (`'a.b'`) cannot be addressed as one segment. A path splits at the first dot.
- `DeepPartial` and `DeepRequired` recurse into every object, including functions and class instances. Wrap those in a leaf type if you need them left alone.
- The casing helpers work on string keys. The snake-to-camel helpers keep number and symbol keys. The camel-to-snake helpers drop them: `CamelToSnake<{ userName: 1; 0: 2 }>` is `{ user_name: 1 }`.
- Deep helpers have the compiler's recursion limit. A type with hundreds of nested levels reports TS2589.
- `lazyObject` is for objects. Do not compare its result by identity with the built instance. Reflected property descriptors are configurable views of the instance; writes and deletes still obey the real descriptors. Enumeration and spreads also work with frozen instances. Defining properties or freezing the proxy itself is unsupported.

## Documentation

- [Agent guide](./docs/agent-guide.md): tasks, rules that bite, errors.
- [llms.txt](./llms.txt): the index an agent reads first.
- [Changelog](./CHANGELOG.md).

`@arki/ts` works on its own. With the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot) application framework, see `packages/dot/docs/`.

## Support

Report a bug or ask a question at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues). Include the type, the input and the result you expected.

<!-- bench:start -->

## Benchmarks

Type-check cost of the helpers in `@arki/ts` against their closest equivalents in type-fest and ts-essentials, counted with TypeScript 6.0.3. The package has no runtime code, so the cost that matters is how much work the compiler does to resolve each helper.

Measured on Node 26.11.1 (Darwin 27.0.0 arm64, Apple M2 Max (12 cores)) · @arki/bench 0.1.0 (mitata 1.0.34) · publish, seed 1592639052 · commit 6ef27e464e · 2026-10-30.

Versions: @arki/bench 0.1.0 · @arki/ts 0.1.0 · mitata 1.0.34 · ts-essentials 10.2.1 · type-fest 5.10.0.

### Flatten an intersection (Prettify)

Deterministic metric in instantiations: measured once.

| Library                | Version |       instantiations | vs @arki/ts Prettify     |
| ---------------------- | ------- | -------------------: | ------------------------ |
| **@arki/ts Prettify**  | 0.1.0   | 2,120 instantiations | baseline                 |
| type-fest Simplify     | 5.10.0  | 2,120 instantiations | ≈ same                   |
| ts-essentials Prettify | 10.2.1  | 2,200 instantiations | 1.04× higher [1.04–1.04] |

Forty intersections of four object types, flattened into one object type. Checked: equivalent to the hand-written object and not an intersection.

### Make every property optional, deeply (DeepPartial)

Deterministic metric in instantiations: measured once.

| Library                   | Version |        instantiations | vs @arki/ts DeepPartial |
| ------------------------- | ------- | --------------------: | ----------------------- |
| **@arki/ts DeepPartial**  | 0.1.0   |  7,189 instantiations | baseline                |
| type-fest PartialDeep     | 5.10.0  | 14,435 instantiations | 2.0× higher [2.0–2.0]   |
| ts-essentials DeepPartial | 10.2.1  | 14,664 instantiations | 2.0× higher [2.0–2.0]   |

Five object types, four levels deep, three properties per level.

### Rename snake_case keys to camelCase, deeply

Deterministic metric in instantiations: measured once.

| Library                               | Version |        instantiations | vs @arki/ts DeepSnakeToCamel |
| ------------------------------------- | ------- | --------------------: | ---------------------------- |
| **@arki/ts DeepSnakeToCamel**         | 0.1.0   | 10,050 instantiations | baseline                     |
| type-fest CamelCasedPropertiesDeep    | 5.10.0  | 33,247 instantiations | 3.3× higher [3.3–3.3]        |
| ts-essentials DeepCamelCaseProperties | 10.2.1  | 18,679 instantiations | 1.9× higher [1.9–1.9]        |

Five object types, four levels deep, three properties per level.

### List every dotted property path

Deterministic metric in instantiations: measured once.

| Library                   | Version |        instantiations | vs @arki/ts RecordToPath |
| ------------------------- | ------- | --------------------: | ------------------------ |
| **@arki/ts RecordToPath** | 0.1.0   |  1,814 instantiations | baseline                 |
| type-fest Paths           | 5.10.0  | 18,121 instantiations | 10.0× higher [10.0–10.0] |
| ts-essentials Paths       | 10.2.1  | 10,702 instantiations | 5.9× higher [5.9–5.9]    |

Five object types, three levels deep, three properties per level (39 paths each).

### Read the type at a dotted path

Deterministic metric in instantiations: measured once.

| Library                 | Version |        instantiations | vs @arki/ts PathValue    |
| ----------------------- | ------- | --------------------: | ------------------------ |
| **@arki/ts PathValue**  | 0.1.0   |  1,034 instantiations | baseline                 |
| type-fest Get           | 5.10.0  | 28,934 instantiations | 28× higher [28–28]       |
| ts-essentials PathValue | 10.2.1  |  1,074 instantiations | 1.04× higher [1.04–1.04] |

Five object types, three levels deep; each read asks for the first leaf.

**Notes**

- Before counting, every library’s result is compared with a hand-written expected type: it must be assignable to it and back, and must not be `any`, `unknown` or `never`. The Prettify results must also be one object type, not an intersection. A mismatch stops the run.
- The number is type instantiations: how many types the checker creates for the fixture, minus an empty file. It is deterministic for one TypeScript version and machine-independent. Check time (wall clock) is not reported.
- @arki/ts helpers are small and cover plain objects and string keys. type-fest and ts-essentials handle more input (arrays, tuples, optional keys, unions of objects, options for how to treat them), which costs extra instantiations. A lower count here is a smaller feature set as much as it is a cheaper type.
- `DeepSnakeToCamel` only converts snake_case. type-fest `CamelCasedPropertiesDeep` and ts-essentials `DeepCamelCaseProperties` accept more key styles.

**Provenance**

- command: `arki-bench run --profile publish`
- profile: publish
- packages: @arki/bench 0.1.0, @arki/bench 0.1.0, @arki/ts 0.1.0, mitata 1.0.34, ts-essentials 10.2.1, type-fest 5.10.0
- machine: Darwin 27.0.0 arm64, Apple M2 Max (12 cores), 96 GB RAM
- source commit: 6ef27e464e30bca328554a621063e1618e34fdfe

provenance: 6ef27e464e30bca328554a621063e1618e34fdfe

Reproduce: `bunx arki-bench run --profile publish` in the package directory.

<!-- bench:meta {"schema":1,"suite":"@arki/ts","specHash":"490c2acccb26e1f0","profile":"publish","date":"2026-10-30T19:11:19.274Z","harness":"0.1.0"} -->
<!-- bench:end -->

## License

MIT. See [LICENSE](./LICENSE).
