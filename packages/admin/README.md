# @arki/admin

The contract between an ARKI app and Foreman (the fleet control plane). An app exposes **modules** (reads and actions) behind signed requests. Foreman reads the manifest and calls them.

Entries: `./module` (define modules), `./core` (`core.health`, `core.manifest`, `core.receipts`), `./env` (the `FOREMAN_*` variables), `./server` (handler), `./receipts` (receipt schemas and the KV store), `./pg` (the journal receipt store), `./client` (Foreman side), `./dot` (DOT slice), `./http` (v1 `/api/fleet`).

## Turn it on

Set all four variables, or none. With none set, `/api/foreman/*` answers 404 and the app boots as before. With only some set, the first request throws `ARKI_ADMIN_E014`.

| Variable              | What                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| `FOREMAN_APP_ID`      | App slug. With the environment it forms the audience, e.g. `novelette:prod`. |
| `FOREMAN_ENVIRONMENT` | Optional `prod`, `staging` or `dev`. Overrides what `foremanEnvironmentFromNodeEnv(NODE_ENV)` returns. |
| `FOREMAN_APP_KEY`     | The app's identity key. It signs every response.                                   |
| `FOREMAN_READ_KEY`    | Foreman's read public key. `_NEXT` holds the new key while rotating.               |
| `FOREMAN_EXECUTE_KEY` | Foreman's execute public key. Must differ from the read key. `_NEXT` as above.     |
| `FOREMAN_WRITES`      | `on` allows executes. Unset or `off` refuses every execute.                        |

Generate keys with `generateForemanKeyPair()`. Spread `foremanEnvShape` from `@arki/admin/env` into the app's env schema; the validated env is a `ForemanEnv` as is.

`FOREMAN_WRITES=on` also needs a receipt store (see [Receipts](#receipts)). Without one, every execute is refused with `ARKI_ADMIN_E017`.

## Plain TanStack app

```ts
// backend/src/foreman.ts  (build on first request, not at import)
import { createForemanHandlerFromEnv, kvReceiptStore } from '@arki/admin/server';

let handler: ((request: Request) => Promise<Response>) | undefined;
export function handleForeman(request: Request) {
  handler ??= createForemanHandlerFromEnv({
    env, // validated env that includes foremanEnvShape
    environment: 'prod',
    app: { version, commit },
    nonces: kv, // any @arki/kv KV
    receipts: kvReceiptStore(kv, { namespace: 'myapp:prod' }), // required for executes; also serves core.receipts
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

`foreman()` is a feature slice. It takes the same options as `createForemanHandlerFromEnv`, built from the feature's `needs`.

```ts
import { foreman } from '@arki/admin/dot';
import { feature } from '@arki/dot/feature';
import { journalReceiptStore } from '@arki/admin/pg';

export const operations = feature('operations', {
  needs: { kv: kvPlugin.provides.kv, db: database.provides.db }, // handles; service<T>() also works
  use: [
    foreman(({ kv, db }: { kv: KV; db: Db }) => ({
      env,
      environment: 'prod',
      app: { version },
      nonces: kv,
      receipts: journalReceiptStore({
        j,
        journal,
        db,
        tables: { receipts: foremanReceipts },
        meta: { actorId: 'foreman' },
      }),
      health: () => healthOf(db),
      modules: [queueModule()],
      context: () => ({}),
    })),
  ],
});
```

The slice lands under the `routes` key, so `feature()` throws `ARKI_DOT_E024` if the same feature also holds an `endpoints()` slice. Give Foreman its own feature. The four `/api/foreman` routes show up in `dot explain`; module actions are in the manifest.

## Modules every target serves

Reads, actions and signals take any Standard Schema (Zod, Valibot, ArkType, hand-written). The manifest JSON Schema comes from the schema itself: use a library that can emit JSON Schema, or wrap the schema with `withJsonSchema` from `@arki/schema`. A schema that cannot is an error at define time, naming the read or action.

Output is only as narrow as its schema. Zod and Valibot objects drop keys they do not declare; an ArkType object keeps them unless it declares `'+': 'delete'`. If a `load` returns a whole database row, use a schema that drops undeclared keys, or pick the fields yourself, so a secret column never reaches the admin client.

`core.health` has two reads, `core.health.status` and `core.health.checks`, in the v1 `fleetHealthSchema` shape. `core.manifest.get` returns the same manifest as `GET /api/foreman/manifest`. `core.receipts.get` is there when the app passes `receipts`. Both attachments add them for you (`withCoreModules`).

## Receipts

Foreman never sends an execute twice. When an answer is lost, it asks the app what happened: `core.receipts.get({ executionId })`, signed with the read key (scope `core:read`).

The handler records every execute under the permit's `executionId`:

1. It claims the id: a `pending` receipt, stored before the action runs.
2. It runs the action.
3. It settles the receipt before it sends the response: `applied` (with `result`, the data the execute answered, and `resultHash`, `sha256:<hex>` over canonical JSON) or `failed` (with the same `{ code, message }` the wire carried, never the app's internal message).

| `core.receipts.get` answers | Means                                                   | Foreman reads it as |
| --------------------------- | ------------------------------------------------------- | ------------------- |
| `applied`                   | The action ran and returned.                            | succeeded           |
| `failed`                    | The action threw (or its input was invalid).            | failed              |
| `pending`                   | Still running, or the process died before it recorded.  | still unknown       |
| `not_applied`               | No receipt. Final only after Foreman's 5-minute window. | not found           |

A second execute with the same id never runs the action again. It gets the stored result or error, `ARKI_ADMIN_E018` while the receipt is `pending`, or `ARKI_ADMIN_E010` when the id belongs to another action. A store that cannot take the claim refuses the execute with `ARKI_ADMIN_E017` before the action runs. A store that cannot settle is logged; the true answer still goes out and the receipt stays `pending`.

An action that ran but returned data its own schema rejects (`ARKI_ADMIN_E005`) did apply: it is recorded `applied` with `result: null`.

**Plain app: `kvReceiptStore(kv, { namespace })`** (`@arki/admin/server` or `./receipts`). Takes the claim with `setIfNotExists`, then keeps the receipt with `set`. Receipts live 30 days by default (`ttlSeconds`); less than Foreman's 300-second window throws `ARKI_ADMIN_E014`. Keep each action atomic: an action that throws after a partial write is still recorded `failed`. `namespace` is the app's audience (`slug:environment`, e.g. `novelette:prod`) and is part of every key, so apps or environments sharing one KV cannot read each other's receipts. It is required; a value that is not an audience throws `ARKI_ADMIN_E014`.

**DOT app with a journal: `journalReceiptStore(...)`** (`@arki/admin/pg`). Add the table and migrate:

```ts
// schema.ts
import { foremanReceiptTables } from '@arki/admin/pg';

export const { receipts: foremanReceipts } = foremanReceiptTables(); // table `foreman_receipts`
```

Then build the store once at boot with the app's `j`, composed `journal`, root `db`, the table and the `meta` its events record. Each claim and settle is a journal event on the `foreman_receipt` entity (`ForemanReceiptClaimed`, `ForemanReceiptSettled`), committed on its own: the claim before the action, the settle before the response.
