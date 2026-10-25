# @arki/tanstack-start

Shared TanStack Start wiring for arki apps (router, server entry, Sentry, PWA, devtools) and the
typed oRPC client layer. Private to this monorepo. This README covers the oRPC entries.

## oRPC client: `@arki/tanstack-start/orpc/client`

Build the query utils from the contract **value**. Each leaf is oRPC's own `ProcedureUtils`
(`queryOptions`, `infiniteOptions`, `mutationOptions`, keys) plus its operation under `'~op'`
(`{ path, name, meta }`, see `@arki/contracts/orpc`). Groups keep `key()` for partial invalidation.

```ts
// lib/orpc/client.tsx — keep your own link and serializers
import type { ContractRouterClient } from '@orpc/contract';
import { rpcContract } from '@my-app/backend/rpc';

import { createORPCClient, createOrpcUtils, RPCLink } from '@arki/tanstack-start/orpc/client';

const link = new RPCLink({ url: '/api/orpc', customJsonSerializers: temporalJsonSerializers });
const client: ContractRouterClient<typeof rpcContract> = createORPCClient(link);
export const orpc = createOrpcUtils(rpcContract, client);

orpc.posts.create['~op'].name; // 'posts.create'
```

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

```tsx
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

```ts
loader: ({ context }) =>
  context.queryClient.infiniteQuery({ ...keysetOptions(orpc.posts.list, { status: 'published' }), staleTime: 'static' }),
```

### `useOptimisticMutation(utils, { apply, onSuccess?, onError? })`

```tsx
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

```ts
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

```ts
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
