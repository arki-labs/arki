# Migration Guide: v1.x to v2.0

This guide helps you migrate from @arki/queue v1.x to v2.0, which is a complete architectural rewrite inspired by tRPC.

## Overview of Breaking Changes

Version 2.0 is a **complete rewrite** with no backwards compatibility. The new API:

- Uses tRPC-inspired patterns (`initQueue`, chainable builders)
- Implements a composable middleware system
- Provides full type safety through middleware chain
- Organizes jobs hierarchically with registries
- Changes from `defineJob` → builder pattern

## Migration Strategy

We recommend migrating incrementally by feature:

1. Update package imports and initialization
2. Migrate middleware to new system
3. Convert job definitions one feature at a time
4. Convert schedules
5. Convert flows
6. Update queue instance creation

## Step-by-Step Migration

### 1. Package Initialization

**v1.x:**

```typescript
import { createQueue } from '@arki/queue';

const queue = createQueue({
  connection: 'redis://localhost:6379',
  createContext: () => ({ db, repo, kv }),
});
```

**v2.0:**

```typescript
import { initQueue } from '@arki/queue';

// 1. Initialize queue builder
const q = initQueue.context<AppContext>().create({
  transformer: superjson,
});

// 2. Create queue instance later
const queue = q.createQueue({
  connection: 'redis://localhost:6379',
  createContext: () => ({ db, repo, kv }),
});
```

### 2. Context Type Definition

**v1.x:**

```typescript
// Context was passed directly to createQueue
const queue = createQueue({
  createContext: () => ({ db, repo, kv }),
});
```

**v2.0:**

```typescript
// Define context type upfront
type AppContext = {
  db: Database;
  repo: Repositories;
  kv: KVStore;
};

const q = initQueue.context<AppContext>().create();
```

### 3. Job Definition

**v1.x:**

```typescript
import { z } from 'zod/v4';

import { defineJob } from '@arki/queue';

export const sendEmail = defineJob({
  name: 'notifications:send-email',
  inputSchema: z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string(),
  }),
  handler: async (data, ctx) => {
    await ctx.repo.notifications.create({
      type: 'email',
      recipient: data.to,
      subject: data.subject,
      body: data.body,
    });

    return { sent: true, messageId: `msg_${Date.now()}` };
  },
  options: {
    maxParallelism: 50,
    retry: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    },
  },
});
```

**v2.0:**

```typescript
// Create a base job builder with middleware
const baseJob = q.job.use(errorHandlingMiddleware()).use(timingMiddleware()).use(loggingMiddleware());

// Define job using chainable API
export const sendEmail = baseJob
  .name('notifications:send-email')
  .input(
    z.object({
      to: z.string().email(),
      subject: z.string(),
      body: z.string(),
    }),
  )
  .options({
    maxParallelism: 50,
    retry: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    },
  })
  .handler(async (data, ctx) => {
    // Same handler implementation
    await ctx.repo.notifications.create({
      type: 'email',
      recipient: data.to,
      subject: data.subject,
      body: data.body,
    });

    return { sent: true, messageId: `msg_${Date.now()}` };
  });
```

### 4. Middleware Migration

**v1.x:**
Middleware was not a first-class concept. You had to wrap handlers manually:

```typescript
const handler = async (data, ctx) => {
  const start = Date.now();
  try {
    console.log('Starting job:', data);
    const result = await actualHandler(data, ctx);
    console.log(`Job took ${Date.now() - start}ms`);
    return result;
  } catch (error) {
    console.error('Job failed:', error);
    throw error;
  }
};
```

**v2.0:**
Middleware is composable and reusable:

```typescript
// Use standard middleware
const baseJob = q.job.use(errorHandlingMiddleware()).use(timingMiddleware()).use(loggingMiddleware());

// Or create custom middleware
const customMiddleware = q.middleware(async ({ ctx, data, next }) => {
  console.log('Before job');
  const result = await next();
  console.log('After job');
  return result;
});

const job = baseJob
  .use(customMiddleware)
  .name('my-job')
  .input(schema)
  .handler(async (data, ctx) => {
    // Handler is clean, no middleware logic needed
  });
```

### 5. Context Extension with Middleware

**v2.0 New Feature:**
Middleware can now extend context types:

```typescript
// Middleware that adds logger to context
const jobWithLogger = q.job
  .use(structuredLoggingMiddleware())
  .name('my-job')
  .input(schema)
  .handler(async (data, ctx) => {
    // ctx.logger is now available!
    ctx.logger.info('Processing job', { data });
    ctx.logger.warn('Warning message');
    ctx.logger.error('Error message', { error });

    return { success: true };
  });
```

### 6. Schedule Migration

**v1.x:**

```typescript
import { defineSchedule } from '@arki/queue';

export const dailyReport = defineSchedule({
  name: 'reports:daily',
  schedule: '0 9 * * *',
  timezone: 'America/New_York',
  job: generateReport,
  data: { reportType: 'daily' },
});
```

**v2.0:**

```typescript
// Wrap existing job
export const dailyReport = q.schedule
  .cron('0 9 * * *', { timezone: 'America/New_York' })
  .job(generateReport)
  .data({ reportType: 'daily' });

// Or define inline handler with middleware
export const hourlySync = q.schedule
  .interval(60 * 60 * 1000)
  .use(structuredLoggingMiddleware())
  .name('data:hourly-sync')
  .input(z.object({ timestamp: z.string() }))
  .handler(async (data, ctx) => {
    ctx.logger.info('Running hourly sync');
    return { synced: true };
  });
```

### 7. Flow Migration

**v1.x:**

```typescript
import { defineFlow } from '@arki/queue';

export const orderFlow = defineFlow({
  name: 'orders:process-flow',
  inputSchema: z.object({ orderId: z.string() }),
  flow: input =>
    [
      {
        id: 'validate' as const,
        job: validateJob,
        data: { orderId: input.orderId },
      },
      {
        id: 'payment' as const,
        job: paymentJob,
        data: { orderId: input.orderId },
        dependsOn: ['validate'] as const,
      },
    ] as const,
});
```

**v2.0:**

```typescript
// Chainable API with automatic validation
export const orderFlow = q.flow
  .name('orders:process-flow')
  .input(z.object({ orderId: z.string() }))
  .use(loggingMiddleware())
  .step('validate', {
    job: validateJob,
    data: input => ({ orderId: input.orderId }),
  })
  .step('payment', {
    job: paymentJob,
    data: input => ({ orderId: input.orderId }),
    dependsOn: ['validate'], // Type-safe!
  })
  .step('inventory', {
    job: inventoryJob,
    data: input => ({ orderId: input.orderId }),
    dependsOn: ['payment'],
  })
  .step('notify', {
    job: notifyJob,
    data: input => ({ orderId: input.orderId }),
    dependsOn: ['payment'], // Runs in parallel with inventory
  })
  .build();
```

### 8. Registry Organization

**v1.x:**

```typescript
// Jobs were typically exported individually
export { sendEmail } from './send-email';
export { sendSMS } from './send-sms';
export { onboardUser } from './onboard-user';
```

**v2.0:**

```typescript
// Organize jobs hierarchically by feature
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

// Register all at once
await queue.register(jobs);
```

### 9. Queue Instance and Registration

**v1.x:**

```typescript
const queue = createQueue({
  connection: 'redis://localhost:6379',
  createContext,
});

// Register individual items
queue.registerJob(sendEmail);
queue.registerJob(sendSMS);
queue.registerSchedule(dailyReport);
queue.registerFlow(orderFlow);

await queue.start();
```

**v2.0:**

```typescript
// Create queue instance
const queue = q.createQueue({
  connection: 'redis://localhost:6379',
  createContext,
});

// Register entire registry at once
await queue.register(jobs);

// Start all workers
await queue.start();

// Graceful shutdown
await queue.stop();
```

## Common Migration Patterns

### Pattern 1: Job with Error Handling

**v1.x:**

```typescript
export const riskyJob = defineJob({
  name: 'risky-job',
  inputSchema: schema,
  handler: async (data, ctx) => {
    try {
      // Logic
      return result;
    } catch (error) {
      console.error('Job failed:', error);
      throw error;
    }
  },
});
```

**v2.0:**

```typescript
// Error handling is middleware
const riskyJob = q.job
  .use(errorHandlingMiddleware())
  .name('risky-job')
  .input(schema)
  .handler(async (data, ctx) => {
    // Just focus on business logic
    return result;
  });
```

### Pattern 2: Job with Logging

**v1.x:**

```typescript
export const loggedJob = defineJob({
  name: 'logged-job',
  inputSchema: schema,
  handler: async (data, ctx) => {
    console.log('Starting job with data:', data);
    const start = Date.now();
    const result = await doWork(data, ctx);
    console.log(`Job completed in ${Date.now() - start}ms`);
    return result;
  },
});
```

**v2.0:**

```typescript
// Logging is middleware
const loggedJob = q.job
  .use(structuredLoggingMiddleware())
  .use(timingMiddleware())
  .name('logged-job')
  .input(schema)
  .handler(async (data, ctx) => {
    ctx.logger.info('Processing', { data });
    return await doWork(data, ctx);
  });
```

### Pattern 3: Authenticated Job

**v2.0 New Feature:**

```typescript
// Custom auth middleware
const authMiddleware = q.middleware<AppContext & { user: User }>(async ({ ctx, data, next }) => {
  const userId = (data as any).userId;

  if (!userId) {
    throw new Error('User ID is required');
  }

  const user = await ctx.db.users.findById(userId);

  if (!user) {
    throw new Error('User not found');
  }

  return next({
    ctx: {
      ...ctx,
      user,
    },
  });
});

// Use in job
const authenticatedJob = q.job
  .use(errorHandlingMiddleware())
  .use(authMiddleware)
  .name('authenticated-job')
  .input(
    z.object({
      userId: z.string(),
      data: z.any(),
    }),
  )
  .handler(async (data, ctx) => {
    // ctx.user is now available!
    console.log('Processing for user:', ctx.user.email);
    return { success: true };
  });
```

## Testing Migration

**v1.x:**

```typescript
describe('sendEmail job', () => {
  it('should send email', async () => {
    const mockCtx = {
      /* ... */
    };
    const result = await sendEmail.handler({ to: 'test@example.com', subject: 'Test', body: 'Test' }, mockCtx);
    expect(result.sent).toBe(true);
  });
});
```

**v2.0:**

```typescript
describe('sendEmail job', () => {
  it('should send email', async () => {
    const mockCtx = {
      /* ... */
    } as AppContext;

    // Access internal handler
    const result = await sendEmail._internal.handler(
      { to: 'test@example.com', subject: 'Test', body: 'Test' },
      mockCtx,
    );

    expect(result.sent).toBe(true);
  });
});
```

## Troubleshooting

### Issue: "Property '\_internal' does not exist"

This means you're trying to access internal properties. Only use `_internal` in tests.

**Solution:** Use the job as-is in production code, only access `_internal` in tests.

### Issue: "Type 'X' is not assignable to type 'Y'"

This usually means middleware types don't match.

**Solution:** Ensure middleware chain types align:

```typescript
// ✅ Correct
const job = q.job
  .use(middleware1) // Returns TContext1
  .use(middleware2) // Accepts TContext1, returns TContext2
  .handler((data, ctx) => {
    // ctx is TContext2
  });
```

### Issue: "Cannot find module '@arki/queue'"

**Solution:** Update your package.json:

```bash
pnpm add @arki/queue@latest
```

### Issue: Flow validation errors

**Solution:** Ensure all `dependsOn` references valid step IDs:

```typescript
// ❌ Wrong
.step('payment', {
  job: paymentJob,
  data: input => input,
  dependsOn: ['invalid-step'], // Error!
})

// ✅ Correct
.step('payment', {
  job: paymentJob,
  data: input => input,
  dependsOn: ['validate'], // Must reference existing step
})
```

## Benefits of Migration

After migrating to v2.0, you'll have:

1. **Better Type Safety**: Full type inference through middleware chain
2. **Cleaner Code**: Middleware composition reduces boilerplate
3. **More Flexibility**: Extend context, compose behaviors
4. **Better DX**: tRPC-like API, familiar patterns
5. **Easier Testing**: Clear separation of concerns
6. **Better Organization**: Registry-based job organization

## Need Help?

- Check the [README.md](./README.md) for complete API reference
- See [examples/basic-usage.ts](./examples/basic-usage.ts) for working code
- Open an issue on GitHub for migration questions

## Quick Reference

| v1.x                    | v2.0                                               |
| ----------------------- | -------------------------------------------------- |
| `defineJob({...})`      | `q.job.name().input().handler()`                   |
| `defineSchedule({...})` | `q.schedule.cron().job().data()`                   |
| `defineFlow({...})`     | `q.flow.name().input().step().build()`             |
| `createQueue()`         | `initQueue.context().create()` + `q.createQueue()` |
| `queue.registerJob()`   | `queue.register(registry)`                         |
| No middleware           | `q.job.use(middleware)`                            |
| Manual wrapping         | Composable middleware                              |
| Flat exports            | `q.registry()` hierarchy                           |
