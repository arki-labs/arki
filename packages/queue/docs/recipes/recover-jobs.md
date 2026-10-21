# Recover jobs after a worker dies

A worker claims a job, then the process is killed. The job is not lost. Each lane takes the job back after a set time and runs it again. This page shows what happens and how to see it.

## What recovers the job

| Lane                          | The worker holds                  | The job comes back after                                                        | Setting                                                                |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| BullMQ (`q.createQueue`)      | a lock in Redis, renewed          | the lock runs out and a stalled check finds it: about 30 to 60 seconds          | `workerOptions: { lockDuration, stalledInterval, maxStalledCount }`    |
| pg-boss (`runtime-local`)     | an active claim                   | the claim is older than `expireInSeconds` and a supervise pass runs             | `runtimeLocalOptions: { expireInSeconds }`, `superviseIntervalSeconds` |
| Outbox (`@arki/queue/outbox`) | a lease on the `journal_jobs` row | the lease (60 seconds by default) runs out and another journal worker claims it | `leaseSeconds` on the journal worker                                   |

After recovery the handler runs again from the start. Its `ctx.job.attemptsMade` is one higher. The first run may have done part of the work, so every external effect must use `ctx.job.id` as its idempotency key.

## Limits that matter

- BullMQ recovers a stalled job `maxStalledCount` times (default 1). The next stall moves the job to `failed` with "job stalled more than allowable limit". Retry it from Foreman or with `job.retry()`.
- pg-boss counts a recovered claim as a retry. When the retries are used up, the job is `failed`.
- A handler that throws is retried by the job's `Backoff`, like a stalled claim. A handler that returns a failure is not, unless `.while(...)` selects it. To make a throw final, set `retry: backoff.constant(0).upTo(0)`.
- A job with no `expireInSeconds` waits 15 minutes before pg-boss treats its worker as dead. Set it a little above your slowest handler.
- A handler that ignores `ctx.signal` keeps running after its claim expired. Another worker may run the same job at the same time. This is why the idempotency key is a rule and not advice.

## See it

The example below runs on `runtime-local` with an in-memory database. The first claim never settles, like a worker killed in the middle of the job. The queue sees the claim expire after 1 second and runs the job again.

```ts from="examples/recover-jobs.ts#recover"
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';

import { orThrow } from '@arki/failure';
import { createRuntimeLocalQueueInstance, initQueue } from '@arki/queue/runtime-local';

const q = initQueue.context<Record<string, never>>().create();
const finished = Promise.withResolvers<void>();

const ship = q.job
  .name('orders.ship')
  .input(z.object({ orderId: z.string() }))
  // A claim that is not settled within 1 second means the worker is dead.
  .options({ runtimeLocalOptions: { expireInSeconds: 1 } })
  .handler(async (data, ctx) => {
    const attempt = ctx.job.attemptsMade + 1;
    console.log(`claimed ${data.orderId}, attempt ${attempt}`);
    // The first claim never settles, like a worker killed in the middle of the job.
    if (attempt === 1) await new Promise<never>(() => {});
    console.log(`shipped ${data.orderId}`);
    finished.resolve();
    return { shipped: true };
  });

const queue = createRuntimeLocalQueueInstance({
  pglite: new PGlite(),
  createContext: () => ({}),
  // Look for dead claims every second. The default is every 60 seconds.
  superviseIntervalSeconds: 1,
  maintenanceIntervalSeconds: 1,
  monitorIntervalSeconds: 1,
});
await queue.register({ ship });
await queue.start();
orThrow(await ship.trigger({ orderId: 'ord_1' }));
await finished.promise;
// The first handler never settles, so a graceful stop would wait for it. Exit instead.
process.exit(0);
```

Run it from `packages/queue`:

```sh
bun examples/recover-jobs.ts
```

Expected output, after about 5 seconds:

```text
claimed ord_1, attempt 1
claimed ord_1, attempt 2
shipped ord_1
```
