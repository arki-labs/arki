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
pnpm add @arki/queue bullmq ioredis zod superjson
```

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
      .while(error => error instanceof NetworkError), // other errors fail at once
  });
```

Without `retry`, a job gets `backoff.exponential({ base: 1000 }).upTo(2)`: 3 tries, 1 s then 2 s apart. `backoff.constant(ms)` waits the same time before every retry, and `.upTo(0)` turns retries off. BullMQ's `attempts` is set to `upTo + 1`. BullMQ cannot store a function, so every job uses its custom backoff, and the job's worker asks the `Backoff` for each delay.

A handler may return a failure from [`@arki/failure`](../failure) for an expected outcome, such as a declined card. The job then fails at once, without a retry: running it again would repeat the outcome, or charge the card again. It runs again only when the job's `while` accepts that failure, as in `.while(reason => isFailure(reason) && reason.code === 'db.timeout')`. The job's `failedReason` is the failure as JSON (code, message, status, data), so the board and the foreman show why it failed. A thrown error retries as before. The `runtime-local` queue (pg-boss) does not apply `retry` yet, so there a returned failure still completes the job.

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

Let middleware handle errors, but throw specific errors when needed:

```typescript
.handler(async (data, ctx) => {
  // Validation errors (don't retry)
  if (!data.orderId) {
    throw new Error('VALIDATION_ERROR: orderId is required');
  }

  // Business logic errors (don't retry)
  const order = await ctx.db.orders.findById(data.orderId);
  if (order.status === 'cancelled') {
    throw new Error('BUSINESS_ERROR: Order is cancelled');
  }

  // Network/transient errors (will retry)
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
