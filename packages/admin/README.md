# @arki/admin

The contract between an ARKI app and Foreman (the fleet control plane). An app exposes **modules** (reads and actions) behind signed requests. Foreman reads the manifest and calls them.

Entries: `./module` (define modules), `./core` (`core.health`, `core.manifest`, `core.receipts`), `./env` (the `FOREMAN_*` variables), `./server` (handler and `createForemanRoute`), `./receipts` (receipt schemas and the KV store), `./pg` (the Postgres store for apps without a KV), `./client` (Foreman side), `./dot` (DOT entrypoint), `./http` (v1 `/api/fleet`).

## Turn it on

Set all four variables, or none. With none set, `/api/foreman/*` answers 404 and the app boots as before. With only some set, the first request throws `ARKI_ADMIN_E014`.

| Variable              | What                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `FOREMAN_APP_ID`      | App slug. With the environment it forms the audience, e.g. `novelette:prod`.                           |
| `FOREMAN_ENVIRONMENT` | Optional `prod`, `staging` or `dev`. Overrides what `foremanEnvironmentFromNodeEnv(NODE_ENV)` returns. |
| `FOREMAN_APP_KEY`     | The app's identity key. It signs every response.                                                       |
| `FOREMAN_READ_KEY`    | Foreman's read public key. `_NEXT` holds the new key while rotating.                                   |
| `FOREMAN_EXECUTE_KEY` | Foreman's execute public key. Must differ from the read key. `_NEXT` as above.                         |
| `FOREMAN_WRITES`      | `on` allows executes. Unset or `off` refuses every execute.                                            |

Generate keys with `generateForemanKeyPair()`. Spread `foremanEnvShape` from `@arki/admin/env` into the app's env schema; the validated env is a `ForemanEnv` as is.

`FOREMAN_WRITES=on` also needs a receipt store (see [Receipts](#receipts)). Without one, every execute is refused with `ARKI_ADMIN_E017`.

## Plain TanStack app

`createForemanRoute` is the mount every app uses. It builds the handler on the first request, never at import. One store holds the nonces and the receipts, and the receipts are namespaced by the app's audience (`FOREMAN_APP_ID:environment`).

```ts
// backend/src/features/fleet/foreman.ts
import { createForemanRoute } from '@arki/admin/server';

export const foremanRoute = createForemanRoute(() => ({
  env, // validated env that includes foremanEnvShape and NODE_ENV
  app: { version, commit: env.SOURCE_COMMIT },
  store: kv, // any @arki/kv KV, pgForemanStore (./pg), or memoryForemanStore
  context: () => ({}),
  health: async () => (await getFleetSnapshot()).health, // reuse the /api/fleet function
  modules: [queueForemanModule({ queues })],
}));

// start/src/routes/api/foreman/$.ts
export const Route = createFileRoute('/api/foreman/$')({
  server: { handlers: { ANY: ({ request }) => foremanRoute(request) } },
});
```

A DOT app graph passes its services: `createForemanRoute((services: Services) => ({ ... }))` and `ANY: ({ request, context }) => foremanRoute(request, context.services)`. The handler is built once per services object.

| Store                                                 | When                                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@arki/kv` `KV`                                       | The app has a KV.                                                                                                                                             |
| `pgForemanStore({ db, table })` from `@arki/admin/pg` | The app has Postgres but no KV. Add `foremanStoreTable()` to the schema and migrate. Expiries use the database clock.                                         |
| `memoryForemanStore()`                                | One instance, no KV, no database. A restart forgets the nonces, so a captured request can be replayed until its signature expires. Keep `FOREMAN_WRITES` off. |
| `null`                                                | No store in this process (development without a KV). The route answers 404 while the keys are unset and throws `ARKI_ADMIN_E014` once they are set.           |

`createForemanHandlerFromEnv` is still there for an app that wires the nonces and receipts itself.

Keep the `/api/fleet` route. Foreman still polls it until it negotiates protocol 2.

## DOT app

`foreman()` is an entrypoint of a feature. It takes the same options as `createForemanHandlerFromEnv`, built from the feature's `needs`.

```ts
import { foreman } from '@arki/admin/dot';
import { defineFeature } from '@arki/dot/feature';
import { journalReceiptStore } from '@arki/journal/foreman';

export const operations = defineFeature('operations')
  .needs({ kv: kvPlugin.provides.kv, db: database.provides.db }) // handles; service<T>() also works
  .entrypoints({
    kind: 'routes',
    ...foreman(({ kv, db }: { kv: KV; db: Db }) => ({
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
  });
```

The entrypoint lands under the `routes` key, so the same feature cannot also hold an `endpoints()` entrypoint. Give Foreman its own feature. The four `/api/foreman` routes show up in `dot explain`; module actions are in the manifest.

## Modules every target serves

Reads, actions and signals take any Standard Schema (Zod, Valibot, ArkType, hand-written). The manifest JSON Schema comes from the schema itself: use a library that can emit JSON Schema, or wrap the schema with `withJsonSchema` from `@arki/schema`. A schema that cannot is an error at define time, naming the read or action.

Output is only as narrow as its schema. Zod and Valibot objects drop keys they do not declare; an ArkType object keeps them unless it declares `'+': 'delete'`. If a `load` returns a whole database row, use a schema that drops undeclared keys, or pick the fields yourself, so a secret column never reaches the admin client.

### Generic panels

A panel names a renderer that Foreman bundles; a manifest never ships code. `@arki/admin/panels` holds the answer shapes of the two generic ones, so a module gets a finished screen without Foreman code of its own:

- `arki.board` (`PANEL_RENDERER.board`): number cards under group headings. A read returns `boardOutputSchema`: each card has a `format` (`count`, `usd`, `percent`, `duration`) and a `tone` (`ok`, `warn`, `bad`, `idle`). `value: null` means not measured and shows a dash.
- `arki.rows` (`PANEL_RENDERER.rows`): a table. A read returns `rowsOutputSchema`: `columns` (key, label, format), `rows`, `total` and the `empty` text. The read's input becomes a filter bar. Each action the panel lists becomes a button on every row that holds all of the action's required input keys, with the row's values as the input. An action with no required input becomes one button above the table.

Use the schema itself as the read's `output`, so the app and Foreman parse the same shape.

```ts
import { boardOutputSchema, PANEL_RENDERER } from '@arki/admin/panels';

const today = defineRead({
  id: 'shop.today',
  summary: 'How the shop is doing today',
  permission: 'shop:read',
  input: z.object({}),
  output: boardOutputSchema,
  load: async () => ({
    cards: [{ key: 'orders', label: 'Orders', group: 'Sales', value: 12, format: 'count', tone: 'ok' }],
  }),
});
const shop = defineModule({
  id: 'shop',
  version: '1.0.0',
  reads: { today },
  actions: {},
  panels: [{ id: 'today', renderer: PANEL_RENDERER.board, read: 'today', actions: [] }],
});
```

`core.health` has two reads, `core.health.status` and `core.health.checks`, in the v1 `fleetHealthSchema` shape. `core.manifest.get` returns the same manifest as `GET /api/foreman/manifest`. `core.receipts.get` is there when the app passes `receipts`. Both attachments add them for you (`withCoreModules`).

## Module errors

A module can refuse a request with its own coded error. Admin does not need to know what the code means.

```ts
import { moduleError } from '@arki/admin/module';

throw moduleError('ARKI_JOURNAL_E002', 409, 'Job job_1 is not dead.', 'Reload the job and check its state.');
```

Actions may declare a `failures` tuple of canonical `@arki/failure` definitions and return those failures from `execute`. `runExecute` preserves the original failure and its exact inferred type. The dispatcher validates failures with the canonical serializer, records a failed receipt, and returns the failure code and HTTP status; it hides server messages and private causes. Undeclared or invalid failures become a supervised defect.

`moduleError(code, status, message, remediation)` takes the module's own `code`, an HTTP `status` from 400 to 599, a `message` and a one-sentence `remediation`. A status outside 400 to 599, or an empty code, throws `ARKI_ADMIN_E014`. Server error messages stay private. A plain `Error` answers `ARKI_ADMIN_E015` and its text stays in the app's log. `isModuleError(error)` and the `ModuleError` type are exported from `@arki/admin/module`.

The dispatcher answers a `ModuleError` with the module's own status and code, and the client reads them back. A failed receipt keeps both, so a lost answer settled later through `core.receipts.get` still says `ARKI_JOURNAL_E002`, not a generic code. The wire and receipt `code` is therefore a string: one of `ADMIN_ERROR_CODES`, or a module's own. `@arki/journal/foreman` (`ARKI_JOURNAL_E001` to `E005`) and `@arki/queue/foreman` (`ARKI_QUEUE_E014` to `E016`) use it.

`redactSecrets` also lives in `@arki/admin/module`. A module runs error text through it before it reaches the wire.

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

**DOT app with a journal: `journalReceiptStore(...)`** (`@arki/journal/foreman`). Add the table and migrate:

```ts
// schema.ts
import { foremanReceiptTables } from '@arki/journal/foreman';

export const { receipts: foremanReceipts } = foremanReceiptTables(); // table `foreman_receipts`
```

Then build the store once at boot with the app's `j`, composed `journal`, root `db`, the table and the `meta` its events record. Each claim and settle is a journal event on the `foreman_receipt` entity (`ForemanReceiptClaimed`, `ForemanReceiptSettled`), committed on its own: the claim before the action, the settle before the response.
