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
  Prettify,
  DeepPartial,
  DeepRequired,
  SnakeToCamel,
  CamelToSnake,
  RecordToPath,
  PathValue,
  Nullable,
  Serializable,
  Autocomplete,
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

## Documentation

`@arki/ts` is framework-agnostic and works on its own. When you compose
it with the [`@arki/dot`](https://www.npmjs.com/package/@arki/dot)
application framework, see `packages/dot/docs/` for plugin authoring,
lifecycle, and diagnostics.

## License

MIT. See [LICENSE](./LICENSE).
