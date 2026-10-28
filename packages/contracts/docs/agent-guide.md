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

1. Write the declaration in a browser-safe model file: `export const storyId = defineId('sty_', { kind: 'story' });`. Use a stable, literal domain name to separate kinds even when their stored prefixes match.
2. Derive the type: `export type StoryId = IdOf<typeof storyId>;`.
3. Validate with `storyId.schema`. Make a new id with `storyId.create()` and check `isFailure` before using it. The exact result is `IdOf<typeof storyId> | IdGenerationFailure`; `ID_GENERATION_FAILURES` is the canonical adapter tuple. Schema output and `IdOf` remain success-only.
4. On the server, turn it into columns with `idColumns(storyId)` from `@arki/db/id`.
5. In one test, call `assertUniqueIdPrefixes(...allIds)`.
6. Parse raw IDs at boundaries with the owning schema; infer stored types with `IdOf`. The one-argument form preserves prefix-only compatibility. See [domain ID migration](upgrades/domain-ids.md) for brands, external/numeric IDs and wire-format limits.

For UUID-v4 generation, use `defineId('', { kind: 'queue.job', format: 'uuid' })`.
Only generation changes: the prefix-only schema still accepts external job keys.
The default remains a 24-character body. UUID generation prefers native
`crypto.randomUUID`. If it is not callable, the generator uses 16 bytes from
`crypto.getRandomValues`, setting the RFC 9562 UUID-v4 version and variant bits.
An available native provider that throws or returns invalid output produces
`UnexpectedDefect`; it never triggers the fallback. Missing both secure providers
returns `RandomSourceUnavailable`. Both paths preserve the exact failure union.

For existing nanoid-style stored bodies, declare the format on the identity:

```ts run
import { defineId } from '@arki/contracts';
import { orThrow } from '@arki/failure';

const recordId = defineId('', {
  kind: 'offline.idempotency-record',
  format: { alphabet: '_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', length: 21 },
});
const value = orThrow(recordId.create());
if (!/^[_\-\da-zA-Z]{21}$/.test(value)) throw new Error('Stored format changed');
```

Custom formats require 2–256 distinct non-surrogate UTF-16 alphabet characters
and an integer length of 1–256. Every position uses that alphabet uniformly;
there is no letter-first rule. Parsing copies and freezes the format at definition
time. The schema continues to validate only the prefix. Extra fields, generator
hooks, duplicate characters, surrogate pairs and out-of-range values raise
`ARKI_CONTRACTS_E010`. Rejection sampling uses at most 32 batches of twice the
configured length, up to 16,384 total bytes; a broken provider returns the same
exact `IdGenerationFailure` union. No weak source or global polyfill is installed.

When the runtime lacks Web Crypto, initialize an application-owned provider
backed by secure platform entropy before calling `create()`. It must fail closed
when secure entropy is unavailable in every supported mode, including debugging.
A secure `getRandomValues` provider supports UUID generation without `randomUUID`.
Contracts checks the synchronous provider protocol; it cannot certify entropy
quality from returned bytes. The library never installs a global polyfill or
substitutes weak entropy.

### Paginate a list with a keyset

1. Declare the order once: `export const storyOrder = keyset({ createdAt: 'desc', id: 'desc' });`.
2. Use it in the contract: `oc.input(pageInput(storyOrder)).output(page(storySchema))`.
3. In the repository, build the query with `keysetQuery(storyOrder, columns)` from `@arki/db/pagination`.
4. Check `keysetQuery.after` and `keysetQuery.page` with `isFailure` before using their values. Encoding and decoding return exact canonical failures; declare `CURSOR_FAILURES` through the adapter error map.
5. Return `nextCursor: null` when there are no more rows. Decide it by fetching one extra row.

### Build branded table schemas

1. Import from `@arki/contracts/drizzle`, not from the main entry.
2. `createSelectSchema(table)`, `createInsertSchema(table)`, `createUpdateSchema(table)`.
3. Declare JSONB with `jsonColumn(name, storageSchema)`; reuse the schema as `{ profile: () => storageSchema }` for precise types. The storage schema output must be JSON-compatible, accepted as input, and stable when parsed again. Optional fields must be omitted rather than set to undefined; apply wire codecs only in explicit refinements. A bare `$type<T>()` is not validation.
4. Override one column with a refine: `createSelectSchema(table, { email: z.email() })`.

### Give a contract procedure a typed identity

Use `@arki/contracts/orpc` when client code needs to know which procedure it holds. For example, to queue it offline, to log it, or to check a policy the contract declares.

1. **Write the contract once**, browser-safe (`@orpc/contract`, zod, `@arki/contracts`, model files): `export const rpcContract = { posts: { list: oc.input(pageInput(order)).output(page(post)) } }`.
2. **Declare policy on the contract**, not on the client. Offline safety: `create: offlineSafe(oc.input(createPost).output(post))` (`@arki/offline/orpc`).
3. **Build the client utils from the contract value**: `export const orpc = createOrpcUtils(rpcContract, client)` (`@arki/tanstack-start/orpc/client`). Each leaf is oRPC's own utils plus `'~op'`.
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
- **Operation keys are own data properties.** Valid prototype-shaped keys such as `__proto__` remain visible in enumeration and JSON serialization, including nested groups. Reserved query-utils names still fail at definition time.
- **End a keyset on a unique key.** Rows with the same `createdAt` have no order of their own.
- **A cursor is not secret.** It is base64url JSON of the last row's key values.
- **Prefixes are stored as given.** `defineId('hlgt_')` matches rows already stored.
- **`defineId().create()` needs Web Crypto.** Applications on runtimes without it must initialize a provider backed by secure platform entropy that fails closed in every supported mode.
- **`createIdBody()` is the shared entropy primitive.** It returns the same `IdGenerationFailure` union and a 24-character body on success. Use an ID declaration to give it a domain identity; raw bodies do not establish domain types.

## Errors

Static misuse throws `ContractsError` (a `TypeError`). Cursor codecs return `InvalidCursor`, `InvalidCursorValue`, `ValidatorDefect` or `UnexpectedDefect`; derive their exact per-operation unions from `CURSOR_DECODE_FAILURES` / `CURSOR_ENCODE_FAILURES`. ID generation returns `RandomSourceUnavailable` for missing/malformed providers and `UnexpectedDefect` for thrown access/provider faults, invalid output or exhausted rejection sampling (32 batches of twice the body length; 48 bytes per default batch). Causes are private. Match on canonical definitions.

| Code                  | Meaning                                                     | What to do                                                 |
| --- | --- | --- |
| `ARKI_CONTRACTS_E001` | `defineId` got a non-string prefix. | Supply the exact stored prefix as a string; `''` means unprefixed. |
| `ARKI_CONTRACTS_E002` | Two prefixes are equal or one starts the other.             | Give each id kind a prefix that does not start another.    |
| `ARKI_CONTRACTS_E003` | Reserved legacy exception code; use `RandomSourceUnavailable`. | Run where it exists, or add a polyfill.                    |
| `ARKI_CONTRACTS_E004` | `keyset` got no keys in its static declaration.             | Declare a key. Order by NOT NULL columns.                  |
| `ARKI_CONTRACTS_E005` | Reserved legacy exception code; use `InvalidCursor`.                     | Send the cursor back unchanged, or start from page one.    |
| `ARKI_CONTRACTS_E006` | A contract key contains `.` or a reserved name.             | Rename the key.                                            |
| `ARKI_CONTRACTS_E008` | A Drizzle builder has no runtime metadata config.           | Use a supported Drizzle builder and matching version.      |
| `ARKI_CONTRACTS_E009` | `defineId` got a missing, empty or non-string domain kind. | Supply one non-empty literal domain name. |
| `ARKI_CONTRACTS_E010` | `defineId` got an unsupported generation format. | Use `'uuid'`, omit format, or supply `{ alphabet, length }`: 2–256 distinct non-surrogate UTF-16 characters and integer length 1–256. |
| `ARKI_CONTRACTS_E007` | The value carries no operation.                             | Pass a `createOrpcUtils` leaf or an `operations()` result. |

| Definition | Meaning | What to do |
| --- | --- | --- |
| `contracts.random_source_unavailable` | No callable Web Crypto provider.                            | Install a secure Web Crypto provider.                                   |
| `contracts.invalid_cursor` | Malformed external cursor. | Send it unchanged or start from page one. |
| `contracts.invalid_cursor_value` | Missing/unrepresentable key or cursor over 1024 characters. | Use valid Dates, finite numbers, strings and booleans in NOT NULL keys. |
| `schema.validator_defect` | Cursor validator failed unexpectedly. | Fix the validator; inspect its private cause. |
| `failure.unexpected_defect`           | Cursor codec or ID provider failed unexpectedly.            | Inspect the private cause at the owning boundary.                       |

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
```
