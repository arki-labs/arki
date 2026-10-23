---
'@arki/journal': minor
---

Workflow runs take a scope, tags and metadata when they start.

- `def.start` takes `{ input, id?, scope?, tags?, metadata? }`. `scope` is the tenant or owner key of the run (1 to 256 characters). `tags` are up to 10 labels of 1 to 128 characters. `metadata` is a JSON object of at most 256 KiB. The limits are exported as `RUN_FIELD_LIMITS`, and the field type as `RunFields`.
- A start outside the limits creates no run. A bad shape returns `InvalidInput`; metadata that is too large returns `CommandInvalid`, which `StartOutcome` now includes.
- Each run stores `rootId`: null for a top run, else the id of the top run of its tree. A child run (`child`, `map`) takes its parent's `scope` and `rootId`, and no tags or metadata.
- Starting an existing id under another `scope` is a `CommandConflict`.
- `journal.workflows.run` and `journal.workflows.runs` return `scope`, `tags` and `rootId` (and `run` also `metadata`). `runs` filters by `tag`, `scope`, `rootId`, `from` and `to` (start time). The Foreman workflow console shows and filters by them too.
- `workflow_runs` gets four columns: `scope`, `tags`, `metadata` and `root_id`, with an index on `scope`, a GIN index on `tags` and an index on `root_id`. Run `drizzle-kit generate` and apply the migration before you deploy. Runs started before keep working: their rows get no scope, no tags, empty metadata and no root.
