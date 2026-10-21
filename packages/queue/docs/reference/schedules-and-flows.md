# Schedules, durable schedules and flows

Reference for cron and interval schedules, the durable backend for `@arki/schedule`, and flows.

**A schedule triggers its job; it does not run it.** On each tick,
`.job(someJob).data(d)` adds `d` to `someJob`'s own queue (a BullMQ job
scheduler whose id is the schedule name), exactly like `someJob.trigger(d)`.
The job's own worker then runs it: input check, the job's own middleware,
retries and concurrency. The schedule has no queue, worker or middleware of
its own, and registering only the schedule also registers its job.

```ts skip="excerpt: it uses names this page does not define"
// Wrap an existing job (named `generate-report-schedule` by default)
const dailyReport = q.schedule.cron('0 9 * * *', { timezone: 'America/New_York' }).job(generateReport).data({
  reportType: 'daily',
});

// Name it; several schedules can trigger one job, each under its own name
const weeklyReport = q.schedule.weekly('monday', '09:00').name('weekly-report').job(generateReport).data({
  reportType: 'weekly',
});

// Inline handler with middleware: an anonymous job named after the schedule,
// whose middleware is the `.use()` chain
const hourlySync = q.schedule
  .interval(60 * 60 * 1000) // Every hour
  .use(structuredLoggingMiddleware())
  .name('data.hourly-sync')
  .input(z.object({ timestamp: z.string() }))
  .handler(async (data, ctx) => {
    ctx.logger.info('Running hourly sync');
    // Implementation
    return { synced: true };
  });
```

Middleware for a wrapped job belongs on the job (`q.job.use(mw)`):
`q.schedule.cron(...).use(mw).job(j)` is a compile error, and plain JS gets a
`QueueDefinitionError` (`ARKI_QUEUE_E012`). Two schedules with the same name
throw `ARKI_QUEUE_E013` at `register()`.

`start()` prunes schedules removed from code: on each registered job's queue
it removes `schedule:<name>` schedulers that no registered schedule owns, so a
renamed or deleted schedule stops ticking. Other scheduler keys on the queue
(your own repeat jobs) are never touched. The runtime-local queue does the same
for keyed pg-boss schedules on each job's queue.

`durableScheduler()` from `@arki/queue/dot` runs `@arki/schedule` schedules
declared with `durable: true` on BullMQ job schedulers. Mount it before the
schedule plugin:

```ts skip="excerpt: it uses names this page does not define"
import { durableScheduler } from '@arki/queue/dot';
import { DurableSchedules, schedule } from '@arki/schedule/dot';

defineApp('billing')
  .use(durableScheduler({ connection: env.REDIS_URL, keyPrefix: 'billing:' }))
  .use(schedule({ schedules: [nightly], durable: DurableSchedules }));
```

It provides the service under `DURABLE_SCHEDULES_KEY` (`'arki.schedule.durable'`).
Boot opens no connection. When the schedule plugin starts, each durable
schedule gets a queue named `schedule.<name>` with one job scheduler and one
worker (concurrency 1). Each tick runs once across replicas. The last 100
completed and 100 failed tick jobs are kept. For what happens to ticks missed
while no worker runs, see the `@arki/schedule` README.

A flow runs several jobs in a set order. It is a BullMQ flow, so it is a
**tree**: a step waits for the steps in its `dependsOn` (its children), and
each step can be in the `dependsOn` of **at most one** other step. A parent
step runs after all its children finished.

```ts skip="excerpt: it uses names this page does not define"
const orderFlow = q.flow
  .name('orders.process-flow')
  .input(z.object({ orderId: z.string() }))
  // validate and reserve run in parallel
  .step('validate', {
    job: validateJob,
    data: input => ({ orderId: input.orderId }),
  })
  .step('reserve', {
    job: reserveJob,
    data: input => ({ orderId: input.orderId }),
  })
  .step('payment', {
    job: paymentJob,
    data: input => ({ orderId: input.orderId }),
    dependsOn: ['validate', 'reserve'], // fan-in: waits for both
    opts: { priority: 2 }, // BullMQ options for this step, over the job's own defaults
  })
  .step('notify', {
    job: notifyJob,
    data: input => ({ orderId: input.orderId }),
    dependsOn: ['payment'],
  })
  .build();
```

Start a flow with `enqueue`, from the `queue()` DOT client or from a
`createQueue()` instance. The input type comes from the flow. The input is
checked against the flow's schema first; a bad input throws
`QueueInputError` (`ARKI_QUEUE_E018`) and nothing is added. All jobs of the
flow are added in one atomic call.

```ts skip="excerpt: it uses names this page does not define"
const { jobIds } = await ctx.queue.enqueue(orderFlow, { orderId: 'o-1' });
// jobIds: { validate: '…', reserve: '…', payment: '…', notify: '…' }
```

**Flow rules:**

- Each step runs in its own job's queue and worker, with that job's retry
  defaults and middleware. Register the step jobs in the worker (registering
  the flow registers them). There is no flow `.use()`: put middleware on the
  step jobs (`q.job.use(mw)`).
- Unknown step ids (`ARKI_QUEUE_E009`) and cycles (`ARKI_QUEUE_E010`) throw at
  `.build()`.
- Fan-out is not supported. A step that two steps depend on throws
  `ARKI_QUEUE_E017` at `.build()`: a BullMQ child job has exactly one parent.
  Chain the steps instead (`notify` depends on `inventory`, which depends on
  `payment`), or split them into two flows.
- Workflows where a step has several dependents (a general DAG) are not
  supported by BullMQ flows.

### Registry Organization

Organize jobs hierarchically by feature:

```ts skip="excerpt: it uses names this page does not define"
const jobs = q.registry({
  notifications: q.registry({
    email: sendEmail,
    sms: sendSMS,
  }),
  users: q.registry({
    onboarding: onboardUser,
    cleanup: cleanupInactiveUsers,
  }),
  data: q.registry({
    sync: syncData,
  }),
});

// Jobs are nested: jobs.notifications.email, jobs.users.onboarding, etc.
```

```ts skip="excerpt: it uses names this page does not define"
// ETL pipeline with parallel transformations
const etlFlow = q.flow
  .name('data.etl-pipeline')
  .input(z.object({ sourceId: z.string() }))
  // Extract step
  .step('extract', {
    job: extractJob,
    data: input => ({ sourceId: input.sourceId }),
  })
  // Three parallel transformations
  .step('transform-a', {
    job: transformAJob,
    data: () => ({ type: 'A' }),
    dependsOn: ['extract'],
  })
  .step('transform-b', {
    job: transformBJob,
    data: () => ({ type: 'B' }),
    dependsOn: ['extract'],
  })
  .step('transform-c', {
    job: transformCJob,
    data: () => ({ type: 'C' }),
    dependsOn: ['extract'],
  })
  // Load step waits for all transformations
  .step('load', {
    job: loadJob,
    data: () => ({}),
    dependsOn: ['transform-a', 'transform-b', 'transform-c'],
  })
  .build();
```
