# Using queues in a Dot app

Reference for `@arki/queue/dot`: `queue()`, `queueWorker()`, `jobs()`.

`@arki/queue/dot` splits the queue along the app hexagon. Features declare
their jobs with `jobs(...)`. The app mounts the client with `.infra()` and the
worker with `.entrypoints()`:

```ts skip="excerpt: it uses names this page does not define"
import type { QueueClient } from '@arki/queue/dot';
import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { service } from '@arki/dot/unit';
import { jobs, queue, queueWorker } from '@arki/queue/dot';

const orders = defineFeature('orders')
  .needs({ queue: queuePlugin.provides.queue }) // or service<QueueClient>() when the host plugin is out of reach
  .provides({ checkout: ({ queue }) => createCheckout(queue) }) // queue.enqueue(sendReceipt, { orderId })
  .entrypoints(jobs({ sendReceipt }));

// API process: enqueues only.
defineApp('shop-api')
  .infra(queue({ connection: env.REDIS_URL, keyPrefix: 'shop:' }))
  .features([orders]);

// Worker process: same features, plus the worker that runs their jobs.
defineApp('shop-worker')
  .infra(db({ relations }))
  .infra(queue({ connection: env.REDIS_URL, keyPrefix: 'shop:' }))
  .features([orders])
  .entrypoints(queueWorker({ q, needs: { db: Db }, context: ({ db }) => ({ db }) }));
```

- `queue({ connection, keyPrefix?, name? })` provides the `queue` service:
  `enqueue(job, data, options?)` returns the BullMQ job id, and
  `enqueue(flow, input)` starts a flow (see Flows). Boot opens no
  connection; each job's queue opens on its first `enqueue`, with the retry
  defaults the job declares, and one flow producer on the first flow. Use it where the job's own `trigger()` cannot
  work: `trigger()` needs a worker that registered the job in the same process.
- `queueWorker({ q, needs, context, blocking?, startupTimeoutMs?, name? })` is
  bound to the features the app mounted. It registers each feature's
  `jobs(...)` registry, reads the connection and key prefix from the `queue`
  client, and builds the job context once at start. It starts in the
  background unless `blocking: true`; a failed background start leaves the
  app running without workers.
- The manifest splits the same way: a feature's `jobs(...)` slice declares the
  producer actions (`<job>.produce`), and the worker declares the consumer
  actions (`<job>.consume`, `<schedule>.fire`). An API process never claims to
  consume a queue.
- A feature lists its `jobs(...)` in `.entrypoints(...)`, as the example shows.
  Job handlers still get the worker's `context`, not the feature's services — a
  job may run in a process where the feature never booted.
