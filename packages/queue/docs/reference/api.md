# Builder API and job identity

The builder surface in one place, then how job keys work.

### `initQueue`

Entry point for creating a queue builder.

```ts skip="excerpt: it uses names this page does not define"
// With context
initQueue.context<TContext>().create(config?)

// Without context
initQueue.create(config?)
```

### `QueueBuilder`

```ts skip="excerpt: it uses names this page does not define"
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

```ts skip="excerpt: it uses names this page does not define"
q.job
  .use(middleware)              // Add middleware, a step(fn) or an around(fn)
  .name(string)                 // Set name
  .input(schema)                // Set input schema
  .options(options)             // Set job options
  .handler((data, ctx) => ...)  // Set handler (completes builder)
```

### `ScheduleBuilderFactory`

Create scheduled jobs:

```ts skip="excerpt: it uses names this page does not define"
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

```ts skip="excerpt: it uses names this page does not define"
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

Middleware refusals must be returned directly. `next().output` is observational and readonly; returning a protocol object with substituted output now fails with `UnexpectedDefect` instead of silently dropping the substitution. A middleware may call `next()` once.

Runtime-local accepts arbitrary stable string `jobId` keys. Triggers generate a UUID key when none is supplied; the returned key can be reused as `jobId` to suppress duplicate delivery, including after restart, while the provider retains the job. pg-boss stores a deterministic UUID v5 identity scoped by queue name and key, while the message retains the original key for handler context and trigger results. Configure `pgBossFailedJobSource({ pglite, name: jobName })` to inspect/retry by that queue's external keys; an unscoped source keeps native UUID identifiers and includes the external `key` field for inspection.

## Job identity upgrade

Single-job enqueue now returns `QueueJobId | JobTriggerFailure`. Restore persisted keys with
`queueJobId.schema.parse(key)` from `@arki/queue`; arbitrary existing string keys keep their bytes.
Automatic keys remain UUID v4. Explicit `jobId` keys bypass secure randomness; BullMQ's nested
`bullmqOptions.jobId` takes precedence. pg-boss still maps the external key to its deterministic UUID v5.

Handle `RandomSourceUnavailable` and `UnexpectedDefect` before retrying: these failures happen before
submission. `QueueAcceptanceUnknown` still means a provider acknowledgement could not be confirmed;
inspect the existing key before replaying. Native worker IDs and flow IDs retain their existing types.

Flow enqueue returns `QueueAcceptanceUnknown` if its acknowledgement lacks any submitted node or
nonempty job ID, contains extra nodes, or names a different job/queue. Accessor defects after
submission return the same uncertainty. It never resubmits automatically: reconcile accepted jobs
before retrying application effects. Confirmed IDs retain their provider bytes and every step key.
