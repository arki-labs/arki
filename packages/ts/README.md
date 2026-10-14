# @arki/ts

TypeScript utility types — `Prettify`, `DeepPartial`, `SnakeToCamel`, `RecordToPath`, and other type helpers.

## Installation

```sh
npm install @arki/ts
# or
bun add @arki/ts
# or
pnpm add @arki/ts
```

## Usage

```ts
import type {
  Autocomplete,
  CamelToSnake,
  DeepPartial,
  DeepRequired,
  Nullable,
  PathValue,
  Prettify,
  RecordToPath,
  Serializable,
  SnakeToCamel,
  Without,
} from '@arki/ts';

type Flat = Prettify<{ a: string } & { b: number }>;
// { a: string; b: number }

type Optional = DeepPartial<{ a: { b: { c: number } } }>;
// { a?: { b?: { c?: number } } }

type CamelKeys = SnakeToCamel<'user_name'>;
// 'userName'

const config = { http: { port: 8080 } } as const;
type Path = RecordToPath<typeof config>;
// 'http' | 'http.port'
type Value = PathValue<typeof config, 'http.port'>;
// 8080
```

## API

### Object shape helpers

- `Prettify<T>` — flatten an intersection so the IDE shows the resolved shape.
- `DeepPartial<T>` — recursively mark every property optional.
- `DeepRequired<T>` — recursively mark every property required.
- `Nullable<T, K>` — make selected keys nullable.
- `Without<T, W>` — `Omit` variant that does not flatten unions.
- `Serializable<T>` — strip non-serializable (function) props.

### Casing

- `SnakeToCamel<T>` / `DeepSnakeToCamel<T>` — convert snake_case to camelCase, optionally recursing.
- `CamelToSnake<T>` / `DeepCamelToSnake<T>` — reverse direction.

### Path helpers

- `RecordToPath<T>` — union of all nested keys (`'a' | 'a.b' | 'c'`).
- `PathValue<T, P>` — read the type at a dotted path.

### Misc

- `Autocomplete<U, T>` — union that still autocompletes literal members.

## Subpath imports

Individual modules are also exposed:

```ts
import type { Prettify } from '@arki/ts/prettify';
import type { DeepPartial } from '@arki/ts/utils';
```

## Runtime support

The main entry (`@arki/ts`) and the type-only subpaths (`/prettify`, `/utils`) are portable. The only runtime code is `once`, `resolveLazy` and `lazyObject`, which use `Proxy` and no `node:*` imports, so they run on Node, Bun, Deno, browsers and React Native (Hermes). `@arki/ts/testing` is the one Node-only entry: it spawns a subprocess to check import purity. `bun run test:runtimes` runs a smoke test of the portable entries on each runtime; the Hermes leg needs `HERMES_BIN` and prints `INCOMPLETE` when it is missing.

## Documentation

`@arki/ts` is framework-agnostic and works on its own. When you compose
it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

<!-- bench:start -->

## Benchmarks

Type-check cost of the helpers in `@arki/ts` against their closest equivalents in type-fest and ts-essentials, counted with TypeScript 6.0.3. The package has no runtime code, so the cost that matters is how much work the compiler does to resolve each helper.

Measured on Node 22.13.1 (Darwin 27.0.0 arm64, Apple M2 Max (12 cores)) · @arki/bench 0.0.2 (mitata 1.0.34) · publish, seed 1592639052 · commit eeb0867c7e · 2026-10-13.

Versions: @arki/bench 0.0.2 · @arki/ts 0.0.3 · mitata 1.0.34 · ts-essentials 10.2.1 · type-fest 5.10.0.

### Flatten an intersection (Prettify)

Deterministic metric in instantiations: measured once.

| Library                | Version |       instantiations | vs @arki/ts Prettify     |
| ---------------------- | ------- | -------------------: | ------------------------ |
| **@arki/ts Prettify**  | 0.0.3   | 2,120 instantiations | baseline                 |
| type-fest Simplify     | 5.10.0  | 2,120 instantiations | ≈ same                   |
| ts-essentials Prettify | 10.2.1  | 2,200 instantiations | 1.04× higher [1.04–1.04] |

Forty intersections of four object types, flattened into one object type. Checked: equivalent to the hand-written object and not an intersection.

### Make every property optional, deeply (DeepPartial)

Deterministic metric in instantiations: measured once.

| Library                   | Version |        instantiations | vs @arki/ts DeepPartial |
| ------------------------- | ------- | --------------------: | ----------------------- |
| **@arki/ts DeepPartial**  | 0.0.3   |  7,189 instantiations | baseline                |
| type-fest PartialDeep     | 5.10.0  | 14,435 instantiations | 2.0× higher [2.0–2.0]   |
| ts-essentials DeepPartial | 10.2.1  | 14,664 instantiations | 2.0× higher [2.0–2.0]   |

Five object types, four levels deep, three properties per level.

### Rename snake_case keys to camelCase, deeply

Deterministic metric in instantiations: measured once.

| Library                               | Version |        instantiations | vs @arki/ts DeepSnakeToCamel |
| ------------------------------------- | ------- | --------------------: | ---------------------------- |
| **@arki/ts DeepSnakeToCamel**         | 0.0.3   | 10,050 instantiations | baseline                     |
| type-fest CamelCasedPropertiesDeep    | 5.10.0  | 33,247 instantiations | 3.3× higher [3.3–3.3]        |
| ts-essentials DeepCamelCaseProperties | 10.2.1  | 18,679 instantiations | 1.9× higher [1.9–1.9]        |

Five object types, four levels deep, three properties per level.

### List every dotted property path

Deterministic metric in instantiations: measured once.

| Library                   | Version |        instantiations | vs @arki/ts RecordToPath |
| ------------------------- | ------- | --------------------: | ------------------------ |
| **@arki/ts RecordToPath** | 0.0.3   |  1,814 instantiations | baseline                 |
| type-fest Paths           | 5.10.0  | 18,121 instantiations | 10.0× higher [10.0–10.0] |
| ts-essentials Paths       | 10.2.1  | 10,702 instantiations | 5.9× higher [5.9–5.9]    |

Five object types, three levels deep, three properties per level (39 paths each).

### Read the type at a dotted path

Deterministic metric in instantiations: measured once.

| Library                 | Version |        instantiations | vs @arki/ts PathValue    |
| ----------------------- | ------- | --------------------: | ------------------------ |
| **@arki/ts PathValue**  | 0.0.3   |  1,034 instantiations | baseline                 |
| type-fest Get           | 5.10.0  | 28,934 instantiations | 28× higher [28–28]       |
| ts-essentials PathValue | 10.2.1  |  1,074 instantiations | 1.04× higher [1.04–1.04] |

Five object types, three levels deep; each read asks for the first leaf.

**Notes**

- Before counting, every library’s result is compared with a hand-written expected type: it must be assignable to it and back, and must not be `any`, `unknown` or `never`. The Prettify results must also be one object type, not an intersection. A mismatch stops the run.
- The number is type instantiations: how many types the checker creates for the fixture, minus an empty file. It is deterministic for one TypeScript version and machine-independent. Check time (wall clock) is not reported.
- @arki/ts helpers are small and cover plain objects and string keys. type-fest and ts-essentials handle more input (arrays, tuples, optional keys, unions of objects, options for how to treat them), which costs extra instantiations. A lower count here is a smaller feature set as much as it is a cheaper type.
- `DeepSnakeToCamel` only converts snake_case. type-fest `CamelCasedPropertiesDeep` and ts-essentials `DeepCamelCaseProperties` accept more key styles.

Reproduce: `bunx arki-bench run --profile publish` in the package directory.

<!-- bench:meta {"schema":1,"suite":"@arki/ts","specHash":"490c2acccb26e1f0","profile":"publish","date":"2026-10-13T11:40:27.207Z","harness":"0.0.2"} -->
<!-- bench:end -->

## License

MIT. See [LICENSE](./LICENSE).
