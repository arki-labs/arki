# @arki/admin

The contract between an ARKI app and Foreman (the fleet control plane). An app exposes **modules** (reads and actions) behind signed requests. Foreman reads the manifest and calls them.

## Install

```sh
bun add @arki/admin
```

`@arki/http` is an optional peer: install it for `./http`. `drizzle-orm` comes as a dependency, pinned to the same version as `@arki/db`, for `./pg`.

## Quick start

An app with none of the `FOREMAN_*` variables answers every `/api/foreman/*` request with 404. This example shows it.

```ts run
import { createForemanRoute, memoryForemanStore } from '@arki/admin/server';

const foremanRoute = createForemanRoute(() => ({
  env: {},
  app: { version: '1.0.0' },
  store: memoryForemanStore(),
  context: () => ({}),
  health: () => ({ status: 'ok', checks: [] }),
  modules: [],
}));

const response = await foremanRoute(new Request('http://localhost/api/foreman/manifest'));
console.log(response.status);
```

To turn it on, set the variables below.

### Turn it on

Set all four variables, or none. With none set, `/api/foreman/*` answers 404 and the app boots as before. With only some set, the first request throws `ARKI_ADMIN_E014`.

| Variable              | What                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `FOREMAN_APP_ID`      | App slug. With the environment it forms the audience, e.g. `pizzeria:prod`.                            |
| `FOREMAN_ENVIRONMENT` | Optional `prod`, `staging` or `dev`. Overrides what `foremanEnvironmentFromNodeEnv(NODE_ENV)` returns. |
| `FOREMAN_APP_KEY`     | The app's identity key. It signs every response.                                                       |
| `FOREMAN_READ_KEY`    | Foreman's read public key. `_NEXT` holds the new key while rotating.                                   |
| `FOREMAN_EXECUTE_KEY` | Foreman's execute public key. Must differ from the read key. `_NEXT` as above.                         |
| `FOREMAN_WRITES`      | `on` allows executes. Unset or `off` refuses every execute.                                            |

Generate keys with `generateForemanKeyPair()`. Spread `foremanEnvShape` from `@arki/admin/env` into the app's env schema; the validated env is a `ForemanEnv` as is.

`FOREMAN_WRITES=on` also needs a receipt store (see [Receipts](#receipts)). Without one, every execute is refused with `ARKI_ADMIN_E017`.

## When not to use this

- The app does not talk to Foreman. The package has no other job.
- You need a public API for end users. These routes accept only signed requests from Foreman.
- You run one instance and want `FOREMAN_WRITES=on` with `memoryForemanStore`. A restart forgets the nonces. Use a KV or Postgres store.

## Runtime support

The handler uses the Fetch `Request` and `Response` types and Web Crypto (`globalThis.crypto.subtle`). `schemaHash` throws `ARKI_ADMIN_E006` when Web Crypto is missing. The entry `@arki/admin` carries no Node built-ins and no secrets.

## Public imports

| Entry point                       | What it has                                                                           | Optional peer |
| --------------------------------- | ------------------------------------------------------------------------------------- | ------------- |
| `@arki/admin`                     | The fleet snapshot schemas, types and constants.                                      | none          |
| `@arki/admin/module`              | `defineModule`, `defineRead`, `defineAction`, `defineSignal`, `moduleError`.          | none          |
| `@arki/admin/core`                | `withCoreModules`: `core.health`, `core.manifest`, `core.receipts`.                   | none          |
| `@arki/admin/env`                 | `foremanEnvShape`, `foremanEnvironmentFromNodeEnv`, `foremanConfigFromEnv`.           | none          |
| `@arki/admin/server`              | `createForemanRoute`, `createForemanHandler`, `kvReceiptStore`, `memoryForemanStore`. | none          |
| `@arki/admin/receipts`            | Receipt schemas and `kvReceiptStore`.                                                 | none          |
| `@arki/admin/pg`                  | `foremanStoreTable`, `pgForemanStore`.                                                | `drizzle-orm` |
| `@arki/admin/client`              | The Foreman side: `createForemanClient`, `generateForemanKeyPair`.                    | none          |
| `@arki/admin/dot`                 | `foreman()`, an entrypoint of a Dot feature.                                          | none          |
| `@arki/admin/http`                | `fleetRoutes`: the v1 `/api/fleet` route.                                             | `@arki/http`  |
| `@arki/admin/panels`              | `boardOutputSchema`, `rowsOutputSchema`, `PANEL_RENDERER`.                            | none          |
| `@arki/admin/connections/coolify` | The Coolify connection and `createCoolifyEnvWriter`.                                  | none          |

## Plain TanStack app

`createForemanRoute` is the mount every app uses. It builds the handler on the first request, never at import. One store holds the nonces and the receipts, and the receipts are namespaced by the app's audience (`FOREMAN_APP_ID:environment`).

```ts skip="fragment: uses the app own env, kv and queues"
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

```ts skip="fragment: needs a Dot app with a kv, a database and a journal"
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

```ts skip="fragment: z and defineRead are not imported"
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

**Plain app: `kvReceiptStore(kv, { namespace })`** (`@arki/admin/server` or `./receipts`). Takes the claim with `setIfNotExists`, then keeps the receipt with `set`. Receipts live 30 days by default (`ttlSeconds`); less than Foreman's 300-second window throws `ARKI_ADMIN_E014`. Keep each action atomic: an action that throws after a partial write is still recorded `failed`. `namespace` is the app's audience (`slug:environment`, e.g. `pizzeria:prod`) and is part of every key, so apps or environments sharing one KV cannot read each other's receipts. It is required; a value that is not an audience throws `ARKI_ADMIN_E014`.

**DOT app with a journal: `journalReceiptStore(...)`** (`@arki/journal/foreman`). Add the table and migrate:

```ts skip="@arki/journal is not a dependency of this package"
// schema.ts
import { foremanReceiptTables } from '@arki/journal/foreman';

export const { receipts: foremanReceipts } = foremanReceiptTables(); // table `foreman_receipts`
```

Then build the store once at boot with the app's `j`, composed `journal`, root `db`, the table and the `meta` its events record. Each claim and settle is a journal event on the `foreman_receipt` entity (`ForemanReceiptClaimed`, `ForemanReceiptSettled`), committed on its own: the claim before the action, the settle before the response.

## Failure behaviour

Every failure the package raises on purpose is an `AdminError` with a code from `ADMIN_ERROR_CODES` (`ARKI_ADMIN_E001` to `ARKI_ADMIN_E018`). Match on the code, never on the message. Each code has a `@fix` line in `src/errors.ts`. The full table is in the [agent guide](docs/agent-guide.md#errors).

A module can refuse a request with its own coded error. Admin does not need to know what the code means.

```ts skip="the example throws on purpose"
import { moduleError } from '@arki/admin/module';

throw moduleError('ARKI_JOURNAL_E002', 409, 'Job job_1 is not dead.', 'Reload the job and check its state.');
```

Actions may declare a `failures` tuple of canonical `@arki/failure` definitions and return those failures from `execute`. `runExecute` preserves the original failure and its exact inferred type. The dispatcher validates failures with the canonical serializer, records a failed receipt, and returns the failure code and HTTP status; it hides server messages and private causes. Undeclared or invalid failures become a supervised defect.

`moduleError(code, status, message, remediation)` takes the module's own `code`, an HTTP `status` from 400 to 599, a `message` and a one-sentence `remediation`. A status outside 400 to 599, or an empty code, throws `ARKI_ADMIN_E014`. Server error messages stay private. A plain `Error` answers `ARKI_ADMIN_E015` and its text stays in the app's log. `isModuleError(error)` and the `ModuleError` type are exported from `@arki/admin/module`.

The dispatcher answers a `ModuleError` with the module's own status and code, and the client reads them back. A failed receipt keeps both, so a lost answer settled later through `core.receipts.get` still says `ARKI_JOURNAL_E002`, not a generic code. The wire and receipt `code` is therefore a string: one of `ADMIN_ERROR_CODES`, or a module's own. `@arki/journal/foreman` (`ARKI_JOURNAL_E001` to `E005`) and `@arki/queue/foreman` (`ARKI_QUEUE_E014` to `E016`) use it.

`redactSecrets` also lives in `@arki/admin/module`. A module runs error text through it before it reaches the wire.

## Schemas and helpers

These are for callers that build or check protocol messages themselves.

- `describeModule(module)` (`@arki/admin/module`) returns the module as JSON: JSON Schemas for every input and output, and a `schemaHash` per read, action and signal.
- `moduleDescriptionSchema`, `readDescriptionSchema`, `signalDescriptionSchema` and `panelDescriptionSchema` (`@arki/admin/module`) parse a module, a read, a signal and a panel as an app's manifest reports them. Foreman parses the manifest with them, because the wire is untrusted.
- `riskClassSchema` (`@arki/admin/module`) is how dangerous a capability is: `read`, `low`, `medium` or `high`.
- `jsonValueSchema` and `jsonObjectSchema` (`@arki/admin/module`) accept any JSON value and any JSON object.
- `settledReceiptSchema` (`@arki/admin/receipts`) is an applied or failed receipt. `storedReceiptSchema` also accepts a pending one.
- `signRequest(input)` (`@arki/admin/client`) signs one request envelope. `createForemanClient` uses it for every call.

## Limits

- One proposal covers 1 target by default (`DEFAULT_MAX_TARGETS`). An action can raise `maxTargets` to at most 5 (`MAX_TARGETS_LIMIT`).
- A receipt lives 30 days by default. A `ttlSeconds` below 300 (Foreman's receipt window) throws `ARKI_ADMIN_E014`.
- `moduleError` takes an HTTP status from 400 to 599. Any other status throws `ARKI_ADMIN_E014`.

## Documentation

- [Agent guide](docs/agent-guide.md): tasks, step by step.
- [llms.txt](llms.txt): the map for agents.
- [CHANGELOG](CHANGELOG.md).

## Support

Report bugs and ask questions at https://github.com/arki-labs/arki/issues.

## Failures

The signed client (`createForemanClient`), the Coolify clients, `fetchFleetSnapshot` and `parseWebhookHint` return `@arki/failure` failures for expected outcomes; they do not throw. Match on `failure.code`: `admin.unauthenticated`, `admin.scope_denied`, `admin.writes_disabled`, `admin.stale_approval`, `admin.unknown_capability`, `admin.receipts_unavailable`, `admin.execution_in_progress`, `admin.invalid_request`, `admin.protocol_unsupported`, `admin.target_mismatch`, `admin.unreachable`, `admin.invalid_output`, `admin.handler_failed`, and `admin.module_refused` (an error a module declared; its own code and HTTP status are in `data`). All are exported from `@arki/admin/module`. On the wire the protocol keeps its stable `ARKI_ADMIN_E0NN` code; `wireCodeOf(failure.code)` gives it. `AdminError` is thrown only for bugs: invalid keys or configuration, a client without an execute key, invalid scopes.

Each failure is a value you can match with `failure.code` or call to build one. The list lives in `ADMIN_FAILURES` (`@arki/admin/module`).

| Export                     | Code                          | When it is returned                                                                           |
| -------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `AdminUnauthenticated`     | `admin.unauthenticated`       | The request failed authentication. The app log names the failed check.                        |
| `AdminScopeDenied`         | `admin.scope_denied`          | The signed scopes do not cover the permission of the read or action.                          |
| `AdminWritesDisabled`      | `admin.writes_disabled`       | The app runs with `FOREMAN_WRITES=off`, so it refuses every execute.                          |
| `AdminStaleApproval`       | `admin.stale_approval`        | The approval pinned a different action contract than the app runs now.                        |
| `AdminUnknownCapability`   | `admin.unknown_capability`    | No route, read or action with that id on the app, or no resource at that Coolify path.        |
| `AdminReceiptsUnavailable` | `admin.receipts_unavailable`  | An execute was refused before it ran, because no receipt could be recorded.                   |
| `AdminExecutionInProgress` | `admin.execution_in_progress` | An execute with this execution id is still running, or stopped before it recorded an outcome. |
| `AdminInvalidRequest`      | `admin.invalid_request`       | The input does not match the schema of the read or action.                                    |
| `AdminProtocolUnsupported` | `admin.protocol_unsupported`  | The other side does not speak the protocol version this side needs.                           |
| `AdminTargetMismatch`      | `admin.target_mismatch`       | A response did not prove it came from the expected target, so the client refused it.          |
| `AdminUnreachable`         | `admin.unreachable`           | The target or Coolify could not be reached, or answered a redirect or server error.           |
| `AdminInvalidOutput`       | `admin.invalid_output`        | A response is outside the contract: not protocol JSON, or a shape that fails its schema.      |
| `AdminHandlerFailed`       | `admin.handler_failed`        | The app's own read, preview or execute code failed. Details stay in the app's log.            |
| `AdminModuleRefused`       | `admin.module_refused`        | The app refused with an error its module declared. Its code and HTTP status are in `data`.    |

`adminFailureOfWire(wireCode, detail)` turns an `ARKI_ADMIN_E0NN` wire code back into its failure. It returns `undefined` for a code that is not a protocol code.

`createFleetHandler` answers a provider error as `502 { "error": "snapshot_failed" }` and a snapshot outside the contract as `500 { "error": "invalid_snapshot" }`. The cause goes to the log (`DEBUG=arki:admin:fleet`), never to the caller.
