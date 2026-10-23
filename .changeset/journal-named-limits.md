---
'@arki/journal': minor
---

Named limits and pause for workflows. `j.limit({ name, total?, perKey? })` makes a limit several workflows share: list it in `concurrency.shared` (at most two). `concurrency` also takes `total` (every unfinished run of the workflow) next to `limit` (per key), and `key` is optional unless `limit` or a shared `perKey` needs it; together `limit` and `total` are the workflow's own limit, `workflow/<name>`. A start is admitted only when every limit it holds has room; `onBusy: 'join'` joins only when the workflow's own per-key limit is full. `{ key, limit, onBusy }` works as before.

`journal.limits` reads and changes limits at runtime: `list`, `get`, `override` (the limit's `total` and `perKey`, or one key's `perKey` for up to 30 days, 7 by default; `0` admits nothing), `reset`, `pause` and `resume`. A paused limit admits no new run (`WorkflowBusy` with `reason: 'paused'`); running runs finish. A workflow without `concurrency` can be paused by its own name. Each change is an event on the new `journal.limit` entity that names the operator; an unknown name is `CommandNotFound`. `WorkflowBusy` data gains `limitName` and `reason` (`LIMIT_BUSY_REASONS`). New exports: `LIMIT_BOUNDS`, `LIMIT_KEY_TTL`, `WORKFLOW_LIMIT_PREFIX`, `LIMIT_BUSY_REASONS`, `LimitDef`, `LimitView`, `LimitOps` and the verb argument types.

Migration needed: `workflow_runs` gets `limits text[] not null default '{}'` with a partial GIN index (`workflow_runs_limits_idx`), and there is a new table `journal_limits`. Run `drizzle-kit generate`. Old runs hold no shared limit; a workflow's own limit counts them by name.
