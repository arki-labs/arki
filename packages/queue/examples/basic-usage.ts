/**
 * Basic usage example for @arki/queue v2.0
 *
 * This example demonstrates the new tRPC-inspired API
 */

import { z } from '@arki/contracts';

import {
  errorHandlingMiddleware,
  initQueue,
  loggingMiddleware,
  structuredLoggingMiddleware,
  timingMiddleware,
} from '../src/index.ts';

// ============================================
// 1. Define Application Context
// ============================================

type AppContext = {
  db: {
    query: (sql: string) => Promise<any>;
  };
  repo: {
    notifications: {
      create: (data: any) => Promise<void>;
    };
  };
  kv: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<void>;
  };
};

const createContext = (): AppContext => ({
  db: {
    query: async (sql: string) => {
      console.log('Executing query:', sql);
      return [];
    },
  },
  repo: {
    notifications: {
      create: async (data: any) => {
        console.log('Creating notification:', data);
      },
    },
  },
  kv: {
    get: async (key: string) => {
      console.log('Getting key:', key);
      return null;
    },
    set: async (key: string, value: any) => {
      console.log('Setting key:', key, 'to', value);
    },
  },
});

// ============================================
// 2. Initialize Queue
// ============================================

const q = initQueue.context<AppContext>().create({
  // Optional: Add custom transformer, error formatter, etc.
});

// ============================================
// 3. Create Job Builders with Middleware
// ============================================

// Base job with standard middleware
const baseJob = q.job
  .use(errorHandlingMiddleware())
  .use(timingMiddleware())
  .use(loggingMiddleware());

// Job with structured logging (adds logger to context)
const monitoredJob = q.job
  .use(errorHandlingMiddleware())
  .use(timingMiddleware())
  .use(structuredLoggingMiddleware());

// Custom auth middleware example
const authMiddleware = q.middleware<AppContext & { user: { id: string; email: string } }>(
  async ({ ctx, data, next }) => {
    // Extract user ID from data
    const userId = (data as any).userId;

    if (!userId) {
      throw new Error('User ID is required');
    }

    // Mock user lookup
    const user = {
      id: userId,
      email: `user-${userId}@example.com`,
    };

    console.log('Authenticated user:', user.email);

    // Add user to context
    return next({
      ctx: {
        ...ctx,
        user,
      },
    });
  },
);

// Authenticated job builder
const authenticatedJob = monitoredJob.use(authMiddleware);

// ============================================
// 4. Define Jobs
// ============================================

// Simple job
const sendEmail = baseJob
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
    // Context has: db, repo, kv
    await ctx.repo.notifications.create({
      type: 'email',
      recipient: data.to,
      subject: data.subject,
      body: data.body,
    });

    return { sent: true, messageId: `msg_${Date.now()}` };
  });

// Authenticated job with logger
const processUserData = authenticatedJob
  .name('users:process-data')
  .input(
    z.object({
      userId: z.string(),
      action: z.enum(['sync', 'update', 'delete']),
    }),
  )
  .handler(async (data, ctx) => {
    // Context has: db, repo, kv, logger, user
    ctx.logger.info('Processing user data', { action: data.action });

    // Simulate processing
    await new Promise(resolve => setTimeout(resolve, 100));

    ctx.logger.info('User data processed successfully');

    return {
      success: true,
      userId: data.userId,
      action: data.action,
      processedAt: new Date().toISOString(),
    };
  });

// Job with database operations
const syncData = monitoredJob
  .name('data:sync')
  .input(
    z.object({
      source: z.string(),
      target: z.string(),
    }),
  )
  .handler(async (data, ctx) => {
    ctx.logger.info('Starting data sync', data);

    // Use database from context
    const sourceData = await ctx.db.query(`SELECT * FROM ${data.source}`);
    ctx.logger.info(`Fetched ${sourceData.length} records from source`);

    // Use KV cache
    const cachedMapping = await ctx.kv.get(`sync:mapping:${data.source}`);

    ctx.logger.info('Data sync completed');

    return {
      success: true,
      recordsProcessed: sourceData.length,
      usedCache: !!cachedMapping,
    };
  });

// ============================================
// 5. Define Schedules
// ============================================

// Schedule using existing job
const dailyEmailSchedule = q.schedule
  .cron('0 9 * * *', { timezone: 'America/New_York' }) // Every day at 9 AM EST
  .job(sendEmail)
  .data({
    to: 'admin@example.com',
    subject: 'Daily Report',
    body: 'Your daily summary is ready',
  });

// Schedule with inline handler
const hourlyDataSync = q.schedule
  .interval(60 * 60 * 1000) // Every hour
  .use(structuredLoggingMiddleware())
  .name('data:hourly-sync')
  .input(z.object({ timestamp: z.string() }))
  .handler(async (data, ctx) => {
    ctx.logger.info('Running hourly sync', { timestamp: data.timestamp });

    // Perform sync operation
    await ctx.db.query('REFRESH MATERIALIZED VIEW stats');

    return { synced: true, timestamp: data.timestamp };
  });

// Weekly cleanup schedule with existing job
const weeklyCleanup = q.schedule
  .cron('0 2 * * 0') // Every Sunday at 2 AM
  .use(errorHandlingMiddleware())
  .use(loggingMiddleware())
  .job(syncData)
  .data({
    source: 'temp_data',
    target: 'archive',
  });

// ============================================
// 6. Define Flows (Multi-step Workflows)
// ============================================

// Simple two-step flow
const userOnboardingFlow = q.flow
  .name('users:onboarding-flow')
  .input(z.object({ userId: z.string(), email: z.string() }))
  .use(structuredLoggingMiddleware())
  .use(errorHandlingMiddleware())
  .step('send-welcome-email', {
    job: sendEmail,
    data: input => ({
      to: input.email,
      subject: 'Welcome!',
      body: 'Thanks for signing up!',
    }),
  })
  .step('process-initial-data', {
    job: processUserData,
    data: input => ({
      userId: input.userId,
      action: 'sync' as const,
    }),
    dependsOn: ['send-welcome-email'], // Runs after welcome email is sent
  })
  .build();

// Complex flow with parallel steps
const dataProcessingFlow = q.flow
  .name('data:complex-processing-flow')
  .input(
    z.object({
      source: z.string(),
      target: z.string(),
      userId: z.string(),
    }),
  )
  .use(timingMiddleware())
  .use(loggingMiddleware())
  // Step 1: Initial sync (no dependencies)
  .step('initial-sync', {
    job: syncData,
    data: input => ({
      source: input.source,
      target: input.target,
    }),
  })
  // Step 2 & 3: These can run in parallel after step 1
  .step('send-notification', {
    job: sendEmail,
    data: input => ({
      to: `user-${input.userId}@example.com`,
      subject: 'Data sync started',
      body: 'Your data sync has been initiated',
    }),
    dependsOn: ['initial-sync'],
  })
  .step('update-user-data', {
    job: processUserData,
    data: input => ({
      userId: input.userId,
      action: 'update' as const,
    }),
    dependsOn: ['initial-sync'],
  })
  // Step 4: Runs after both parallel steps complete
  .step('final-sync', {
    job: syncData,
    data: input => ({
      source: `${input.target}_temp`,
      target: input.target,
    }),
    dependsOn: ['send-notification', 'update-user-data'], // Waits for both
  })
  .build();

// ============================================
// 7. Create Job Registry
// ============================================

const jobs = q.registry({
  notifications: q.registry({
    sendEmail,
  }),
  users: q.registry({
    processData: processUserData,
  }),
  data: q.registry({
    sync: syncData,
  }),
});

// ============================================
// 8. Create and Use Queue
// ============================================

// Create queue instance (now fully implemented!)
const queue = q.createQueue({
  connection: 'redis://localhost:6379',
  createContext,
});

// Example usage (in an async function):
async function example() {
  // Register all jobs, schedules, and flows from the registry
  await queue.register(jobs);

  // Start all workers
  await queue.start();

  // Jobs, schedules, and flows are now running!
  // You can manually trigger jobs by adding them to their queues
  // (Job triggering API is outside the scope of this example)

  // Graceful shutdown
  // await queue.stop();
}

// Note: Uncomment the line below to run the example
// void example();

// ============================================
// 7. Export for testing
// ============================================

export {
  createContext,
  dailyEmailSchedule,
  dataProcessingFlow,
  hourlyDataSync,
  jobs,
  processUserData,
  q,
  sendEmail,
  syncData,
  userOnboardingFlow,
  weeklyCleanup,
};

console.log('✅ Example setup complete!');
console.log('Jobs defined:', Object.keys(jobs));
console.log('Schedules defined: dailyEmailSchedule, hourlyDataSync, weeklyCleanup');
console.log('Flows defined: userOnboardingFlow, dataProcessingFlow');
