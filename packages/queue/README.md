# @arki/queue v2.0

A type-safe background job processing library for TypeScript applications, inspired by tRPC's elegant API design. Built on BullMQ and Redis.

## ⚠️ Breaking Changes in v2.0

Version 2.0 is a complete architectural rewrite inspired by tRPC. The new API focuses on:

- **Builder Patterns**: tRPC-inspired `initQueue` and chainable builders
- **Middleware System**: Composable middleware for cross-cutting concerns
- **Type-Safe Context**: Full type safety through middleware chain
- **Registry Organization**: Hierarchical job organization by feature

**Migration Guide**: See [MIGRATION.md](./MIGRATION.md) for upgrading from v1.x

## Features

- **tRPC-Inspired API**: Familiar patterns if you use tRPC
- **Type-Safe**: End-to-end type safety with context transformation
- **Middleware System**: Composable middleware for logging, error handling, timing, etc.
- **Powerful Patterns**: Jobs, schedules (cron/interval), and distributed flows
- **Built on BullMQ**: Leverages the reliability of BullMQ and Redis
- **Context Management**: Inject dependencies and extend context through middleware

## Installation

```bash
pnpm add @arki/queue bullmq ioredis superjson
```

Job and flow input accepts any Standard Schema validator (Zod, Valibot, ArkType, or your own); the examples use Zod. Bad input returns `InvalidInput` from `@arki/failure`, with `data.issues`; a broken validator returns `ValidatorDefect`. The shared `executeJob` executor returns these canonical failures. BullMQ callbacks use an exception carrier only at the provider boundary; pg-boss settles through its native fenced API.

Entry points: `@arki/queue` (the core), `/types`, `/runtime-local`, `/dot`, `/projection`, `/foreman` and `/outbox`. `/outbox` needs `@arki/journal` and `drizzle-orm`, not `bullmq` or `ioredis`.

## Quick Start

```typescript
import { z } from '@arki/contracts';
import { backoff, errorHandlingMiddleware, initQueue, loggingMiddleware, timingMiddleware } from '@arki/queue';

// 1. Define your application context type
type AppContext = {
  db: Database;
  repo: Repositories;
  kv: KVStore;
};

const createContext = (): AppContext => ({
  db: database,
  repo: repositories,
  kv: kvStore,
});

// 2. Initialize queue with context
const q = initQueue.context<AppContext>().create({
  transformer: superjson, // Optional: for complex types
});

// 3. Create job builders with middleware
const baseJob = q.job.use(errorHandlingMiddleware()).use(timingMiddleware()).use(loggingMiddleware());

// 4. Define jobs using chainable API
const sendEmail = baseJob
  .name('notifications:send-email')
  .input(
    z.object({
      to: z.email(),
      subject: z.string(),
      body: z.string(),
    }),
  )
  .options({
    maxParallelism: 50,
    retry: backoff.exponential({ base: 1000 }).upTo(2), // 3 tries in all, 1 s then 2 s apart
  })
  .handler(async (data, ctx) => {
    // ctx has: db, repo, kv (from context)
    await ctx.repo.notifications.create({
      type: 'email',
      recipient: data.to,
      subject: data.subject,
      body: data.body,
    });

    return { sent: true, messageId: `msg_${Date.now()}` };
  });

// 5. Organize jobs with registries
const jobs = q.registry({
  notifications: q.registry({
    sendEmail,
  }),
});

// 6. Create queue instance
const queue = q.createQueue({
  connection: 'redis://localhost:6379',
  createContext,
});

// 7. Register and start
await queue.register(jobs);
await queue.start();
```

## Core Concepts

### Initialization: `initQueue`

Similar to tRPC's `initTRPC`, `initQueue` is the starting point:

```typescript
// With context type
const q = initQueue.context<AppContext>().create({
  transformer: superjson,
  errorFormatter: error => error,
  isDev: process.env.NODE_ENV === 'development',
});

// Without context (uses empty context)
const q = initQueue.create();
```

### Job Builders

Job builders are similar to tRPC procedures. They can be composed with middleware:

```typescript
// Base job with common middleware
const baseJob = q.job.use(errorHandlingMiddleware()).use(timingMiddleware()).use(loggingMiddleware());

// Extend with more middleware
const authenticatedJob = baseJob.use(authMiddleware);

// Define a job
const myJob = authenticatedJob
  .name('my-job-name')
  .input(inputSchema)
  .options({ maxParallelism: 10 })
  .handler(async (data, ctx) => {
    // Handler implementation
    return { success: true };
  });
```

#### Retries

A job's `retry` option is a `Backoff` from `@arki/resilience`, re-exported here as `backoff`. The same value drives resilience policies and `@arki/journal` effects.

```typescript
import { backoff } from '@arki/queue';

q.job
  .name('sync')
  .input(schema)
  .options({
    retry: backoff
      .exponential({ base: 1_000, max: 30_000 })
      .upTo(4) // 5 tries in all
      .while(DatabaseUnavailable), // select a failure definition explicitly
  });
```

Without `retry`, provider failures have a limit of three attempts. Returned business failures and canonical execution failures stop after the first attempt. `.while(DatabaseUnavailable)` explicitly selects a returned failure definition; `.while(predicate)` can select a precise subset. Both BullMQ and pg-boss use the same `Backoff.delay(attempt, failure)`, counts, and millisecond delay. Polling may make delivery later than its due time.

The persisted refusal contains its public code, status, message, remediation, and data. Private causes stay in process. Foreman retains that envelope. A thrown handler or middleware defect becomes `UnexpectedDefect`; bad stored input becomes `InvalidInput` or `ValidatorDefect`. These failures stop by default. Provider outages and abandoned claims remain under provider supervision; a settled handler failure is never also thrown into that retry layer.

`timeoutMs` aborts `ctx.signal` and reports canonical `Deadline`; external worker cancellation reports `Cancelled`. Settlement waits for the handler and middleware to finish, so retry never overlaps owned work. Handlers must honor the signal; a handler that ignores cancellation can delay shutdown indefinitely. The older timeout middleware also waits for settlement and clears its timer; prefer `timeoutMs` when work needs the abort signal.

`trigger()` and job `enqueue()` return a job id or `JobTriggerFailure`. Register `JOB_TRIGGER_FAILURES` at transport boundaries. `QueueUnavailable` means no transport is active. `QueueAcceptanceUnknown` means the acknowledgement was lost; inspect the stable idempotency key before trying again. Successful enqueue acknowledges delivery, not business success.

#### Upgrade existing workers

- Handle returned enqueue failures before using the job id. Keep expected refusals as returned definitions; replace transient handler throws with an explicit returned failure and `.while(Definition)`.
- Stop and drain runtime-local workers before upgrading. pg-boss messages now use `{ version: 1, input, trace? }`; export and re-enqueue pending legacy rows with their original idempotency keys. Legacy rows left in place fail input validation, rather than running with misread input.
- The pg-boss adapter is pinned to the 12.37 attempt-fenced `fail(name, {id,retryCount}, output, {db})` API and job schema. One PGlite transaction adjusts only the claimed attempt's retry policy, invokes native settlement, and sets the exact persisted due time. Native settlement still owns dependencies and dead-letter transitions. Re-run backend conformance before upgrading pg-boss.
- Delivery remains at least once after worker death. External effects must use `ctx.job.id` as their idempotency key. Queue Flow remains a BullMQ dependency tree; use Journal for durable business state and replay rules.

Every worker execution creates a `queue.execute` OpenTelemetry span, restores bounded producer propagation metadata on BullMQ and pg-boss messages, and records canonical refusal codes. Configure the propagator, SDK, and exporter in the app. Handler code can add spans through `trace.getTracer(...)`; telemetry failures never change delivery outcomes.

### Middleware

Middleware can transform context and add cross-cutting concerns:

```typescript
// Custom middleware that adds a user to context
const authMiddleware = q.middleware<AppContext & { user: User }>(async ({ ctx, data, next }) => {
  // Extract user ID from data
  const userId = (data as any).userId;

  if (!userId) {
    throw new Error('User ID is required');
  }

  // Fetch user
  const user = await ctx.db.users.findById(userId);

  if (!user) {
    throw new Error('User not found');
  }

  // Add user to context
  return next({
    ctx: {
      ...ctx,
      user,
    },
  });
});
```

**Middleware wraps the handler.** The handler is the innermost `next()`: a
middleware's `await next()` resolves only after everything inside it, handler
included, has finished; it rejects with the handler's error; and its result
carries what the handler returned (`output`). So `try`/`finally` around
`next()` surrounds the whole run:

```typescript
const timed = q.middleware(async ({ job, next }) => {
  const start = Date.now();
  try {
    const result = await next(); // the handler has finished here
    console.log(`[${job.name}] returned`, result.output);
    return result;
  } finally {
    console.log(`[${job.name}] took ${Date.now() - start}ms`); // runs after the handler, even when it throws
  }
});
```

With `.use(mw1).use(mw2)` the order is `mw1` before, `mw2` before, handler,
`mw2` after, `mw1` after. `next({ ctx })` replaces the context for what follows.

**Standard Middleware:**

- `errorHandlingMiddleware()` - Catches and formats errors
- `loggingMiddleware()` - Logs job execution
- `structuredLoggingMiddleware()` - Adds `logger` to context
- `timingMiddleware()` - Logs execution time
- `performanceMiddleware()` - Adds `performance` tracker to context
- `timeoutMiddleware({ timeout: 30000 })` - Enforces max execution time
- `validationMiddleware()` - Validates input (handled automatically)

### Schedules

**A schedule triggers its job; it does not run it.** On each tick,
`.job(someJob).data(d)` adds `d` to `someJob`'s own queue (a BullMQ job
scheduler whose id is the schedule name), exactly like `someJob.trigger(d)`.
The job's own worker then runs it: input check, the job's own middleware,
retries and concurrency. The schedule has no queue, worker or middleware of
its own, and registering only the schedule also registers its job.

```typescript
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
  .name('data:hourly-sync')
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

### DOT wiring: `queue()` and `queueWorker()`

`@arki/queue/dot` splits the queue along the app hexagon. Features declare
their jobs with `jobs(...)`. The app mounts the client with `.use()` and the
worker with `.serve()`:

```typescript
import type { QueueClient } from '@arki/queue/dot';
import { defineApp } from '@arki/dot';
import { feature } from '@arki/dot/feature';
import { service } from '@arki/dot/plugin';
import { jobs, queue, queueWorker } from '@arki/queue/dot';

const orders = feature('orders', {
  use: [jobs({ sendReceipt })],
  needs: { queue: queuePlugin.provides.queue }, // or service<QueueClient>() when the host plugin is out of reach
  provides: { checkout: ({ queue }) => createCheckout(queue) }, // queue.enqueue(sendReceipt, { orderId })
});

// API process: enqueues only.
defineApp('shop-api')
  .use(queue({ connection: env.REDIS_URL, keyPrefix: 'shop:' }))
  .features([orders]);

// Worker process: same features, plus the worker that runs their jobs.
defineApp('shop-worker')
  .use(db({ relations }))
  .use(queue({ connection: env.REDIS_URL, keyPrefix: 'shop:' }))
  .features([orders])
  .serve(queueWorker({ q, needs: { db: Db }, context: ({ db }) => ({ db }) }));
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
- A `defineFeature` feature lists the same `jobs(...)` in its
  `.entrypoints(...)`: `defineFeature('orders')….entrypoints(jobs({ sendReceipt }))`.
  The worker reads chain and object-form features side by side. Job handlers
  still get the worker's `context`, not the feature's services — a job may run
  in a process where the feature never booted.

### Transactional scheduling: `@arki/queue/outbox`

`trigger()` and `enqueue()` talk to Redis, outside your database transaction. If the transaction rolls back, the job still runs. If Redis is down after the commit, the job is lost. `@arki/queue/outbox` writes the job as a row in the `@arki/journal` jobs table, in your transaction. The row exists if and only if your write commits. The journal worker runs it. It needs no Redis, and it imports no BullMQ or pg-boss at runtime.

```typescript
import { listenOnPool } from '@arki/db/pg';
import { outbox, outboxRunner } from '@arki/queue/outbox';

export const schedule = outbox({ tables }); // tables from journalTables()

export const startRun = (db: AppDb, input: StartInput) =>
  db.transaction(async tx => {
    const run = await runs.withTx(tx).create({ status: 'pending' });
    await schedule.runAfter(tx, discoveryJobs.runDiscovery, { runId: run.id }, { key: `discovery:${run.id}` });
    return run;
  });

// The journal worker the app already runs, plus one option.
const worker = journal.worker(db, {
  listen: listenOnPool(listenPool, journal.wakeChannel),
  jobs: outboxRunner({ registry: discoveryJobs, context: () => ({ db }) }),
});
```

A wrong field in `args` is a compile error. Passing the root `db` instead of `tx` is a compile error and a runtime error (`OUTBOX_E001`). The API is `runAfter(tx, job, args, { delayMs, key, priority })`, `runAt(tx, job, args, date, { key, priority })` and `cancel(db, id)`.

The three ways to start a job:

|                                    | `trigger()`   | `enqueue()` (`queue()` client) | `schedule.runAfter(tx, ...)`        |
| ---------------------------------- | ------------- | ------------------------------ | ----------------------------------- |
| Stored in                          | Redis         | Redis                          | your database, in your transaction  |
| Rolls back with your write         | no            | no                             | yes                                 |
| Needs a worker in the same process | yes           | no                             | no                                  |
| Needs Redis                        | yes           | yes                            | no                                  |
| Runs on                            | `queueWorker` | `queueWorker`                  | `journalWorker` or `journal.worker` |

- **Atomic enqueue is not request idempotency.** The row is written once per awaited call in the committed transaction. Two HTTP retries that both commit schedule twice. Pass `key` to dedupe among unfinished rows of the same job, like `jobId`. Or cover the whole operation with a journal receipt.
- **At-least-once.** The row stays until the worker acknowledges it. A crash between the handler and the ack runs the job again. Pass `ctx.job.id` to external systems as the idempotency key. It is the row id (`job_xxx`) and stays the same across retries. A handler that returns an `@arki/failure` failure fails the job, as on the BullMQ lane. Retry uses the job's own `.options({ retry })` backoff (3 tries by default). Bad stored args go dead at once, without running the handler.
- **The delay starts with the transaction.** The job is due at the transaction's `now()` plus `delayMs`. A long transaction uses part of the delay. A job can also run late: by up to `pollMs` without a listener, or under load.
- **Plain JSON args and pure schemas.** Args are stored as JSON. Use strings, finite numbers, booleans, null, arrays and plain objects. A `Date`, `Map`, `bigint` or class instance throws `OUTBOX_E003`. The job's input schema must give the same result on the stored value: avoid transforms that need a live object. Args over `maxArgsBytes` (256 KiB by default) are refused.
- **Priority has no order promise.** `priority` uses the same scale as `trigger`: `QUEUE_PRIORITIES`, 1 (critical) to 10 (background), default 5. The row stores `5 - priority`, and the worker claims the higher stored value first. Among equal priorities, the oldest due row goes first. `SKIP LOCKED` is not FIFO. A steady stream of high priority rows can starve low ones.
- **Dead and stranded jobs.** When the retry policy stops, the row is dead. List it with `journal.jobs(db, { status: 'dead' })`. `journal.retry(db, id, { actor })` requeues it with the same id. `op` (`{ actor, reason?, executionId? }`) is required on every journal verb; see the `@arki/journal` README. A worker claims only the job names its runner knows. If you rename a job, its old rows are stranded: `journal.strandedJobs(db, { jobs })` lists them. Put a version in the name (`mail.welcome.v1`) so a rename is a new job on purpose.
- **Retention.** A job can say how long the journal keeps its finished and dead rows: `.options({ retention: { completed: '1d', dead: '30d' } })`. It takes `completed`, `dead` and `retryableFor`, with the same forms as an effect's retention in `@arki/journal` (`false`, `'forever'`, `'untilExported'`, an age like `'7d'`, or `{ age, max }`). It overrides the journal's policy for this job name. Only the outbox lane reads it; the BullMQ lane ignores it.
- **Foreman.** `queueForemanModule` from `@arki/queue/foreman` raises its errors through `moduleError` from `@arki/admin/module`. A stale approval and a job that is no longer failed answer 409 (they were 500), and an unknown queue answers 404. The codes are `ARKI_QUEUE_E014`, `E015` and `E016` in `QUEUE_FOREMAN_ERROR_CODES`. `QueueForemanError` is removed: match on the code of the `ModuleError`, with `isModuleError`. `redactSecrets` is owned by `@arki/admin/module`; `@arki/queue/foreman` still re-exports it.
- **Handler differences.** `ctx.job` is the structural `JobLike` on every lane (`id`, `name`, `data`, `attemptsMade`, `updateProgress`, `log`). On the outbox lane `log` and `updateProgress` go to debug output (logger `arki:queue:outbox`). Queue handlers get no cancellation signal in this version. A lost lease is covered by at-least-once.
- **Errors.** `OUTBOX_E001` to `OUTBOX_E007`: not in a transaction, bad args, not JSON, bad timing or priority, bad stored args, unknown job, duplicate name. Each has a `.remediation`. Test with `isOutboxError(e)`.
- **Dot wiring.** `outboxPlugin({ tables })` (from `@arki/queue/dot`) provides the `schedule` service. Mount it with `.infra(...)` (or `.use(...)`) in every process that schedules. The worker process lists the features and serves the journal worker with `outboxJobs`. The same `jobs(...)` slice feeds this lane and `queueWorker`.

```typescript
import { jobs, outboxJobs, outboxPlugin } from '@arki/queue/dot';

const signup = defineFeature('signup')
  .needs({ db: database.provides.db, schedule: scheduling.provides.schedule })
  .usecases({})
  .provides({
    signups: ({ db, schedule }) => ({
      register: (userId: string) => db.transaction(tx => schedule.runAfter(tx, welcome, { userId })),
    }),
  })
  .entrypoints(jobs(q.registry({ welcome })));

defineApp('signup-worker')
  .infra(database, scheduling, journal({ j, tables }))
  .features([signup])
  .entrypoints(
    journalWorker({
      listen: onMessage => client.listen(journal.wakeChannel, onMessage), // PGlite; with pg, listenOnPool from @arki/db/pg
      jobs: outboxJobs({ needs: {}, context: ({ db }) => ({ db }) }),
    }),
  );
```

The worker manifest lists `<job>.consume` under the plugin `journal-worker`.

- **No entities needed.** The outbox needs the journal tables and a journal worker, not entities or effects. Compose a journal with only `tables`, run `journal.worker(db, { jobs: outboxRunner(...) })`, and add the migration from the `@arki/journal` README (Tables) to your app.
- **Private package.** `@arki/queue` is private. The typed API is private too. Public `@arki/journal` users get only the `JobRunner` port.

### Durable backend for `@arki/schedule`

`durableScheduler()` from `@arki/queue/dot` runs `@arki/schedule` schedules
declared with `durable: true` on BullMQ job schedulers. Mount it before the
schedule plugin:

```typescript
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

### Flows (Multi-Step Workflows)

A flow runs several jobs in a set order. It is a BullMQ flow, so it is a
**tree**: a step waits for the steps in its `dependsOn` (its children), and
each step can be in the `dependsOn` of **at most one** other step. A parent
step runs after all its children finished.

```typescript
const orderFlow = q.flow
  .name('orders:process-flow')
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

```typescript
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

```typescript
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

## Advanced Patterns

### Extending Context with Middleware

Middleware can extend the context type:

```typescript
// Structured logging middleware adds logger to context
const jobWithLogger = q.job
  .use(structuredLoggingMiddleware())
  .name('my-job')
  .input(schema)
  .handler(async (data, ctx) => {
    // ctx.logger is available!
    ctx.logger.info('Starting job', { data });
    ctx.logger.warn('Something happened');
    ctx.logger.error('Error occurred', { error });

    return { success: true };
  });

// Performance middleware adds performance tracker
const jobWithPerformance = q.job
  .use(performanceMiddleware())
  .name('my-job')
  .input(schema)
  .handler(async (data, ctx) => {
    const mark = ctx.performance.mark('database-query');
    await ctx.db.query(...);
    ctx.performance.measure('database-query', mark);

    return { success: true };
  });
```

### Custom Middleware Patterns

```typescript
// Timing middleware with custom behavior
const customTimingMiddleware = q.middleware(async ({ ctx, next, job }) => {
  const start = Date.now();
  const result = await next();
  const duration = Date.now() - start;

  console.log(`[${job.name}] took ${duration}ms`);

  // Store timing in database
  await ctx.db.metrics.create({
    job: job.name,
    duration,
    timestamp: new Date(),
  });

  return result;
});

// Rate limiting middleware
const rateLimitMiddleware = q.middleware(async ({ ctx, data, next }) => {
  const key = `rate-limit:${(data as any).userId}`;
  const count = await ctx.kv.get(key);

  if (count && count > 100) {
    throw new Error('Rate limit exceeded');
  }

  await ctx.kv.set(key, (count || 0) + 1, 60); // 1 minute TTL

  return next();
});
```

### Complex Flow Example

```typescript
// ETL pipeline with parallel transformations
const etlFlow = q.flow
  .name('data:etl-pipeline')
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

## Queue Instance

The queue instance manages job registration and execution:

```typescript
const queue = q.createQueue({
  connection: 'redis://localhost:6379',
  keyPrefix: 'myapp:',
  createContext,
});

// Register jobs, schedules, and flows
await queue.register(jobs);

// Start all workers
await queue.start();

// Graceful shutdown
await queue.stop();
```

**Registry traversal:**
The `register` method automatically traverses nested registries and registers:

- Jobs (immediate execution)
- Schedules (cron/interval)
- Flows (registers all jobs in the flow)

## Best Practices

### 1. Context Organization

Define a clear context type with all dependencies:

```typescript
type AppContext = {
  // Database
  db: Database;

  // Repositories
  repo: {
    users: UserRepository;
    notifications: NotificationRepository;
  };

  // Services
  email: EmailService;
  storage: StorageService;

  // Infrastructure
  kv: KVStore;
};
```

### 2. Middleware Composition

Build reusable job builders with common middleware:

```typescript
// Base job for all jobs
const baseJob = q.job.use(errorHandlingMiddleware()).use(timingMiddleware());

// Job that needs logging
const monitoredJob = baseJob.use(structuredLoggingMiddleware());

// Job that needs authentication
const authJob = monitoredJob.use(authMiddleware);

// Job that needs rate limiting
const rateLimitedJob = authJob.use(rateLimitMiddleware);
```

### 3. Job Naming

Use the pattern `featureName:jobType`:

```typescript
'notifications:send-email';
'users:onboarding';
'data:sync';
'reports:generate-daily';
```

### 4. Error Handling

Return defined failures for expected outcomes, and select transient failures explicitly:

```typescript
.handler(async (data, ctx) => {
  // Validation errors (don't retry)
  if (!data.orderId) {
    return OrderInvalid();
  }

  // Business logic errors (don't retry)
  const order = await ctx.db.orders.findById(data.orderId);
  if (order.status === 'cancelled') {
    return OrderCancelled({ orderId: data.orderId });
  }

  // The adapter returns its declared transient failure; the job retries only with .while(Definition).
  await externalAPI.call(data);

  return { success: true };
})
```

### 5. Testing

Test job handlers independently:

```typescript
import { describe, expect, it, vi } from 'vitest';

describe('sendEmail job', () => {
  it('should send email successfully', async () => {
    const mockCtx = {
      db: mockDatabase,
      repo: mockRepositories,
      kv: mockKVStore,
    } as AppContext;

    const result = await sendEmail._internal.handler(
      {
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test body',
      },
      mockCtx,
    );

    expect(result.sent).toBe(true);
  });
});
```

### 6. Graceful Shutdown

Always handle shutdown properly:

```typescript
const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down...`);
  await queue.stop();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

## API Reference

### `initQueue`

Entry point for creating a queue builder.

```typescript
// With context
initQueue.context<TContext>().create(config?)

// Without context
initQueue.create(config?)
```

### `QueueBuilder`

```typescript
interface QueueBuilder<TContext> {
  job: JobBuilderDef<TContext, TContext>;
  middleware<TContextOut>(fn): JobMiddleware<...>;
  registry<TRegistry>(jobs): TRegistry;
  schedule: ScheduleBuilderFactory<TContext>;
  flow: FlowBuilderFactory<TContext>;
  createQueue(options): QueueInstance<TContext>;
}
```

### `JobBuilderDef`

Chainable builder for creating jobs:

```typescript
q.job
  .use(middleware)              // Add middleware
  .name(string)                 // Set name
  .input(schema)                // Set input schema
  .options(options)             // Set job options
  .handler((data, ctx) => ...)  // Set handler (completes builder)
```

### `ScheduleBuilderFactory`

Create scheduled jobs:

```typescript
q.schedule
  .cron(pattern, options?)           // Cron-based
  .interval(milliseconds)            // Interval-based
  .name(name)                        // Optional for .job(), required for an inline handler
  .job(existingJob).data(data)       // Trigger an existing job (no .use() here)
  // OR
  .use(middleware)                   // Inline handler middleware
  .name(name).input(schema).handler(...) // Inline handler
```

### `FlowBuilderFactory`

Create multi-step workflows:

```typescript
q.flow
  .name(name)
  .input(schema)
  .step(id, {
    job,
    data: (input) => ...,
    dependsOn?: string[], // each step id in at most one other step's dependsOn
    opts?: FlowStepOptions, // BullMQ job options for this step
  })
  .build() // FlowDefinition<TInput>; start it with enqueue(flow, input)
```

## Migration from v1.x

See [MIGRATION.md](./MIGRATION.md) for detailed migration guide.

**Quick comparison:**

```typescript
// v1.x
const job = defineJob({
  name: 'my-job',
  inputSchema: schema,
  handler: async (data, ctx) => { ... },
});

// v2.0
const job = q.job
  .name('my-job')
  .input(schema)
  .handler(async (data, ctx) => { ... });
```

## Examples

See the [examples](./examples/) directory for complete examples:

- [basic-usage.ts](./examples/basic-usage.ts) - Comprehensive example of all features

## License

MIT

Middleware refusals must be returned directly. `next().output` is observational and readonly; returning a protocol object with substituted output now fails with `UnexpectedDefect` instead of silently dropping the substitution. A middleware may call `next()` once.

Runtime-local accepts arbitrary stable string `jobId` keys. Triggers generate a UUID key when none is supplied; the returned key can be reused as `jobId` to suppress duplicate delivery, including after restart, while the provider retains the job. pg-boss stores a deterministic UUID v5 identity scoped by queue name and key, while the message retains the original key for handler context and trigger results. Configure `pgBossFailedJobSource({ pglite, name: jobName })` to inspect/retry by that queue's external keys; an unscoped source keeps native UUID identifiers and includes the external `key` field for inspection.
