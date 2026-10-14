# @arki/feature

Declare a backend feature once — its router fragment, repository
factory, background-job and schedule slices, service needs, and boot —
as one inert value, then derive everything from the list of features.

`@arki/feature` is framework-light: the main entry has **zero runtime
dependencies** and no coupling to any runtime. The optional `./dot`
entry projects a feature onto the [`@arki/dot`](https://github.com/arki-labs/dot)
plugin kernel.

```bash
npm install @arki/feature
```

## The idea

A feature is a plain `const` — importing it observes nothing (no env,
no connections). Your app keeps exactly one membership list, and every
app-level artifact folds from it:

```ts
import { defineFeature, composeRouter, composeRepos } from '@arki/feature';

export const orders = defineFeature('orders', {
  router: { orders: ordersRouter },          // mount-key → router fragment
  repos: { orders: createOrdersRepository }, // key → (db) => repository
  needs: { db: service<Db>() },
  boot: ({ db }) => ({ ordersIndex: buildIndex(db) }),
});

// THE list — written once, everything derives from it.
export const features = [orders, billing, catalog] as const;

export const appRouter = composeRouter(features); // typed, exact per-key
export const repos = composeRepos(features, db);  // typed record fold
```

Duplicate mount keys throw at module load. The composed types are
exact — `ComposedRouter<typeof features>` preserves each fragment's
inferred type, so client-side inference (tRPC/oRPC style) stays intact.

## Slices

Cross-cutting adapters contribute through **slice contracts** — small
`{ key, resolve(services) }` records supplied via `use:`. Adapter
packages export the wrappers (e.g. a queue package's `jobs(...)`, an
http package's `endpoints(...)`); `@arki/feature` only defines the
shape, so the main entry stays dependency-free.

```ts
export const orders = defineFeature('orders', {
  // …
  use: [jobs(orderJobs), endpoints(({ db }) => orderRoutes(db))],
});
```

## Plugging into @arki/dot

The `./dot` entry turns features into kernel plugins:

```ts
import { plug, plugs, tokens, tokenOf } from '@arki/feature/dot';

defineApp('shop')
  .useAll(plugs(features))            // boot order = list order
  .use(http({ port: () => env.PORT, features: tokens(features) }));
```

`plug(feature)` yields a `Plugin` whose needs/provides derive from the
feature's declaration; `tokenOf`/`tokens` give the typed service tokens
adapters collect slices from.

## API

| Export | What it is |
| --- | --- |
| `defineFeature(name, spec)` | The authoring construct — returns an inert `Feature` value |
| `composeRouter(features)` | Fold router fragments; throws on duplicate mount keys |
| `composeRepos(features, db)` | Fold repository factories over a database handle |
| `FeatureSlice`, `SlicePayloads` | The slice contract adapter packages implement |
| `ComposedRouter`, `ComposedRepos`, `RepoDatabaseOf` | Exact derived types |
| `plug`, `plugs`, `tokens`, `tokenOf` (`./dot`) | Projection onto the `@arki/dot` kernel |

## Design rules it encodes

- **Declarations are inert** — importing a feature (or the list) is
  observationally free; effects live in `boot()` and request handlers.
- **One membership list** — boot order, router shape, repo record, and
  adapter wiring all derive from the same tuple; there is no second
  list to forget.
- **Dependencies point one way** — features import their contracts,
  never each other's internals; composition happens above them.

<!-- bench:start -->
## Benchmarks

There is no direct npm competitor for `@arki/feature`: it is a small declaration layer for backend domain modules. So the comparison is against the hand-written wiring a team would write without it, a plain object of the same shape and a loop that merges them. Each case uses 50 features, each with a router fragment, a repository factory and a boot-time slice.

Node v22.13.1 on Apple M2 Max, 2026-10-13. Median time per operation, lower is better.

### Declare 50 features

Build the 50 feature values from ready-made specs.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/feature (defineFeature) | 2.71 µs | fastest |
| hand-written object literal | 3.36 µs | 1.24× |

### Compose the router fragments of 50 features

`composeRouter` rejects duplicate mount keys. The first hand-written row does not check; the second does.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/feature (composeRouter) | 34.05 µs | 3.02× |
| hand-written merge (Object.assign, no check) | 11.29 µs | fastest |
| hand-written merge with duplicate check | 26.93 µs | 2.39× |

### Build the repositories of 50 features over one database handle

Calls each repository factory once. `composeRepos` rejects duplicate repo keys; the hand-written rows show the loop without and with that check.

| Library | Time / op | vs fastest |
| --- | ---: | ---: |
| @arki/feature (composeRepos) | 14.44 µs | 1.06× |
| hand-written loop (no check) | 13.67 µs | fastest |
| hand-written loop with duplicate check | 26.24 µs | 1.92× |

Read the rows with the contracts in mind:

- `defineFeature` copies a spec into the declared shape and fills in defaults. The hand-written object skips defaults and does no checking.
- `composeRouter` and `composeRepos` throw a coded error when two features claim the same key (and fail to compile under TypeScript). The plain merge (`Object.assign`) silently lets the last feature win, so the fair baseline is the loop with its own duplicate check, shown as a separate row.
- All of this runs once at module load, not per request. The numbers show it costs microseconds, not that it needs tuning.

Reproduce with `bun run bench` in the package directory; regenerate this section with `bun run bench --write-readme`.
<!-- bench:end -->

## License

MIT © ARKI Contributors
