---
'@arki/async': minor
'@arki/dot': minor
---

Own resources and child work through typed descriptors. Replace imperative `scoped` registration with `resource`, `cleanup`, `child`, `scoped(plan, body)`, `openScope` and checked dynamic scopes. Preserve exact callback failures and canonical cancellation, deadline and defect outcomes; keep cleanup members private when serializing aggregate failures.

Dot owns partial plugin construction, publishes services atomically, joins children before disposal and retains finalizer failures. Lazy services coalesce initialization, retry only on a later explicit get, and expose only successful values through peek. Lifecycle callers, HMR and CLI supervision now inspect resolved ownership failures. Existing static/configure and legacy start/stop exception migration continues separately.

Breaking upgrade: see `@arki/dot/docs/upgrade-ownership.md` and `@arki/async/README.md`. Check boot/start/get/dispose results before using them; deadlines request cancellation and wait for admitted work to settle before releasing resources.

`ProvidesFactories` now describes raw callback returns, including promises. Infer factory records at their definitions; handles and lifecycle callbacks continue to receive resolved service values.
