# @arki/tanstack-start for agents

The long form of [llms.txt](../llms.txt). When they disagree, the entry files under `src/` win.

## The model

1. The package wires an Arki app on TanStack Start: router defaults, server entry, Sentry, PWA, devtools, and typed oRPC client utils and hooks.
2. Each `exports` key is one entry. Browser entries and Node entries are separate. The `exports` map says which is which.
3. `createOrpcUtils(contract, client)` builds TanStack Query utils from the contract value. Keys come from oRPC itself, so the cache is shared with `createTanstackQueryUtils`.
4. `useKeysetQuery` pages a list over the `pageInput` / `page` contract of `@arki/contracts`. `useOptimisticMutation` records typed cache edits and runs them with rollback.
5. `startServer(app)` is the server entry of a Dot app. `tanstackStart()` from `./dot` is its entrypoint plugin.
6. `./vite` holds three Vite plugins that move work from request time to build time.

## Task map

### Use the typed oRPC client

1. Import the contract value from a browser-safe module.
2. Call `createORPCReact(rpcContract, { url })` for a default link, or `createOrpcUtils(rpcContract, client)` with your own link.
3. Read `orpc.posts.create['~op'].name` for an operation's name.

### Page a list with a cursor

1. Call `useKeysetQuery(orpc.posts.list, args)`.
2. Branch on `status`. Call `loadMore(n)` when it is `canLoadMore`.
3. To prime it in a route loader, use `keysetOptions(utils, args)` with `queryClient.infiniteQuery`.

### Edit the cache before the server answers

1. Call `useOptimisticMutation(utils, { apply })`.
2. In `apply`, call `cache.update`, `cache.updateKeyset` or `cache.invalidate`. Do not await.

### Fix a redirect that points at http

1. Call `withForwardedProto(incoming)` once, before the locale middleware.

```ts run
import { withForwardedProto } from '@arki/tanstack-start/server';

const proxied = new Request('http://pizzeria.example/menu', {
  headers: { 'x-forwarded-proto': 'https' },
});

console.log(withForwardedProto(proxied).url);
```

### Add the Vite helpers

1. Add `zodCompiled()` for a compiled zod validator in the server bundle.
2. Pass `codeSplittingOptions: oneChunkPerRoute` to `tanstackStart`.
3. Add `fleetVite()` when the app uses any `@arki/*` package: it bundles them into the SSR build, because some publish TypeScript source that Node will not load from `node_modules`. It also covers the `/api/fleet` snapshot route.

### Start Sentry

1. Call `initSentryClient({ dsn })` at the top of the client entry, before the router import.
2. Call `initSentryServer({ dsn })` at the top of the server entry, before other imports.

## Rules that bite

- The contract module must not pull server code. Its schemas ship to the browser.
- A contract key named `key`, `queryOptions` or one with `.` is refused when the utils are built.
- `useKeysetQuery` guards SSR on `loadingFirstPage`, not on `isLoading`.
- `loadMore` does nothing unless `status` is `canLoadMore`. It never rejects.
- Do not use `useOptimisticMutation` and `useOfflineMutation` for one action. The action is sent twice.
- `apply` must be synchronous.
- Call Sentry init before the router and business imports. Order matters.
- `withForwardedProto` trusts `X-Forwarded-Proto` as sent.
- The PWA setup precaches from `.output/public`. Read `precache N entries` in the build log. Zero means the glob found nothing.

## Errors

| Code                              | Meaning                                                         | What to do                                                       |
| --------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `ARKI_TANSTACK_START_PLUGIN_E001` | The cron mount's `secret()` returned an empty value.            | Set the env var `secret` reads on the server, not at build time. |
| `ARKI_TANSTACK_START_PLUGIN_E002` | `cors()` returned an origin that is not `scheme://host[:port]`. | Remove any path or trailing slash from each origin.              |

Other failures are plain `TypeError`s: a contract key the utils would shadow, and an async `apply`.

## Verify

```sh
bun run typecheck
bun run test
bun run test:docs

# In an app that mounts tanstackStart(): the plugin graph, then the booted app's health.
dot explain --json | jq '.data'
dot doctor --json | jq '.data'
```
