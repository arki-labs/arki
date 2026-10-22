---
'@arki/dot': minor
'@arki/failure': minor
---

One way to write a context step (RFC `docs/rfcs/2026-10-21-dot-middleware.md`, step 1):

- `derive('principal', fn)` and `derive(fn)` make a step: it reads the least context it needs, adds to it, or refuses the call by returning a typed failure. What it adds and how it refuses are inferred from `fn`'s return.
- `fromDerive(step)` from `@arki/dot/orpc` attaches a step to an oRPC procedure: `impl.refund.use(fromDerive(authed))`. A refusal is thrown as the typed error the procedure declares; a procedure that does not declare the step's failure does not compile.
- `@arki/failure/orpc` adds `rpcError(failure, errors)`: the declared `ORPCError` for a failure already in hand, to throw.

`derive` is not yet exported as `@arki/dot/middleware`; HTTP and queue adapters follow.
