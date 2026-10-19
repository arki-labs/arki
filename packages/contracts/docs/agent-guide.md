# Agent guide: @arki/contracts

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, the code in `src/index.ts`, `src/drizzle.ts` and `src/orpc.ts` wins.

## The model

1. `@arki/contracts` is a set of schema helpers on top of Zod. The main entry is browser-safe.
2. An id kind is declared once with `defineId('sty_')`. The type, the schema and the generator come from that one prefix.
3. A list order is declared once with `keyset(...)`. The contract and the repository both read it.
4. `@arki/contracts/orpc` turns a contract into plain data. One `Operation` per procedure: `{ path, name, meta }`.
5. `@arki/contracts/drizzle` builds select, insert and update schemas from a table, keeping branded id types.
6. It does not talk to a database, send requests or hold state.

## Task map

### Declare an id kind once

1. Write the declaration in a browser-safe model file: `export const storyId = defineId('sty_');`.
2. Derive the type: `export type StoryId = IdOf<typeof storyId>;`.
3. Validate with `storyId.schema`. Make a new id with `storyId.create()`.
4. On the server, turn it into columns with `idColumns(storyId)` from `@arki/db/id`.
5. In one test, call `assertUniqueIdPrefixes(...allIds)`.

### Paginate a list with a keyset

1. Declare the order once: `export const storyOrder = keyset({ createdAt: 'desc', id: 'desc' });`.
2. Use it in the contract: `oc.input(pageInput(storyOrder)).output(page(storySchema))`.
3. In the repository, build the query with `keysetQuery(storyOrder, columns)` from `@arki/db/pagination`.
4. Return `nextCursor: null` when there are no more rows. Decide it by fetching one extra row.

### Build branded table schemas

1. Import from `@arki/contracts/drizzle`, not from the main entry.
2. `createSelectSchema(table)`, `createInsertSchema(table)`, `createUpdateSchema(table)`.
3. Declare JSONB with `jsonColumn(name, storageSchema)`; reuse the schema as `{ profile: () => storageSchema }` for precise types. The storage schema output must be JSON-compatible, accepted as input, and stable when parsed again. Optional fields must be omitted rather than set to undefined; apply wire codecs only in explicit refinements. A bare `$type<T>()` is not validation.
4. Override one column with a refine: `createSelectSchema(table, { email: z.email() })`.

### Give a contract procedure a typed identity

Use `@arki/contracts/orpc` when client code needs to know which procedure it holds. For example, to queue it offline, to log it, or to check a policy the contract declares.

1. **Write the contract once**, browser-safe (`@orpc/contract`, zod, `@arki/contracts`, model files): `export const rpcContract = { posts: { list: oc.input(pageInput(order)).output(page(post)) } }`.
2. **Declare policy on the contract**, not on the client. Offline safety: `create: offlineSafe(oc.input(createPost).output(post))` (`@arki/offline/orpc`).
3. **Build the client utils from the contract value**: `export const orpc = createOrpcUtils(rpcContract, client)` (`@fleet/tanstack-start/orpc/client`). Each leaf is oRPC's own utils plus `'~op'`.
4. **Read the identity** with `operationOf(orpc.posts.create)`. It gives `{ path, name, meta }`. A typed consumer can read it too: `useOfflineMutation(orpc.posts.create)` compiles only when the meta says `offlineSafe: true`.

| Export                                     | Contract                                                                                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operations(contract)`                     | Walks the contract once. Returns a frozen tree with an `Operation` at every leaf. Throws `ContractsError` (naming the path) for a key with `.` or a reserved key. |
| `operationAt(contract, path)`              | The operation at `path`, or `undefined` for a group or a miss.                                                                                                    |
| `operationOf(carrier)`                     | The operation under `'~op'`. `ContractsError` when there is none or it is malformed.                                                                              |
| `OPERATION`                                | `'~op'`, the carrier key.                                                                                                                                         |
| `Operation<I, O, E, M>`                    | `{ path, name, meta }` plus phantom types. `name === path.join('.')`.                                                                                             |
| `OperationOf<C>`, `Operations<C>`          | Inferred from `ContractProcedure<I, O, E, M>`: input before transforms, output after, typed errors, meta.                                                         |
| `InputOf`, `OutputOf`, `ErrorOf`, `MetaOf` | Read one type off an operation.                                                                                                                                   |

## Rules that bite

- **`.meta({ offlineSafe: true })` cannot prove the policy.** oRPC keeps the meta type the builder declared. Use the marker function, which puts the literal `true` into the type.
- **A raw `createTanstackQueryUtils` leaf has no operation.** Consumers that need identity reject it at compile time. Plain JavaScript callers get a `ContractsError` from `operationOf`.
- **The contract value goes to the browser** with its Zod schemas. `minifyContractRouter` keeps path and meta, so `operations()` still works on it when bundle size matters.
- **End a keyset on a unique key.** Rows with the same `createdAt` have no order of their own.
- **A cursor is not secret.** It is base64url JSON of the last row's key values.
- **Prefixes are stored as given.** `defineId('hlgt_')` matches rows already stored.
- **`defineId().create()` needs Web Crypto.** React Native needs `react-native-get-random-values`.

## Errors

Every error is a `ContractsError` (a `TypeError`). Match on `error.code`.

| Code                  | Meaning                                                     | What to do                                                 |
| --------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| `ARKI_CONTRACTS_E001` | `defineId` got a prefix that is not letters, digits or `_`. | Use letters, digits and `_`, for example `sty_`.           |
| `ARKI_CONTRACTS_E002` | Two prefixes are equal or one starts the other.             | Give each id kind a prefix that does not start another.    |
| `ARKI_CONTRACTS_E003` | No `crypto.getRandomValues` on this engine.                 | Run where it exists, or add a polyfill.                    |
| `ARKI_CONTRACTS_E004` | `keyset` got no keys, or a row with a NULL key.             | Declare a key. Order by NOT NULL columns.                  |
| `ARKI_CONTRACTS_E005` | The cursor is not one this keyset made.                     | Send the cursor back unchanged, or start from page one.    |
| `ARKI_CONTRACTS_E006` | A contract key contains `.` or a reserved name.             | Rename the key.                                            |
| `ARKI_CONTRACTS_E008` | A Drizzle builder has no runtime metadata config.           | Use a supported Drizzle builder and matching version.      |
| `ARKI_CONTRACTS_E007` | The value carries no operation.                             | Pass a `createOrpcUtils` leaf or an `operations()` result. |

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
```
