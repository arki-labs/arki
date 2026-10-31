# @arki/tanstack-start

Shared TanStack Start wiring for Arki apps (router, server entry, Sentry, PWA, devtools) and the typed oRPC client layer.

## Install

```sh
bun add @arki/tanstack-start
```

Install the peers the entries you use need: `react`, `react-dom`, `@arki/dot`, `@arki/schedule`, `@orpc/openapi`, `nitro`, `@sentry/node`, `@sentry/react`, `@sentry/tanstackstart-react`. The `@arki/dot`, `@arki/schedule`, `@orpc/openapi`, `nitro` and Sentry peers are optional.

## Quick start

`withForwardedProto` is the smallest entry to try. A proxy that ends TLS talks plain HTTP to the app. This function rebuilds a GET or HEAD request with an `https:` URL when the proxy sent `X-Forwarded-Proto: https`.

```ts run
import { withForwardedProto } from '@arki/tanstack-start/server';

const incoming = new Request('http://pizzeria.example/menu', {
  headers: { 'x-forwarded-proto': 'https' },
});

console.log(withForwardedProto(incoming).url);
```

The other entries are below: the oRPC client, the query hooks, the Vite plugins, and the proxy helper in full.

## When not to use this

- The app does not run on TanStack Start. The router, server entry and Vite helpers assume it.
- The app does not use oRPC. The `orpc/*` entries build on oRPC contracts and procedures.

## Runtime support

The entries are split by where they run, as the `exports` map says.

| Runs in           | Entries                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| browser           | `.`, `./router`, `./orpc/client`, `./orpc/query`, `./scripts`, `./error`, `./devtools`, `./sentry/client`, `./pwa/sw`, `./pwa/client` |
| Node server       | `./config`, `./server`, `./dot`, `./orpc/server`, `./sentry/server`, `./server-error-overlay`                                         |
| build time (Vite) | `./vite`, `./pwa`                                                                                                                     |
| anywhere          | `./sentry/bridge`                                                                                                                     |

`./error`, `./devtools` and `./pwa/sw` load only inside a bundler or a service worker. `package.json` lists them in `arki.bundlerOnly`, so the release smoke checks them with a Vite build, not a plain Node import. The root entry does not re-export `RootErrorComponent` or `DevTools`, so `@arki/tanstack-start` imports in plain Node. Import them from `./error` and `./devtools`.

The devtools render nothing in production. `useKeysetQuery` and `useOptimisticMutation` need React and TanStack Query.

## Public imports

| Entry point                                 | What it has                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `@arki/tanstack-start`                      | `createAppConfig`, `createRouter`, `AnalyticsScript`.                              |
| `@arki/tanstack-start/config`               | `createAppConfig`: a Vite config wired with the TanStack Start and React plugins.  |
| `@arki/tanstack-start/router`               | `createRouter`.                                                                    |
| `@arki/tanstack-start/server`               | `startServer`, `withForwardedProto`.                                               |
| `@arki/tanstack-start/dot`                  | `tanstackStart()`: the entrypoint plugin for a Dot app, with its mounts.           |
| `@arki/tanstack-start/orpc/client`          | `createOrpcUtils`, `createORPCReact`, `getORPCUrl`, `createORPCClient`, `RPCLink`. |
| `@arki/tanstack-start/orpc/query`           | `useKeysetQuery`, `keysetOptions`, `keysetKey`, `useOptimisticMutation`.           |
| `@arki/tanstack-start/orpc/server`          | The oRPC server setup for TanStack Start.                                          |
| `@arki/tanstack-start/vite`                 | `zodCompiled`, `oneChunkPerRoute`, `fleetVite`.                                    |
| `@arki/tanstack-start/scripts`              | `AnalyticsScript`.                                                                 |
| `@arki/tanstack-start/error`                | `RootErrorComponent`.                                                              |
| `@arki/tanstack-start/devtools`             | `DevTools`.                                                                        |
| `@arki/tanstack-start/sentry/client`        | `initSentryClient`: opt-in by DSN.                                                 |
| `@arki/tanstack-start/sentry/server`        | `initSentryServer`: opt-in by DSN.                                                 |
| `@arki/tanstack-start/sentry/bridge`        | `captureException` without importing `@sentry/*`.                                  |
| `@arki/tanstack-start/server-error-overlay` | `withServerErrorOverlay`.                                                          |
| `@arki/tanstack-start/pwa`                  | `createPwaPlugin`: the `vite-plugin-pwa` setup.                                    |
| `@arki/tanstack-start/pwa/sw`               | The shared service worker base and `setupOfflineNavigation`.                       |
| `@arki/tanstack-start/pwa/client`           | `registerPwa`.                                                                     |

## oRPC client: `@arki/tanstack-start/orpc/client`

Build the query utils from the contract **value**. Each leaf is oRPC's own `ProcedureUtils`
(`queryOptions`, `infiniteOptions`, `mutationOptions`, keys) plus its operation under `'~op'`
(`{ path, name, meta }`, see `@arki/contracts/orpc`). Groups keep `key()` for partial invalidation.

```ts skip="fragment: needs the app own contract and backend"
// lib/orpc/client.tsx — keep your own link and serializers
import type { ContractRouterClient } from '@orpc/contract';
import { rpcContract } from '@my-app/backend/rpc';

import { createORPCClient, createOrpcUtils, RPCLink } from '@arki/tanstack-start/orpc/client';

const link = new RPCLink({ url: '/api/orpc', customJsonSerializers: temporalJsonSerializers });
const client: ContractRouterClient<typeof rpcContract> = createORPCClient(link);
export const orpc = createOrpcUtils(rpcContract, client);

orpc.posts.create['~op'].name; // 'posts.create'
```

Contract children remain own enumerable properties, including `__proto__` and `constructor`. Group prototypes and query key methods retain their normal behavior.

Or, with no custom link, in one call: `const { client, orpc } = createORPCReact(rpcContract, { url })`.

- **Same keys as oRPC.** Every key comes from oRPC's own `queryKey` / `infiniteKey` / `mutationKey` /
  `key`, so these utils and `createTanstackQueryUtils(client)` share one cache.
- **The contract module must be browser-safe**: contracts, zod and model files only. Its Zod schemas
  ship to the browser (`minifyContractRouter` keeps path and meta if that ever matters).
- **Fails loud** on a contract key the utils would shadow (`key`, `queryOptions`, … or one with `.`).

## Hooks: `@arki/tanstack-start/orpc/query`

Both hooks take **any** oRPC `ProcedureUtils` — contract-built, router-built or
`createTanstackQueryUtils` — whose client context is optional (oRPC's default). They send no per-call
context; a client that requires one is a compile error here. Types come from the procedure: nothing is
written at the call site.

### `useKeysetQuery(utils, args, options?)`

A keyset-paged list over the `pageInput` / `page` contract of `@arki/contracts`.

```tsx skip="fragment: needs the app own contract, components and React"
const { items, status, loadMore } = useKeysetQuery(orpc.posts.list, { status: 'published' });

{
  status === 'canLoadMore' && <button onClick={() => void loadMore(50)}>More</button>;
}
```

`args` is the input without the cursor; `limit` is the first page's size and part of the query key.
A procedure whose output is not a `Page` (`{ items, nextCursor: string | null }`, extra fields allowed)
or whose input has no `cursor` is a compile error.

| `status`           | Meaning                                                                               |
| ------------------ | ------------------------------------------------------------------------------------- |
| `idle`             | `enabled: false` and no data. No request.                                             |
| `loadingFirstPage` | No data yet, first page in flight (also during SSR — guard on this, not `isLoading`). |
| `canLoadMore`      | The last page had a `nextCursor`.                                                     |
| `loadingMore`      | `loadMore` is fetching the next page.                                                 |
| `exhausted`        | The last page said `nextCursor: null`. Exact: the server fetched `limit + 1` rows.    |
| `error`            | The first page failed, or a later one did (earlier `items` are kept).                 |

- **`loadMore(n)`** fetches one more page of `n` rows (default: the args' limit, else the contract
  default). A no-op unless `status` is `canLoadMore`; a double click sends one request. It resolves
  when the page lands and never rejects — a failure shows as `status: 'error'`. An `n` above the
  contract's `maxLimit` fails server validation and shows as `error`; the hook does not clamp.
- **Guarantees.** Items keep server order. No row repeats or is skipped across pages while rows are
  added or removed (the keyset promise). The key for given `args` is stable and equals
  `keysetKey(utils, args)`; a request for old `args` never lands in the new list.
- **Refetch caveat.** No snapshot across pages: each page is its own read. On a refetch TanStack reuses
  page 0's parameters and recomputes the rest, so later pages refetch with the most recent `loadMore`
  size. The page count stays the same; the total row count may change.

**Loader recipe** (one fetch: the hook finds the primed key):

```ts skip="fragment: needs the app own contract, components and React"
loader: ({ context }) =>
  context.queryClient.infiniteQuery({ ...keysetOptions(orpc.posts.list, { status: 'published' }), staleTime: 'static' }),
```

### `useOptimisticMutation(utils, { apply, onSuccess?, onError? })`

```tsx skip="fragment: needs the app own contract, components and React"
const create = useOptimisticMutation(orpc.posts.create, {
  apply: (cache, input) =>
    cache.updateKeyset(orpc.posts.list, { status: 'published' }, (items, pageIndex) =>
      pageIndex === 0 ? [{ ...input, id: tempId() }, ...items] : [...items],
    ),
});
```

`apply(cache, input)` only **records** typed edits — `cache.update(utils, input, fn)`,
`cache.updateKeyset(utils, args, fn)`, `cache.invalidate(utilsNode)`. The mutation runs them:

1. Cancels the touched queries, reads every snapshot and computes **every** replacement first. An
   edit that throws writes nothing and sends no request. An unloaded query is skipped (never created)
   but still refetched. `apply` must be synchronous; an async one is refused at run time.
2. Writes them all. In development the snapshot is frozen, so editing it in place throws.
3. On error, restores each snapshot in reverse — **only where the cache still holds the value this
   mutation wrote** (a `null` snapshot included). If something replaced it since, that stays.
4. When the **last** in-flight mutation of this procedure settles, refetches every query any of them
   touched, once each.

**Guarantees.** On error every value this mutation wrote and still owns returns to its exact snapshot.
After the last concurrent call of a procedure settles, every touched query refetches, so the UI
converges on server truth.

**Not promised.** Concurrent edits to one key are last-writer-wins until that refetch. The "last
in-flight" gate counts one procedure: a different procedure editing the same key may refetch early.
Rollback is local cache only — it never reverses a database write, a job or an email. A transport
failure does not prove the server did not commit; the refetch shows it.

`useOptimisticMutation` and a queued `useOfflineMutation` (`@arki/offline/mutations`) are alternatives
for one action: calling both sends it twice.

## Vite plugins: `@arki/tanstack-start/vite`

Build-time helpers for an app's `vite.config.ts`. Each one moves work from request time to `vite build`.

```ts skip="fragment: a vite.config.ts of an app, defineConfig is not imported"
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';

import { fleetVite, oneChunkPerRoute, zodCompiled } from '@arki/tanstack-start/vite';

export default defineConfig({
  plugins: [
    tanstackStart({ router: { codeSplittingOptions: oneChunkPerRoute } }),
    viteReact({ compiler: true }),
    zodCompiled(),
    fleetVite(),
  ],
});
```

React Compiler is not a helper here: it is `@vitejs/plugin-react`'s own option, `viteReact({ compiler: true })`, which runs the Rust port (`oxc-transform-react`, a dev dependency of the app). It replaces the plugin's JSX and Fast Refresh step, so it cannot be a separate plugin.

| Export             | What it does                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `zodCompiled()`    | Server bundle only: prepends `import 'zod/compile'` to the server entry, so every schema the server constructs (oRPC inputs, server function validators, env) parses through a compiled validator. Schemas the compiler cannot model fall back to the interpreter. |
| `oneChunkPerRoute` | `codeSplittingOptions` that keeps a route's loader in the route's own chunk. The default leaves every loader in the entry chunk, so the first page downloads every route's validators and server-function stubs.                                                   |
| `fleetVite()`      | Excludes `@arki/admin` from the client dev dep-scan for apps that mount the `/api/fleet` snapshot route.                                                                                                                                                           |

## Behind a TLS proxy: `withForwardedProto` from `@arki/tanstack-start/server`

A proxy that ends TLS (nginx, Traefik, a CDN) talks plain HTTP to the app and adds `X-Forwarded-Proto: https`. Code that builds an absolute URL from `request.url` then points an HTTPS browser at `http://…`. Paraglide's locale redirect (`/` → `/ro`) is the common case: the browser lands on the wrong server.

`withForwardedProto(request)` rebuilds a GET or HEAD request with an `https:` URL when that header says `https`. Every other request comes back as the same object. Requests with a body are never copied, because copying would read the stream. Call it once, before the locale middleware:

```ts skip="fragment: needs the app and paraglideMiddleware"
import { startServer, withForwardedProto } from '@arki/tanstack-start/server';

export const server = startServer(app, {
  hot: import.meta.hot,
  handler: (incoming, options) => {
    const request = withForwardedProto(incoming);
    return paraglideMiddleware(request, () => startHandler(request, options));
  },
});
```

The header is trusted as sent. Behind a proxy that overwrites it, that is correct. Without a proxy, a client can only change the scheme of URLs built for its own response.

## Failure behaviour

- `createOrpcUtils` fails loud on a contract key the utils would shadow (`key`, `queryOptions`, or a key with `.`).
- `useKeysetQuery` and `useOptimisticMutation` do not throw on a failed request. A failed page shows as `status: 'error'`. A failed optimistic mutation restores its snapshots.
- `useOptimisticMutation` throws a `TypeError` when `apply` is async.
- The Dot plugin `tanstackStart()` stops the boot with a coded error: `ARKI_TANSTACK_START_PLUGIN_E001` when the cron secret is empty, `ARKI_TANSTACK_START_PLUGIN_E002` when a CORS origin is not a bare `scheme://host[:port]`. The [agent guide](docs/agent-guide.md#errors) has the fixes.
- `initSentryClient` and `initSentryServer` disable Sentry without an error when the DSN is missing, empty or malformed.

## Limits

- `useKeysetQuery` does not clamp `loadMore(n)`. An `n` above the contract's `maxLimit` fails server validation and shows as `error`.
- Concurrent optimistic edits to one key are last-writer-wins until the refetch.
- Optimistic rollback is local cache only. It never reverses a database write, a job or an email.
- `withForwardedProto` copies only GET and HEAD requests.

## Documentation

- [Agent guide](docs/agent-guide.md): tasks, step by step.
- [llms.txt](llms.txt): the map for agents.
- [CHANGELOG](CHANGELOG.md).

## Support

Report bugs and ask questions at https://github.com/arki-labs/arki/issues.
