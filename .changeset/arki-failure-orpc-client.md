---
'@arki/failure': minor
---

New in `@arki/failure/orpc`: `reviveRpcError(error, definitions)`. On the client, it turns a caught `ORPCError` whose code is one of the definitions back into the live failure, and checks its data with the definition's schema like `revive`. Any other error gives `undefined`, so you rethrow it. The result is typed from the definitions, so frontend code can `match` on failures the same way backend code does.
