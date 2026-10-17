---
'@arki/failure': minor
---

New `stoppable(value, stoppedBy?)` builds a `Stoppable<Value, Failures>`, so a partial-success function's return type is inferred: return `stoppable(value)` when the work finished and `stoppable(value, failure)` when a failure stopped it, with no `Promise<Stoppable<...>>` annotation. It returns a shallow copy of `value` and adds the `stoppedBy` key only when a failure is given.
