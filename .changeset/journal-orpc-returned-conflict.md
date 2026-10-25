---
'@arki/journal': patch
---

`toORPCError` and `commandErrors()` answer the `TransactionDefect` that `journal.run` returns for a `JournalError('CONFLICT')` with the same 409 as the thrown conflict. Since a command's transaction started returning thrown errors as `TransactionDefect`, a stale `expectedVersion` or a lost insert race reached the client as a 500.

no docs impact: README already promised the 409; one sentence added on the returned shape.
no demo impact: error mapping only.
