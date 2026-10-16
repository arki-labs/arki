---
'@arki/contracts': minor
---

New `@arki/contracts/orpc` entry: one typed identity per oRPC contract procedure.
`operations(contract)` returns a frozen tree with an `Operation` (`path`, `name`, `meta`,
phantom input/output/error types) at every leaf; `operationAt(contract, path)` finds one;
`OPERATION` (`'~op'`), `Identified<Op>` and `operationOf(carrier)` let client utils carry it.
Types are inferred from the contract (`OperationOf<C>`, `InputOf`, `OutputOf`, `ErrorOf`, `MetaOf`).
`@orpc/contract` is a new optional peer; the main entry still does not import it.

Fix: `pageInput`'s client input now types the cursor as `string` (it was `unknown`), because
`Keyset.cursor` is `z.ZodType<string, string>`.

The package now runs `test:runtimes` (Node, Bun, Deno, browser, Hermes).
