---
'@arki/journal': patch
---

Workflow concurrency no longer crosses a run's `scope`. The limit still counts every run with the key, but `onBusy: 'join'` joins only a run of the caller's own scope (otherwise the start is `WorkflowBusy`), and `WorkflowBusy.running` lists only the caller's own scope's run ids. Before, two tenants whose inputs gave the same key could get each other's run ids.
