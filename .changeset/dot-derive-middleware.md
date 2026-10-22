---
'@arki/dot': minor
'@arki/failure': minor
---

One way to write middleware (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, step 1):

- A step is a plain function: `(ctx) => object | Failure`. It reads the least context it needs, adds the keys of the object it returns, or refuses the call with a typed failure. `step(fn)` from `@arki/dot/orpc` runs it before an oRPC procedure: `impl.refund.use(step(authed))`. A refusal is thrown as the typed error the procedure declares; a procedure that does not declare the step's failure does not compile.
- An around is a plain function: `<T>(ctx, next: () => Promise<T>) => Promise<T>`. `around(fn)` from `@arki/dot/orpc` wraps the rest of the chain and the handler, for a transaction, a retry or a span. It never sees the result's shape.
- `@arki/failure/orpc` adds `rpcError(failure, errors)`: the declared `ORPCError` for a failure already in hand, to throw.

HTTP, queue, schedule and CLI take the same functions next.
