# @arki/admin

The contract between an ARKI app and Foreman (the fleet control plane). An app exposes **modules** (reads and actions) behind signed requests. Foreman reads the manifest and calls them.

Entries: `./module` (define modules), `./core` (`core.health`, `core.manifest`), `./env` (the `FOREMAN_*` variables), `./server` (handler), `./client` (Foreman side), `./dot` (DOT slice), `./http` (v1 `/api/fleet`).

## Turn it on

Set all four variables, or none. With none set, `/api/foreman/*` answers 404 and the app boots as before. With only some set, the first request throws `ARKI_ADMIN_E014`.

| Variable              | What                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| `FOREMAN_APP_ID`      | App slug. With the environment it forms the audience, e.g. `novelette:production`. |
| `FOREMAN_APP_KEY`     | The app's identity key. It signs every response.                                   |
| `FOREMAN_READ_KEY`    | Foreman's read public key. `_NEXT` holds the new key while rotating.               |
| `FOREMAN_EXECUTE_KEY` | Foreman's execute public key. Must differ from the read key. `_NEXT` as above.     |
| `FOREMAN_WRITES`      | `on` allows executes. Unset or `off` refuses every execute.                        |

Generate keys with `generateForemanKeyPair()`. Spread `foremanEnvShape` from `@arki/admin/env` into the app's env schema.

## Plain TanStack app

```ts
// backend/src/foreman.ts  (build on first request, not at import)
import { createForemanHandlerFromEnv } from '@arki/admin/server';

let handler: ((request: Request) => Promise<Response>) | undefined;
export function handleForeman(request: Request) {
  handler ??= createForemanHandlerFromEnv({
    env, // validated env that includes foremanEnvShape
    environment: 'production',
    app: { version, commit },
    nonces: kv, // any @arki/kv KV
    context: () => ({}),
    health: async () => (await getFleetSnapshot()).health, // reuse the /api/fleet function
    modules: [queueForemanModule({ queues })],
  });
  return handler(request);
}

// start/src/routes/api/foreman/$.ts
export const Route = createFileRoute('/api/foreman/$')({
  server: { handlers: { ANY: ({ request }) => handleForeman(request) } },
});
```

Keep the `/api/fleet` route. Foreman still polls it until it negotiates protocol 2.

## DOT app

`foreman()` is a `defineFeature` slice. It takes the same options as `createForemanHandlerFromEnv`, built from the feature's `needs`.

```ts
import { foreman } from '@arki/admin/dot';

export const operations = defineFeature('operations', {
  needs: { kv: service<KV>(), db: service<Db>() },
  use: [
    foreman(({ kv, db }: { kv: KV; db: Db }) => ({
      env,
      environment: 'production',
      app: { version },
      nonces: kv,
      health: () => healthOf(db),
      modules: [queueModule()],
      context: () => ({}),
    })),
  ],
});
```

The slice lands under the `routes` key, so `defineFeature` throws `FEATURE_E003` if the same feature also holds an `endpoints()` slice. Give Foreman its own feature. The four `/api/foreman` routes show up in `dot explain`; module actions are in the manifest.

## Modules every target serves

`core.health` has two reads, `core.health.status` and `core.health.checks`, in the v1 `fleetHealthSchema` shape. `core.manifest.get` returns the same manifest as `GET /api/foreman/manifest`. Both attachments add them for you (`withCoreModules`).
