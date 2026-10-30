# @arki/admin for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/errors.ts` and `src/module.ts` win.

## The model

1. An app exposes **modules**. A module holds reads, actions, signals and panels. `defineModule` builds one.
2. Foreman calls the app at `/api/foreman/*` with signed requests. Reads use the read key. Executes use the execute key.
3. `createForemanRoute` builds the handler on the first request. With no `FOREMAN_*` keys it answers 404.
4. An execute is two steps. `preview` returns a `revision`. `execute` runs with the `schemaHash` Foreman approved.
5. The handler records a receipt for every execute, keyed by `executionId`. A lost answer is read back with `core.receipts.get`.
6. Failures are `AdminError` values with a code. A module can add its own code with `moduleError`.
7. Reads and actions take any Standard Schema (Zod, Valibot, ArkType). Output is only as narrow as its schema.

## Task map

### Mount Foreman in a plain TanStack app

1. Spread `foremanEnvShape` from `@arki/admin/env` into the env schema.
2. Call `createForemanRoute(() => ({ env, app, store, context, health, modules }))` from `@arki/admin/server`.
3. Mount it as `ANY: ({ request }) => foremanRoute(request)` on `/api/foreman/$`.
4. Pick a `store`: an `@arki/kv` KV, `pgForemanStore`, or `memoryForemanStore` for one instance with writes off.

### Mount Foreman in a Dot app

1. Add `...foreman(build)` from `@arki/admin/dot` to a feature's `entrypoints({ kind: 'routes', ... })`.
2. Give Foreman its own feature. The entrypoint lands under the `routes` key.

### Define a module with a read

1. Call `defineRead({ id, summary, permission, input, output, load })`.
2. Put the reads in `defineModule({ id, version, reads, actions })`.
3. Pass the module in `modules`.

```ts run
import { z } from 'zod';

import { defineModule, defineRead } from '@arki/admin/module';

const pizzaCount = defineRead({
  id: 'pizzeria.pizzaCount',
  summary: 'How many pizzas are in the oven',
  permission: 'pizzeria:read',
  input: z.object({}),
  output: z.object({ count: z.number() }),
  load: async () => ({ count: 3 }),
});

const pizzeria = defineModule({
  id: 'pizzeria',
  version: '1.0.0',
  reads: { pizzaCount },
  actions: {},
});

console.log(pizzeria.id, await pizzaCount.run({}, {}));
```

### Refuse with a module's own code

1. Call `moduleError('MY_CODE', 409, message, remediation)` and throw it from `execute`.
2. Run error text through `redactSecrets` before it reaches the wire.

### Show a screen without Foreman code

1. Return `boardOutputSchema` or `rowsOutputSchema` from `@arki/admin/panels` as the read's `output`.
2. Add `{ id, renderer: PANEL_RENDERER.board, read, actions }` to the module's `panels`.

### Turn writes on

1. Set `FOREMAN_WRITES=on`.
2. Give the route a store that can take a claim (`setIfNotExists` must be atomic across instances).

## Rules that bite

- Set all four of `FOREMAN_APP_ID`, `FOREMAN_APP_KEY`, `FOREMAN_READ_KEY`, `FOREMAN_EXECUTE_KEY`, or none. A partial set throws `ARKI_ADMIN_E014`.
- The execute key must differ from the read key.
- `memoryForemanStore` forgets nonces on restart. Keep `FOREMAN_WRITES` off with it.
- A receipt `ttlSeconds` below 300 throws `ARKI_ADMIN_E014`.
- A `load` that returns a whole database row can leak a column if the output schema keeps unknown keys. Zod and Valibot drop them. An ArkType object keeps them unless it declares `'+': 'delete'`.
- An action that ran but returned data its own schema rejects is recorded `applied` with `result: null`, and answers `ARKI_ADMIN_E005`.
- A second execute with the same id never runs the action again.

## Errors

| Code              | Meaning                                                              | What to do                                                |
| ----------------- | -------------------------------------------------------------------- | --------------------------------------------------------- |
| `ARKI_ADMIN_E001` | A module, read, action or signal definition broke the contract.      | Fix the reported field.                                   |
| `ARKI_ADMIN_E002` | Two reads/actions, signals or panels of one module share an id.      | Give each a unique id.                                    |
| `ARKI_ADMIN_E003` | A panel names a read or action the module does not define.           | Reference a key the module declares.                      |
| `ARKI_ADMIN_E004` | Input does not match the input schema.                               | Send input the schema accepts.                            |
| `ARKI_ADMIN_E005` | App code returned data its output schema rejects.                    | Return output the schema accepts.                         |
| `ARKI_ADMIN_E006` | No Web Crypto, so `schemaHash` cannot run.                           | Run in a runtime with `globalThis.crypto.subtle`.         |
| `ARKI_ADMIN_E007` | A request failed authentication (HTTP 401).                          | Check the private log: key, audience, clock, body, nonce. |
| `ARKI_ADMIN_E008` | The signed scopes do not cover the permission (HTTP 403).            | Grant the scope.                                          |
| `ARKI_ADMIN_E009` | `FOREMAN_WRITES` is off (HTTP 403).                                  | Turn writes on for the intended target only.              |
| `ARKI_ADMIN_E010` | The approval pinned a different `schemaHash` (HTTP 409).             | Preview again and get a fresh approval.                   |
| `ARKI_ADMIN_E011` | No route, read or action with that id (HTTP 404).                    | Refresh the manifest and use an advertised id.            |
| `ARKI_ADMIN_E012` | A response did not prove it came from the expected audience.         | Correct the target audience.                              |
| `ARKI_ADMIN_E013` | The other side does not speak the required protocol version.         | Use versions that support the same protocol.              |
| `ARKI_ADMIN_E014` | Keys, audience or other configuration is invalid.                    | Fix the configuration named in the message.               |
| `ARKI_ADMIN_E015` | App code threw (HTTP 500). Details stay in the app log.              | Read the app log.                                         |
| `ARKI_ADMIN_E016` | The client could not reach the target. The outcome is unknown.       | Check the receipt before repeating a write.               |
| `ARKI_ADMIN_E017` | No receipt could be recorded, so the execute was refused.            | Configure a healthy receipt store.                        |
| `ARKI_ADMIN_E018` | An execute with this id is still running or died before it recorded. | Read the receipt. Wait or reconcile before another write. |

A module's own code is a string of its choosing. The wire and receipt `code` is one of these or a module's.

## Verify

```sh
bun run typecheck
bun run test
bun run test:docs

# In an app that mounts Foreman: the plugin graph, then the booted app's health.
dot explain --json | jq '.data'
dot doctor --json | jq '.data'
```
