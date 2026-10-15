---
'@arki/queue': minor
---

Flows now run. `enqueue(flow, input)` on the `queue()` DOT client and on a `createQueue()` instance validates the input with the flow's schema (`QueueInputError`, `ARKI_QUEUE_E018`), then adds the whole flow through one lazily opened BullMQ `FlowProducer` (closed on stop) and returns `{ flow, jobIds }` by step id. Each step runs in its job's own queue with the job's retry defaults. Flows are BullMQ trees: a step in the `dependsOn` of two steps now throws `ARKI_QUEUE_E017` at `.build()`. Breaking: the step `queueName` option is removed (a step always runs in its job's queue; another queue had no worker), step `opts` are typed as `FlowStepOptions`, and `FlowDefinition` takes the input type (`FlowDefinition<TInput>`).
