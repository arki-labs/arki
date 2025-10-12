# @arki/queue

A declarative, type-safe background job processing library for TypeScript applications built on top of BullMQ and Redis.

## Features

- **Declarative API**: Define jobs, schedules, and distributed flows with a simple, declarative API inspired by `@content-collections/core`
- **Type-Safe**: Full TypeScript support with automatic type inference
- **Powerful Patterns**: Supports on-demand jobs, scheduled jobs (cron/interval), and distributed flows
- **Built on BullMQ**: Leverages the reliability and features of BullMQ
- **Runtime Schedule Management**: Register, list, and delete schedules at runtime (inspired by Convex)
- **Retry & Backoff**: Configurable retry strategies with exponential or fixed backoff
- **Distributed Flows**: Complex multi-job workflows with parent-child dependencies using BullMQ's FlowProducer
- **Callbacks**: OnComplete and onError hooks for job lifecycle events

## Installation

```bash
pnpm add @arki/queue bullmq ioredis zod
```

## Quick Start

```typescript
import { z } from 'zod';

import { createQueue, defineFlow, defineJob, defineSchedule } from '@arki/queue';

// 1. Define jobs for the flow
export const validateOrder = defineJob({
  name: 'orders:validate',
  schema: z.object({ orderId: z.string() }),
  handler: async (data, ctx) => {
    const order = await db.orders.findById(data.orderId);
    if (!order) throw new Error('Order not found');
    return { valid: true, order };
  },
});

export const processPayment = defineJob({
  name: 'orders:payment',
  schema: z.object({ orderId: z.string() }),
  handler: async (data, ctx) => {
    const result = await paymentService.charge(data);
    return { paymentId: result.id };
  },
});

export const updateInventory = defineJob({
  name: 'orders:inventory',
  schema: z.object({ orderId: z.string() }),
  handler: async (data, ctx) => {
    await inventoryService.reserve(data.orderId);
    return { reserved: true };
  },
});

export const sendOrderConfirmation = defineJob({
  name: 'orders:notify',
  schema: z.object({ orderId: z.string() }),
  handler: async (data, ctx) => {
    await emailService.sendOrderConfirmation(data);
    return { sent: true };
  },
});

// 2. Define a schedule
export const dailyCleanup = defineSchedule({
  name: 'maintenance:daily-cleanup',
  schedule: {
    type: 'cron',
    pattern: '0 2 * * *', // Every day at 2 AM
  },
  schema: z.object({}),
  handler: async (data, ctx) => {
    await cleanupOldData();
    return { cleaned: true };
  },
});

// 3. Define a flow
export const processOrderFlow = defineFlow({
  name: 'orders:process-flow',
  schema: z.object({
    orderId: z.string(),
  }),
  flow: input => [
    {
      id: 'validate',
      job: validateOrder,
      data: { orderId: input.orderId },
    },
    {
      id: 'payment',
      job: processPayment,
      data: { orderId: input.orderId },
      dependsOn: ['validate'],
    },
    {
      id: 'inventory',
      job: updateInventory,
      data: { orderId: input.orderId },
      dependsOn: ['payment'],
    },
    {
      id: 'notify',
      job: sendOrderConfirmation,
      data: { orderId: input.orderId },
      dependsOn: ['payment'],
    },
  ],
});

// 4. Create queue and register definitions
const queue = createQueue({
  connection: process.env.REDIS_URL!,
  keyPrefix: 'myapp:',
});

queue.registerSchedule(dailyCleanup);
queue.registerFlow(processOrderFlow);

// 5. Start processing
await queue.start();
```

## Core Concepts

### Jobs

Jobs are on-demand units of work that can be enqueued and processed asynchronously.

```typescript
export const sendEmail = defineJob({
  name: 'notifications:send-email',
  schema: z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string(),
  }),
  handler: async (data, ctx) => {
    // Process the job
    await ctx.log('Sending email...');
    await ctx.updateProgress(50);
    await emailService.send(data);
    await ctx.updateProgress(100);
    return { sent: true, messageId: '123' };
  },
  options: {
    maxParallelism: 50, // Process up to 50 emails concurrently
    retry: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000, base: 2 },
    },
    onComplete: async (job, result) => {
      await logEmailSent(job.data.to, result.messageId);
    },
    onError: async (job, error) => {
      await alertEmailFailed(job.data.to, error);
    },
  },
});
```

### Programmatic Job API

Use `createJobApi` for a type-safe API to manage jobs:

```typescript
import { createJobApi } from '@arki/queue';

// Create API for the job definition
const emailApi = createJobApi(sendEmail);

// Add a job to the queue
const job = await emailApi.add(
  'welcome-email',
  {
    to: 'user@example.com',
    subject: 'Welcome!',
    body: 'Thanks for signing up.',
  },
  {
    priority: 3,
    delay: 5000, // Delay 5 seconds
  },
);

// Get job status
const jobInfo = await emailApi.getJob(job.id!);
console.log(jobInfo?.state); // 'waiting', 'active', 'completed', 'failed'

// Get all failed jobs
const failedJobs = await emailApi.getJobs('failed', { start: 0, end: 10 });

// Retry a failed job
await emailApi.retry(job.id!);

// Remove a job
await emailApi.remove(job.id!);

// Get queue statistics
const stats = await emailApi.getStats();
console.log(stats);
// {
//   name: 'notifications:send-email',
//   waiting: 5,
//   active: 2,
//   completed: 100,
//   failed: 3,
//   delayed: 0,
//   paused: false
// }

// Pause the queue
await emailApi.pause();

// Resume the queue
await emailApi.resume();

// Clean old completed jobs (older than 1 hour)
await emailApi.clean(3600000, 100, 'completed');

// Access underlying BullMQ queue for advanced operations
const queue = emailApi.getQueue();
```

### Schedules

Schedules are jobs that run on a recurring basis, either on a cron schedule or at fixed intervals.

#### Cron-based Schedule

```typescript
export const dailyReport = defineSchedule({
  name: 'reports:daily',
  schedule: {
    type: 'cron',
    pattern: '0 9 * * *', // Every day at 9 AM
    timezone: 'America/New_York',
  },
  schema: z.object({
    reportType: z.string().default('daily'),
  }),
  handler: async (data, ctx) => {
    await generateReport(data.reportType);
    return { generated: true };
  },
});
```

#### Interval-based Schedule

```typescript
export const healthCheck = defineSchedule({
  name: 'system:health-check',
  schedule: {
    type: 'interval',
    milliseconds: 60000, // Every minute
  },
  schema: z.object({}),
  handler: async (data, ctx) => {
    const health = await checkSystemHealth();
    return { healthy: health.allSystemsGo };
  },
});
```

### Flows (Distributed Workflows)

For complex distributed workflows with parent-child job dependencies, use `defineFlow`. Flows leverage BullMQ's `FlowProducer` to create job graphs where each node can:

- Retry independently
- Run on different workers/queues
- Be monitored separately in Bull Board
- Have its own priority and options

**When to use Flows:**

- Complex job dependencies (parent-child relationships)
- Steps need independent retry logic
- Steps should be distributed across different workers/queues
- Better observability per step
- Multi-step processes with sophisticated orchestration needs

```typescript
import { z } from 'zod';

// Use the flow API to add flows
import { createFlowApi, defineFlow, defineJob } from '@arki/queue';

// Define individual jobs that will be used in the flow
const validateOrder = defineJob({
  name: 'orders:validate',
  schema: z.object({ orderId: z.string() }),
  handler: async (data, ctx) => {
    const order = await db.orders.findById(data.orderId);
    if (!order) throw new Error('Order not found');
    return { valid: true, order };
  },
  options: {
    retry: { attempts: 3, backoff: { type: 'fixed', delay: 1000 } },
  },
});

const processPayment = defineJob({
  name: 'orders:payment',
  schema: z.object({ orderId: z.string(), amount: z.number() }),
  handler: async (data, ctx) => {
    const result = await paymentService.charge(data);
    return { paymentId: result.id, charged: true };
  },
  options: {
    retry: { attempts: 5, backoff: { type: 'exponential', delay: 2000 } },
  },
});

const updateInventory = defineJob({
  name: 'orders:inventory',
  schema: z.object({ orderId: z.string() }),
  handler: async (data, ctx) => {
    await inventoryService.reserve(data.orderId);
    return { reserved: true };
  },
});

const sendNotification = defineJob({
  name: 'orders:notify',
  schema: z.object({ orderId: z.string(), message: z.string() }),
  handler: async (data, ctx) => {
    await emailService.send(data);
    return { sent: true };
  },
});

// Define the flow with a flat array of steps and dependencies
export const orderFlow = defineFlow({
  name: 'orders:process-flow',
  schema: z.object({
    orderId: z.string(),
    customerId: z.string(),
    amount: z.number(),
  }),
  // Define the flow as a flat array with dependencies
  // Reference job definitions directly
  flow: input => [
    {
      id: 'validate',
      job: validateOrder, // Direct reference to job definition
      data: { orderId: input.orderId },
    },
    {
      id: 'payment',
      job: processPayment,
      data: { orderId: input.orderId, amount: input.amount },
      dependsOn: ['validate'], // Wait for validation
    },
    {
      id: 'inventory',
      job: updateInventory,
      data: { orderId: input.orderId },
      dependsOn: ['payment'], // Wait for payment
    },
    {
      id: 'notify',
      job: sendNotification,
      data: { orderId: input.orderId, message: 'Order confirmed!' },
      dependsOn: ['payment'], // Also wait for payment (runs in parallel with inventory)
    },
  ],
});

// Register the flow (this will automatically register all jobs)
queue.registerFlow(orderFlow);

const flowApi = createFlowApi(orderFlow);

// Add a new flow
const flow = await flowApi.add('order-123', {
  orderId: '123',
  customerId: 'cust-456',
  amount: 99.99,
});

// Get flow status (includes all child jobs)
const status = await flowApi.getFlow('order-123');
console.log(status);
// {
//   id: 'order-123',
//   name: 'orders:validate',
//   state: 'completed',
//   progress: 100,
//   children: [
//     {
//       id: 'child-job-1',
//       name: 'orders:payment',
//       state: 'completed',
//       progress: 100,
//       children: [...]
//     }
//   ]
// }
```

#### Flow Features

**Type-Safe Job References:**

```typescript
flow: (jobs, input) => [
  {
    id: 'validate',
    job: jobs.validate, // Type-safe reference to job name
    data: { orderId: input.orderId }, // Validated input data
  },
];
```

**Dependency Graph:**

```typescript
flow: (jobs, input) => [
  {
    id: 'parent',
    job: jobs.parent,
    data: { ... },
  },
  {
    id: 'child1',
    job: jobs.child1,
    data: { ... },
    dependsOn: ['parent'], // Wait for parent
  },
  {
    id: 'child2',
    job: jobs.child2,
    data: { ... },
    dependsOn: ['parent'], // Also wait for parent (runs in parallel with child1)
  },
]
```

**Independent Retry:**
Each job in the flow can have its own retry configuration:

```typescript
const criticalJob = defineJob({
  name: 'critical',
  schema: z.object({}),
  handler: async () => { ... },
  options: {
    retry: { attempts: 10, backoff: { type: 'exponential', delay: 5000 } }
  }
});

const nonCriticalJob = defineJob({
  name: 'non-critical',
  schema: z.object({}),
  handler: async () => { ... },
  options: {
    retry: { attempts: 2, backoff: { type: 'fixed', delay: 1000 } }
  }
});
```

**Queue-Level Control:**
Specify different queues for different jobs:

```typescript
flow: (jobs, input) => [
  {
    id: 'high-priority',
    job: jobs.highPriority,
    queueName: 'priority-queue', // Use a specific queue
    data: { ... },
  },
  {
    id: 'low-priority',
    job: jobs.lowPriority,
    queueName: 'background-queue', // Different queue
    data: { ... },
    dependsOn: ['high-priority'],
  }
]
```

## Bull Board UI Integration

`@arki/queue` includes built-in support for Bull Board, a UI dashboard for monitoring and managing your queues.

### Setup with Hono

```typescript
import { Hono } from 'hono';
import { z } from 'zod';

import { createBoard, createQueue, defineJob } from '@arki/queue';

// Define your jobs
const sendEmail = defineJob({
  name: 'notifications:send-email',
  schema: z.object({ to: z.string().email() }),
  handler: async data => {
    // ...
    return { sent: true };
  },
});

// Create and register queue
const queue = createQueue({ connection: env.REDIS_URL });
queue.registerJob(sendEmail);
await queue.start();

// Create Bull Board
const { adapter } = createBoard({
  queues: [
    sendEmail._queue,
    // Add more queues...
  ],
  basePath: '/admin/queues',
  uiOptions: {
    boardTitle: 'My App - Job Queue Monitor',
    miscLinks: [{ text: 'Documentation', url: 'https://docs.myapp.com' }],
  },
});

// Mount Bull Board in your Hono app
const app = new Hono();
app.route('/admin/queues', adapter.registerPlugin());

export default app;
```

### Dynamic Queue Management

```typescript
const { board, addQueue, removeQueue } = createBoard({
  queues: [initialQueue._queue],
});

// Add a queue at runtime
addQueue(newQueue._queue!);

// Remove a queue
removeQueue('queue-name');
```

### Accessing the UI

Once mounted, visit `http://localhost:3000/admin/queues` (or your configured path) to:

- Monitor job counts (waiting, active, completed, failed, delayed)
- View job details and data
- Retry failed jobs
- Clean up old jobs
- Pause/resume queues
- View job logs and stack traces

### Security Considerations

**Important**: Always protect the Bull Board UI in production:

```typescript
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';

const app = new Hono();

// Add authentication
app.use(
  '/admin/*',
  basicAuth({
    username: env.ADMIN_USERNAME,
    password: env.ADMIN_PASSWORD,
  }),
);

// Mount Bull Board under protected route
app.route('/admin/queues', adapter.registerPlugin());
```

## Runtime Schedule Management

Inspired by Convex, `@arki/queue` allows you to manage schedules at runtime:

```typescript
// Register a new schedule at runtime
const scheduleName = await queue.schedules.register(
  defineSchedule({
    name: 'dynamic:cleanup',
    schedule: { type: 'interval', milliseconds: 3600000 },
    schema: z.object({}),
    handler: async () => {
      await cleanupTempFiles();
      return { cleaned: true };
    },
  }),
);

// List all schedules
const schedules = await queue.schedules.list();
console.log(schedules);
// [
//   {
//     name: 'dynamic:cleanup',
//     schedule: { type: 'interval', milliseconds: 3600000 },
//     nextRun: Date,
//     active: true
//   }
// ]

// Get a specific schedule
const schedule = await queue.schedules.get('dynamic:cleanup');

// Delete a schedule
await queue.schedules.delete('dynamic:cleanup');
```

## API Reference

### `defineJob<TInput, TOutput>(config)`

Define an on-demand job.

**Parameters:**

- `name: string` - Unique job name (use pattern: `featureName:jobType`)
- `schema: ZodSchema<TInput>` - Zod schema for input validation
- `handler: (data: TInput, ctx: JobContext) => Promise<TOutput>` - Job handler function
- `options?` - Job options:
  - `maxParallelism?: number` - Max concurrent jobs
  - `retry?: RetryConfig` - Retry configuration
  - `onComplete?: (job, result) => Promise<void>` - Success callback
  - `onError?: (job, error) => Promise<void>` - Error callback
  - `bullmqOptions?: Partial<JobsOptions>` - Additional BullMQ options
  - `workerOptions?: Partial<WorkerOptions>` - Additional worker options

**Returns:** `JobDefinition<TInput, TOutput>`

### `defineSchedule<TInput, TOutput>(config)`

Define a scheduled job (cron or interval).

**Parameters:**

- `name: string` - Unique schedule name
- `schedule: ScheduleConfig` - Schedule configuration:
  - Cron: `{ type: 'cron', pattern: string, timezone?: string }`
  - Interval: `{ type: 'interval', milliseconds: number }`
- `schema: ZodSchema<TInput>` - Zod schema for input validation
- `handler: (data: TInput, ctx: JobContext) => Promise<TOutput>` - Handler function
- `options?` - Schedule options:
  - `defaultData?: TInput` - Default data for scheduled jobs
  - `jobOptions?: JobOptions<TInput, TOutput>` - Job options

**Returns:** `ScheduleDefinition<TInput, TOutput>`

### `defineFlow<TInput>(config)`

Define a distributed workflow using BullMQ's FlowProducer.

**Parameters:**

- `name: string` - Unique flow name
- `schema: ZodSchema<TInput>` - Zod schema for input validation
- `flow: (input: TInput) => FlowStep[]` - Function that returns a flat array of steps with dependencies. Reference job definitions directly in the steps.
- `options?` - Flow options:
  - `defaultJobOptions?: Partial<JobsOptions>` - Default options for all jobs in the flow
  - `prefix?: string` - Key prefix for flow IDs

**Returns:** `FlowDefinition<TInput>`

**FlowStep Structure:**

```typescript
{
  id: string;                        // Unique step identifier
  job: JobDefinition<unknown, unknown>; // Job definition to execute
  data: unknown;                     // Data to pass to the job
  queueName?: string;                // Optional: specific queue name
  opts?: JobsOptions;                // Optional: job-specific options
  dependsOn?: string[];              // Optional: array of step IDs to wait for
}
```

**Example:**

```typescript
const orderFlow = defineFlow({
  name: 'orders:complex',
  schema: z.object({ orderId: z.string() }),
  flow: input => [
    {
      id: 'validate',
      job: validateJob, // Direct reference to job definition
      data: input,
    },
    {
      id: 'process',
      job: processJob,
      data: input,
      dependsOn: ['validate'],
    },
    {
      id: 'notify',
      job: notifyJob,
      data: input,
      dependsOn: ['process'],
    },
  ],
});
```

### `createQueue(options)`

Create a queue instance for managing jobs, schedules, and flows.

**Parameters:**

- `connection: string | ConnectionOptions` - Redis connection
- `keyPrefix?: string` - Redis key prefix (default: `'queue:'`)
- `defaultJobOptions?: Partial<JobsOptions>` - Default options for all jobs
- `defaultWorkerOptions?: Partial<WorkerOptions>` - Default options for all workers

**Returns:** `QueueInstance`

**QueueInstance Methods:**

- `registerJob(definition)` - Register a job definition
- `registerSchedule(definition)` - Register a schedule definition
- `registerFlow(definition)` - Register a flow definition (automatically registers all jobs in the flow)
- `start()` - Start all workers
- `stop()` - Stop all workers and close connections
- `schedules.register(definition)` - Register schedule at runtime
- `schedules.list()` - List all schedules
- `schedules.get(name)` - Get a specific schedule
- `schedules.delete(name)` - Delete a schedule

### `createJobApi(definition)`

Create a programmatic API for managing jobs and queues.

**Parameters:**

- `definition: JobDefinition<TInput, TOutput>` - Job definition created by `defineJob`

**Returns:** Object with methods:

- `add(name, data, options?)` - Add a job to the queue
- `getJob(jobId)` - Get job status by ID
- `getJobs(state, options?)` - Get multiple jobs by state
- `retry(jobId)` - Retry a failed job
- `remove(jobId)` - Remove a job
- `getStats()` - Get queue statistics
- `pause()` - Pause the queue
- `resume()` - Resume the queue
- `clean(grace, limit, type)` - Clean old jobs
- `drain(delayed?)` - Remove all jobs from queue
- `getQueue()` - Get underlying BullMQ queue

**Similar APIs:**

- `createScheduleApi(definition)` - For schedule definitions
- `createFlowApi(definition)` - For flow definitions

### `createFlowApi(definition)`

Create a programmatic API for managing distributed flows.

**Parameters:**

- `definition: FlowDefinition<TInput, TJobs>` - Flow definition created by `defineFlow`

**Returns:** Object with methods:

- `add(flowId, data, options?)` - Add a new flow to the queue
  - Validates input data
  - Builds the flow tree
  - Returns the root FlowJob
- `getFlow(flowId)` - Get flow status by ID (includes all child jobs recursively)
- `getFlowProducer()` - Get underlying BullMQ FlowProducer instance

**Example:**

```typescript
const flowApi = createFlowApi(orderFlow);

// Add a flow
const flow = await flowApi.add('order-123', {
  orderId: '123',
  amount: 99.99,
});

// Get flow status with all children
const status = await flowApi.getFlow('order-123');
```

### Job Context

The `ctx` parameter provided to handlers includes:

- `updateProgress(progress: number)` - Update job progress (0-100)
- `log(message: string)` - Log a message for this job
- `job: BullMQJob` - The underlying BullMQ job instance

## Choosing the Right Pattern

### Jobs vs Schedules vs Flows

**Use Jobs when:**

- Processing on-demand, event-driven tasks
- Each task is independent
- Examples: Send email, process payment, resize image

**Use Schedules when:**

- Running tasks on a recurring schedule
- Tasks need to run at specific times or intervals
- Examples: Daily reports, hourly health checks, weekly cleanup

**Use Flows when:**

- Complex job dependencies (parent-child relationships)
- Steps need independent retry logic
- Steps should be distributed across different workers/queues
- Better observability per step required
- Multi-step processes with sophisticated orchestration needs
- Examples: Complex ETL pipelines, distributed order processing, multi-stage data transformations

## Best Practices

### Naming Convention

Use the pattern `featureName:jobType` for job names:

```typescript
// Good
'notifications:send-email';
'orders:process';
'reports:generate-daily';

// Avoid
'sendEmail';
'processOrder';
```

### Error Handling

Differentiate between retriable and non-retriable errors:

```typescript
handler: async (data, ctx) => {
  try {
    await processData(data);
  } catch (error) {
    if (error instanceof ValidationError) {
      // Don't retry validation errors
      await ctx.log('Validation failed - not retrying');
      throw new Error('VALIDATION_ERROR');
    }
    // Network errors - will be retried
    throw error;
  }
};
```

### Resource Management

Always call `queue.stop()` on application shutdown:

```typescript
process.on('SIGTERM', async () => {
  await queue.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await queue.stop();
  process.exit(0);
});
```

### Testing

Test job handlers independently of the queue infrastructure:

```typescript
import { describe, expect, it, vi } from 'vitest';

describe('sendEmail job', () => {
  it('should send email successfully', async () => {
    const mockCtx = {
      updateProgress: vi.fn(),
      log: vi.fn(),
      job: {} as any,
    };

    const result = await sendEmail.handler(
      {
        to: 'test@example.com',
        subject: 'Test',
        body: 'Test body',
      },
      mockCtx,
    );

    expect(result.sent).toBe(true);
    expect(mockCtx.updateProgress).toHaveBeenCalledWith(100);
  });
});
```

## Comparison with Convex

`@arki/queue` draws inspiration from Convex's excellent API design:

| Feature                        | Convex | @arki/queue               |
| ------------------------------ | ------ | ------------------------- |
| Runtime schedule management    | ✅     | ✅                        |
| Cron schedules                 | ✅     | ✅                        |
| Interval schedules             | ✅     | ✅                        |
| Workpool (parallelism control) | ✅     | ✅ (via `maxParallelism`) |
| Distributed workflows          | ❌     | ✅ (via `defineFlow`)     |
| Step-based retry               | ✅     | ✅                        |
| Independent job retry          | ❌     | ✅ (in flows)             |
| Declarative API                | ✅     | ✅                        |
| UI Dashboard                   | ✅     | ✅ (via Bull Board)       |
| Self-hosted                    | ❌     | ✅                        |
| Built on Redis                 | ❌     | ✅                        |

## License

MIT
