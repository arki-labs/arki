---
'@arki/journal': minor
---

`limits.transitions` is enforced. It was declared (default 1000) and nothing read it, so a loop could run without end. New column `workflow_runs.transitions`, so an app generates a migration and backfills its open runs (the upgrade note has the SQL).

- A transition is the first try of a node. Each visit of a node in a loop counts, and so does a node its `when` skips. A retry and an undo do not. The count is written by the event that schedules the node, so it survives a crash and a restart.
- A node that would pass the cap does not run. The run compensates, as it does for a deadline, and ends `failed` with the new failure `WorkflowTransitionLimit` (`journal.workflow_transition_limit`, with `data.limit` and `data.transitions`). `onDeadStep` does not apply: a loop that must stop does not wait for an operator.
- A workflow whose healthy run passes 1000 transitions now fails: set `limits: { transitions }` above `rounds * nodes in the loop`.
