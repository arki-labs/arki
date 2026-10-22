---
'@arki/journal': minor
---

A browser-safe `@arki/journal/contract` subpath, so an oRPC contract that ships to the browser no longer bundles Drizzle:

- `@arki/journal/contract`: everything a contract needs: `COMMAND_FAILURES`, `CommandNotFound`, `CommandInvalid`, `CommandForbidden`, `CommandConflict`, `WorkflowStranded`, `WorkflowReadMismatch`, and the type `CommandFailure`.
- `@arki/journal/errors` now takes the transaction failures from `@arki/db/errors` instead of `@arki/db/transaction`, so it no longer loads Drizzle either. Its exports are unchanged.
