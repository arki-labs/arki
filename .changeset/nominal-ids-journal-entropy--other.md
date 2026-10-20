---
'@arki/admin': minor
'@arki/queue': minor
---

Add nominal domain kinds to `defineId(prefix, { kind })`, preserving canonical
schema output through `IdOf` and DB columns without changing stored strings.
The one-argument declaration remains compatible. Migrate each domain and its
consumers together using the canonical schema at raw boundaries.

Replace Journal's private Cuid2 generation with modern, supervised declarations.
Public `jobId`, Journal write/worker/workflow/operator methods, webhook scheduling,
Queue outbox scheduling and Mail outbox scheduling can now return precise
`IdGenerationFailure` outcomes. Handle returned failures before treating an
operation as committed or acknowledged. Partial writes roll back and adapters
preserve the original failure.

Admin actions can declare canonical `failures` and infer their exact execute
outcomes. Refusals produce failed receipts; undeclared or thrown failures are
supervised without leaking private metadata. Receipt replay and clients support
canonical server-error statuses. Dot outbox producers retain the complete
scheduling outcome.

See Contracts' `docs/upgrades/domain-ids.md` and Journal's
`docs/upgrades/id-generation-failures.md` for migration details and remaining
identity-branding scope.
