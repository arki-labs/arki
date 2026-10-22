# Jobs, middleware and retries

Reference for defining jobs. The [README](../../README.md) has the quick start.

## Core Concepts

### Initialization: `initQueue`

Similar to tRPC's `initTRPC`, `initQueue` is the starting point:

```ts skip="excerpt: it uses names this page does not define"
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

```ts skip="excerpt: it uses names this page does not define"
// Base job with a shared step
const baseJob = q.job.use(step(() => ({ logger })));

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

```ts skip="excerpt: it uses names this page does not define"
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

The persisted refusal contains its public code, status, message, remediation, and data. Private causes stay in process. Foreman retains that envelope. A thrown handler or middleware error is reported as `UnexpectedDefect`, but the retry sees the thrown error: it follows the job's `Backoff` as in `@arki/resilience`, so `upTo(2)` runs it up to 3 times and `.while(...)` can narrow it. Bad stored input becomes `InvalidInput` or `ValidatorDefect` and stops. A returned failure stops by default. Provider outages and abandoned claims remain under provider supervision; a settled handler failure is never also thrown into that retry layer.

`timeoutMs` aborts `ctx.signal` and reports canonical `Deadline`; external worker cancellation reports `Cancelled`. Settlement waits for the handler and middleware to finish, so retry never overlaps owned work. Handlers must honor the signal; a handler that ignores cancellation can delay shutdown indefinitely. Use `timeoutMs` for timeouts: there is no timeout middleware.

`trigger()` and job `enqueue()` return a job id or `JobTriggerFailure`. Register `JOB_TRIGGER_FAILURES` at transport boundaries. `QueueUnavailable` means no transport is active. `QueueAcceptanceUnknown` means the acknowledgement was lost; inspect the stable idempotency key before trying again. Successful enqueue acknowledges delivery, not business success.

#### Upgrade existing workers

- Handle returned enqueue failures before using the job id. Keep expected refusals as returned definitions; a handler throw is retried by the job's `Backoff` like any thrown error, so return a failure (and select it with `.while(Definition)`) only for outcomes you want to name.
- Stop and drain runtime-local workers before upgrading. pg-boss messages now use `{ version: 1, input, trace? }`; export and re-enqueue pending legacy rows with their original idempotency keys. Legacy rows left in place fail input validation, rather than running with misread input.
- The pg-boss adapter is pinned to the 12.37 attempt-fenced `fail(name, {id,retryCount}, output, {db})` API and job schema. One PGlite transaction adjusts only the claimed attempt's retry policy, invokes native settlement, and sets the exact persisted due time. Native settlement still owns dependencies and dead-letter transitions. Re-run backend conformance before upgrading pg-boss.
- Delivery remains at least once after worker death. External effects must use `ctx.job.id` as their idempotency key. Queue Flow remains a BullMQ dependency tree; use Journal for durable business state and replay rules.

Every single-job enqueue creates a `queue.enqueue` producer span covering validation, ID generation, and provider acceptance, including unavailable transports. It records only the declared job name and canonical failure code. `queue.flow.enqueue` covers flow validation, tree mapping and atomic provider submission. Each step inherits that producer context unless its options explicitly supply telemetry. The active producer span propagates to BullMQ and pg-boss messages; explicitly supplied BullMQ telemetry options retain precedence.

Every worker execution creates a `queue.execute` OpenTelemetry span, restores bounded producer propagation metadata on BullMQ and pg-boss messages, and records canonical refusal codes. Configure the propagator, SDK, and exporter in the app. Handler code can add spans through `trace.getTracer(...)`; telemetry failures never change delivery outcomes.

### Middleware

Middleware can transform context and add cross-cutting concerns:

```ts skip="excerpt: it uses names this page does not define"
// Custom middleware that adds a user to context
const authMiddleware = q.middleware<AppContext & { user: User }>(async ({ ctx, data, next }) => {
  // Extract user ID from data
  const { userId } = userInput.parse(data); // userInput is a schema such as z.object({ userId: z.string() })

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

**Steps and arounds.** `.use(step(fn))` adds a plain function that reads the context and returns keys to add, or a failure to refuse the job.
`.use(around(fn))` wraps everything declared after it, the handler included. Both run in the order you write them.

- A refusal is the job's outcome, as if the handler had returned that failure. The handler does not run.
- Inside an around, a refusal (a later step's, or a failure the handler returns) is the value `next()` resolves to. A
  rollback checks `isFailure`. A thrown error rejects `next()`.
- Write an around's `next` as a plain parameter: `(ctx, next) => ...`.

The model is shared by every transport: [Steps and arounds](../../../dot/docs/middleware.md).

**Middleware wraps the handler.** The handler is the innermost `next()`: a
middleware's `await next()` resolves only after everything inside it, handler
included, has finished; it rejects with the handler's error; and its result
carries what the handler returned (`output`). So `try`/`finally` around
`next()` surrounds the whole run:

```ts skip="excerpt: it uses names this page does not define"
const timed = q.middleware(async ({ job, next }) => {
  const start = Date.now();
  try {
    const result = await next(); // the handler has finished here
    log.info('{job} returned', { job: job.name, output: result.output });
    return result;
  } finally {
    log.info('{job} took {ms}ms', { job: job.name, ms: Date.now() - start }); // runs after the handler, even when it throws
  }
});
```

With `.use(mw1).use(mw2)` the order is `mw1` before, `mw2` before, handler,
`mw2` after, `mw1` after. `next({ ctx })` replaces the context for what follows.

**There is no standard middleware.** Each old helper has a replacement:

| You wanted                             | Use                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| Timing and logging of every job        | `logHandlers()` observer from `@arki/dot` (see Handler events below)                   |
| Error reporting                        | `reportErrors({ report })` observer from `@arki/dot`                                   |
| A maximum run time                     | `.options({ timeoutMs })`                                                              |
| A logger or a performance tracker      | Your own step: `step(() => ({ logger }))` adds `logger` to the context                 |
| Input validation                       | `.input(schema)`; the queue parses the data before any middleware runs                 |

### Handler events

A job in a Dot feature (`jobs(...)`) reports to the app's lifecycle observers. Each run emits `starting`, then
`completed` or `failed`, with `transport: 'job'`, the feature's name and the job's name. A step that refuses, or a
Failure the handler returns, is `completed` with outcome `refused`. A throw is `failed` and is rethrown unchanged,
so retries behave as before. With no observer, nothing is added to the run. `queueWorker` and `outboxJobs`
share the same jobs, so both lanes emit.

## Advanced Patterns

### Extending Context with a Step

A step can extend the context type:

```ts skip="excerpt: it uses names this page does not define"
// A step adds logger to context
const jobWithLogger = q.job
  .use(step(() => ({ logger })))
  .name('my-job')
  .input(schema)
  .handler(async (data, ctx) => {
    // ctx.logger is available!
    ctx.logger.info('Starting job', { data });
    ctx.logger.warn('Something happened');
    ctx.logger.error('Error occurred', { error });

    return { success: true };
  });
```

### Custom Middleware Patterns

```ts skip="excerpt: it uses names this page does not define"
// Timing middleware with custom behavior
const customTimingMiddleware = q.middleware(async ({ ctx, next, job }) => {
  const start = Date.now();
  const result = await next();
  const duration = Date.now() - start;

  log.info('{job} took {ms}ms', { job: job.name, ms: duration });

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
  const { userId } = userInput.parse(data);
  const key = `rate-limit:${userId}`;
  const count = await ctx.kv.get(key);

  if (count && count > 100) {
    throw new Error('Rate limit exceeded');
  }

  await ctx.kv.set(key, (count || 0) + 1, 60); // 1 minute TTL

  return next();
});
```

## Best Practices

### 1. Context Organization

Define a clear context type with all dependencies:

```ts skip="excerpt: it uses names this page does not define"
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

```ts skip="excerpt: it uses names this page does not define"
// Base job for all jobs
const baseJob = q.job;

// Job that needs logging
const monitoredJob = baseJob.use(step(() => ({ logger })));

// Job that needs authentication
const authJob = monitoredJob.use(authMiddleware);

// Job that needs rate limiting
const rateLimitedJob = authJob.use(rateLimitMiddleware);
```

### 3. Job Naming

Use the pattern `featureName.jobType`. A job name is also its queue name. BullMQ refuses a queue name with a colon, and pg-boss (runtime-local) accepts only letters, digits, `_`, `-`, `.` and `/`. A name with another character throws `ARKI_QUEUE_E020` when the job is declared:

```ts skip="excerpt: it uses names this page does not define"
'notifications.send-email';
'users.onboarding';
'data.sync';
'reports.generate-daily';
```

### 4. Error Handling

Return defined failures for expected outcomes, and select transient failures explicitly:

```ts skip="excerpt: it uses names this page does not define"
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

```ts skip="excerpt: it uses names this page does not define"
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

```ts skip="excerpt: it uses names this page does not define"
const shutdown = async (signal: string) => {
  log.info('{signal} received, shutting down', { signal });
  await queue.stop();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```
