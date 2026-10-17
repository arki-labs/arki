---
'@arki/queue': minor
---

Feature instances get their own jobs. A `jobs(...)` slice of `reports.instance('eu', …)` runs under instance-qualified names (`send-mail#eu`, scheduler id `schedule:<name>#eu`, outbox rows `send-mail#eu`); a plain feature's names do not change. New `jobProducers({ … })` and `outboxProducers({ … })` feature-private infra give usecases `deps.jobs.<job>.enqueue(data)` / `.runAfter(tx, args)` bound to the same name, so producer and worker cannot drift. Every feature's job now runs with `ctx.services`, the services of the feature that registered it (`FeatureJobContext`), and `QueueInstance.register(registry, { services })` takes them per top-level key.
