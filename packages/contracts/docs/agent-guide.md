# Agent guide: give a contract procedure a typed identity

Use `@arki/contracts/orpc` when client code needs to know WHICH procedure it holds
— to queue it offline, to log it, to check a policy the contract declares.

1. **Write the contract once**, browser-safe (`@orpc/contract`, zod, `@arki/contracts`, model files):
   `export const rpcContract = { posts: { list: oc.input(pageInput(order)).output(page(post)) } }`.
2. **Declare policy on the contract**, not on the client. Offline safety:
   `create: offlineSafe(oc.input(createPost).output(post))` (`@arki/offline/orpc`).
3. **Build the client utils from the contract value**:
   `export const orpc = createOrpcUtils(rpcContract, client)` (`@arki/tanstack-start/orpc/client`).
   Each leaf is oRPC's own utils plus `'~op'` — same keys as `createTanstackQueryUtils(client)`.
4. **Read the identity** with `operationOf(orpc.posts.create)` → `{ path, name, meta }`, or let a
   typed consumer read it (`useOfflineMutation(orpc.posts.create)` compiles only when the meta says
   `offlineSafe: true`).

## Exports

| Export | Contract |
| --- | --- |
| `operations(contract)` | Walks the contract once; returns a frozen tree with an `Operation` at every leaf. Throws `TypeError` (naming the path) for a key with `.` or a reserved key. |
| `operationAt(contract, path)` | The operation at `path`, or `undefined` for a group or a miss. |
| `operationOf(carrier)` | The operation under `'~op'`; `TypeError` when there is none or it is malformed. |
| `OPERATION` | `'~op'`, the carrier key. |
| `Operation<I, O, E, M>` | `{ path, name, meta }` plus phantom types. `name === path.join('.')`. |
| `OperationOf<C>`, `Operations<C>` | Inferred from `ContractProcedure<I, O, E, M>`: input before transforms, output after, typed errors, meta. |
| `InputOf`, `OutputOf`, `ErrorOf`, `MetaOf` | Read one type off an operation. |

## Traps

- **`.meta({ offlineSafe: true })` cannot prove the policy.** oRPC keeps the meta type the builder
  declared. Use the marker function, which puts the literal `true` into the type.
- **A raw `createTanstackQueryUtils` leaf has no operation.** Consumers that need identity reject it at
  compile time; plain JavaScript callers get a `TypeError` from `operationOf`.
- **The contract value goes to the browser** with its Zod schemas. `minifyContractRouter` keeps path and
  meta, so `operations()` still works on it when bundle size matters.
