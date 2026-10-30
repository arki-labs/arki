---
'@arki/journal': minor
---

A workflow can continue on a step's failure, a caller can wait for a run's outcome, and `def.read` types more nodes.

- `.step(name, body, { output, failures: [Declined], onFailure: 'continue' })` keeps a listed returned failure as the step's result and the run goes on. The result type is the output plus the failures. The failure is stored as its envelope and read back, by its own schema, as a real failure. Any unlisted failure still fails the step. `onFailure` needs `failures` and an `output` schema, or the definition throws `BAD_DEFINITION`.
- A last node that can be a failure (a command with `accept`, a step with `onFailure: 'continue'`) now needs a function in `.finish`, and `.finish()` without one is a compile error. The `BAD_DEFINITION` throw stays as a backstop.
- `def.settled(db, runId, { within })` returns the typed run once it ended, or the new failure `WorkflowPending { runId }`. `def.startAndWait(db, args, { meta, timeout, signal })` starts a run and waits: the output, `WorkflowRunFailed`, `WorkflowRunCancelled`, or `WorkflowPending`. Both take the root database (a transaction handle throws `BAD_ARGUMENT`), take seconds above 0 and at most 30, and never cancel the run. New failures: `WorkflowPending`, `WorkflowRunFailed`, `WorkflowRunCancelled`.
- `def.read` checks and types a sleep (`null`), a `.child(name, def)` and a `.map` of a definition with an `output` schema. A stored value that no longer fits is `WorkflowReadMismatch`. A child chosen by a function stays `unknown`.
