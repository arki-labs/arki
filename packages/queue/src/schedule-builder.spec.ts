/**
 * Integration tests for schedule builders (CRON, INTERVAL, TIMEOUT)
 *
 * Tests the complete flow of scheduled job execution including:
 * - CRON patterns for recurring schedules
 * - INTERVAL for repeated execution
 * - TIMEOUT for one-time delayed execution
 * - Helper methods (daily, weekdays, etc.)
 * - Timezone support
 * - Middleware integration
 */
import type { StartedTestContainer } from 'testcontainers';
import { Queue } from 'bullmq';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';

import type { JobContext } from './types/job.ts';
import { CronPatterns } from './cron-patterns.ts';
import { initQueue } from './init.ts';

// Test context type
type TestContext = {
  userId: string;
  timestamp: Date;
};

// Redis container instance
let redisContainer: StartedTestContainer;
let redisUrl: string;

// ============================================
// Test Setup
// ============================================

beforeAll(async () => {
  // Start Redis container
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();

  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(6379);
  redisUrl = `redis://${redisHost}:${redisPort}`;

  console.log(`✓ Redis container started at ${redisUrl}`);
}, 60000);

afterAll(async () => {
  if (redisContainer) {
    await redisContainer.stop();
    console.log('✓ Redis container stopped');
  }
}, 30000);

// ============================================
// CRON Schedule Tests
// ============================================

describe('CRON Schedules', () => {
  describe('Basic CRON schedules', () => {
    it('should create CRON schedule with existing job', async () => {
      const q = initQueue.context<TestContext>().create();

      const executionCount = { value: 0 };

      const job = q.job
        .name('test:cron-job')
        .input(z.object({ taskId: z.string() }))
        .handler(async data => {
          executionCount.value++;
          return { completed: data.taskId };
        });

      // Every 2 seconds (for faster testing)
      const schedule = q.schedule.cron('*/2 * * * * *').job(job).data({ taskId: 'task-123' });

      const queue = q.createQueue({
        connection: redisUrl,
        createContext: () => ({
          userId: 'test-user-123',
          timestamp: new Date(),
        }),
      });

      await queue.register(q.registry({ schedule }));
      await queue.start();

      // Wait for multiple executions
      await new Promise(resolve => setTimeout(resolve, 5500));

      // Should have executed 2-3 times (at 0s, 2s, 4s)
      expect(executionCount.value).toBeGreaterThanOrEqual(2);
      expect(executionCount.value).toBeLessThanOrEqual(3);

      await queue.stop();
    }, 20000);

    it('should create CRON schedule with inline handler', async () => {
      const q = initQueue.context<TestContext>().create();

      const executions: string[] = [];

      const schedule = q.schedule
        .cron('*/2 * * * * *')
        .name('test:inline-cron')
        .input(z.object({ message: z.string() }))
        .handler(async data => {
          executions.push(data.message);
          return { processed: true };
        });

      const queue = q.createQueue({
        connection: redisUrl,
        createContext: () => ({
          userId: 'test-user-123',
          timestamp: new Date(),
        }),
      });

      await queue.register(q.registry({ schedule }));
      await queue.start();

      await new Promise(resolve => setTimeout(resolve, 5500));

      expect(executions.length).toBeGreaterThanOrEqual(2);

      await queue.stop();
    }, 20000);

    it('should respect timezone option in CRON schedule', async () => {
      const q = initQueue.context<TestContext>().create();

      const job = q.job
        .name('test:tz-job')
        .input(z.object({ zone: z.string() }))
        .handler(async data => {
          return { zone: data.zone, executed: true };
        });

      // Schedule with timezone
      const schedule = q.schedule
        .cron('*/3 * * * * *', { timezone: 'America/New_York' })
        .job(job)
        .data({ zone: 'America/New_York' });

      expect(schedule._internal.options?.timezone).toBe('America/New_York');
      expect(schedule._internal.type).toBe('cron');
    });
  });

  describe('CRON helper methods', () => {
    it('should use everySeconds helper', async () => {
      const q = initQueue.context<TestContext>().create();

      const executions: number[] = [];

      const job = q.job
        .name('test:every-seconds')
        .input(z.object({ tick: z.number() }))
        .handler(async data => {
          executions.push(data.tick);
          return { tick: data.tick };
        });

      const schedule = q.schedule.everySeconds(2).job(job).data({ tick: 1 });

      expect(schedule._internal.type).toBe('cron');
      expect(schedule._internal.value).toBe('*/2 * * * * *');

      const queue = q.createQueue({
        connection: redisUrl,
        createContext: () => ({
          userId: 'test-user-123',
          timestamp: new Date(),
        }),
      });

      await queue.register(q.registry({ schedule }));
      await queue.start();

      await new Promise(resolve => setTimeout(resolve, 5500));

      expect(executions.length).toBeGreaterThanOrEqual(2);

      await queue.stop();
    }, 20000);

    it('should use everyMinutes helper', () => {
      const q = initQueue.context<TestContext>().create();

      const job = q.job
        .name('test:every-minutes')
        .input(z.object({ value: z.number() }))
        .handler(async () => ({ success: true }));

      const schedule = q.schedule.everyMinutes(5).job(job).data({ value: 1 });

      expect(schedule._internal.type).toBe('cron');
      expect(schedule._internal.value).toBe('*/5 * * * *');
    });

    it('should use daily helper', () => {
      const q = initQueue.context<TestContext>().create();

      const job = q.job
        .name('test:daily')
        .input(z.object({ report: z.string() }))
        .handler(async () => ({ success: true }));

      const schedule = q.schedule.daily('09:00').job(job).data({ report: 'daily' });

      expect(schedule._internal.type).toBe('cron');
      expect(schedule._internal.value).toBe(CronPatterns.daily('09:00'));
    });

    it('should use weekdays helper', () => {
      const q = initQueue.context<TestContext>().create();

      const job = q.job
        .name('test:weekdays')
        .input(z.object({ type: z.string() }))
        .handler(async () => ({ success: true }));

      const schedule = q.schedule.weekdays('14:30').job(job).data({ type: 'weekday' });

      expect(schedule._internal.type).toBe('cron');
      expect(schedule._internal.value).toBe(CronPatterns.weekdays('14:30'));
    });

    it('should use weekly helper', () => {
      const q = initQueue.context<TestContext>().create();

      const job = q.job
        .name('test:weekly')
        .input(z.object({ day: z.string() }))
        .handler(async () => ({ success: true }));

      const schedule = q.schedule.weekly('friday', '17:00').job(job).data({ day: 'friday' });

      expect(schedule._internal.type).toBe('cron');
      expect(schedule._internal.value).toBe(CronPatterns.weekly('friday', '17:00'));
    });

    it('should use monthly helper', () => {
      const q = initQueue.context<TestContext>().create();

      const job = q.job
        .name('test:monthly')
        .input(z.object({ period: z.string() }))
        .handler(async () => ({ success: true }));

      const schedule = q.schedule.monthly(1, '00:00').job(job).data({ period: 'monthly' });

      expect(schedule._internal.type).toBe('cron');
      expect(schedule._internal.value).toBe(CronPatterns.monthly(1, '00:00'));
    });
  });
});

// ============================================
// INTERVAL Schedule Tests
// ============================================

describe('INTERVAL Schedules', () => {
  it('should create interval schedule with existing job', async () => {
    const q = initQueue.context<TestContext>().create();

    const executionTimestamps: number[] = [];

    const job = q.job
      .name('test:interval-job')
      .input(z.object({ counter: z.number() }))
      .handler(async data => {
        executionTimestamps.push(Date.now());
        return { counter: data.counter };
      });

    // Run every 1 second
    const schedule = q.schedule.interval(1000).job(job).data({ counter: 0 });

    expect(schedule._internal.type).toBe('interval');
    expect(schedule._internal.value).toBe(1000);

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ schedule }));
    await queue.start();

    // Wait for multiple executions
    await new Promise(resolve => setTimeout(resolve, 3500));

    expect(executionTimestamps.length).toBeGreaterThanOrEqual(3);

    // Verify intervals are approximately 1 second apart
    for (let i = 1; i < executionTimestamps.length; i++) {
      const interval = executionTimestamps[i]! - executionTimestamps[i - 1]!;
      expect(interval).toBeGreaterThanOrEqual(900); // Allow 100ms variance
      expect(interval).toBeLessThanOrEqual(1200);
    }

    await queue.stop();
  }, 20000);

  it('should create interval schedule with inline handler', async () => {
    const q = initQueue.context<TestContext>().create();

    const executions: string[] = [];

    const schedule = q.schedule
      .interval(1000)
      .name('test:inline-interval')
      .input(z.object({ id: z.string() }))
      .handler(async data => {
        executions.push(data.id);
        return { processed: true };
      });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ schedule }));
    await queue.start();

    await new Promise(resolve => setTimeout(resolve, 3500));

    expect(executions.length).toBeGreaterThanOrEqual(3);

    await queue.stop();
  }, 20000);

  // BullMQ 5 stored a schedule under an md5 key. BullMQ 6 keeps running such an
  // entry next to the one registered now, so every tick would execute twice.
  it('should replace a stale scheduler entry instead of running twice', async () => {
    const q = initQueue.context<TestContext>().create();

    const name = 'test-stale-interval';
    const executions: number[] = [];

    const schedule = q.schedule
      .interval(1000)
      .name(name)
      .input(z.object({}))
      .handler(async () => {
        executions.push(Date.now());
        return { processed: true };
      });

    const url = new URL(redisUrl);
    const bullQueue = new Queue(name, {
      connection: { host: url.hostname, port: Number(url.port) },
      prefix: 'queue:',
    });
    await bullQueue.upsertJobScheduler(
      '244d59fa5664c944701f2c64517e3a19',
      { every: 1000 },
      { name: 'scheduled-job', data: {} },
    );

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ schedule }));
    await queue.start();

    await new Promise(resolve => setTimeout(resolve, 3500));

    const schedulers = await bullQueue.getJobSchedulers();
    expect(schedulers.map(scheduler => scheduler.key)).toEqual([`schedule:${name}`]);

    // One run per second for 3.5s. A surviving stale entry would double this.
    expect(executions.length).toBeGreaterThanOrEqual(3);
    expect(executions.length).toBeLessThanOrEqual(5);

    await queue.stop();
    await bullQueue.close();
  }, 20000);

  it('should handle fast intervals correctly', async () => {
    const q = initQueue.context<TestContext>().create();

    const executionCount = { value: 0 };

    const job = q.job
      .name('test:fast-interval')
      .input(z.object({ data: z.string() }))
      .handler(async () => {
        executionCount.value++;
        return { success: true };
      });

    // Run every 500ms
    const schedule = q.schedule.interval(500).job(job).data({ data: 'test' });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ schedule }));
    await queue.start();

    await new Promise(resolve => setTimeout(resolve, 3000));

    // Should have executed ~6 times in 3 seconds
    expect(executionCount.value).toBeGreaterThanOrEqual(5);
    expect(executionCount.value).toBeLessThanOrEqual(7);

    await queue.stop();
  }, 20000);
});

// ============================================
// TIMEOUT Schedule Tests
// ============================================

describe('TIMEOUT Schedules', () => {
  it('should execute job once after timeout delay', async () => {
    const q = initQueue.context<TestContext>().create();

    const executionCount = { value: 0 };
    const executionTime = { value: 0 };

    const job = q.job
      .name('test:timeout-job')
      .input(z.object({ taskId: z.string() }))
      .handler(async data => {
        executionCount.value++;
        executionTime.value = Date.now();
        return { completed: data.taskId };
      });

    const startTime = Date.now();

    // Execute once after 2 seconds
    const schedule = q.schedule.timeout(2000).job(job).data({ taskId: 'timeout-task' });

    expect(schedule._internal.type).toBe('timeout');
    expect(schedule._internal.value).toBe(2000);

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ schedule }));
    await queue.start();

    // Wait for execution plus some buffer
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Should have executed exactly once
    expect(executionCount.value).toBe(1);

    // Should have executed approximately 2 seconds after start
    const actualDelay = executionTime.value - startTime;
    expect(actualDelay).toBeGreaterThanOrEqual(1800);
    expect(actualDelay).toBeLessThanOrEqual(2500);

    // Wait a bit more to confirm it doesn't execute again
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Still should be exactly 1 execution
    expect(executionCount.value).toBe(1);

    await queue.stop();
  }, 20000);

  it('should execute timeout schedule with inline handler', async () => {
    const q = initQueue.context<TestContext>().create();

    const executed = { value: false };
    const executedAt = { value: 0 };

    const schedule = q.schedule
      .timeout(1500)
      .name('test:inline-timeout')
      .input(z.object({ message: z.string() }))
      .handler(async data => {
        executed.value = true;
        executedAt.value = Date.now();
        return { message: data.message, executed: true };
      });

    const startTime = Date.now();

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ schedule }));
    await queue.start();

    // Wait for execution
    await new Promise(resolve => setTimeout(resolve, 2500));

    expect(executed.value).toBe(true);

    const actualDelay = executedAt.value - startTime;
    expect(actualDelay).toBeGreaterThanOrEqual(1300);
    expect(actualDelay).toBeLessThanOrEqual(2000);

    await queue.stop();
  }, 20000);

  it('should not repeat timeout execution', async () => {
    const q = initQueue.context<TestContext>().create();

    const executionCount = { value: 0 };

    const job = q.job
      .name('test:no-repeat-timeout')
      .input(z.object({ id: z.string() }))
      .handler(async () => {
        executionCount.value++;
        return { executed: true };
      });

    const schedule = q.schedule.timeout(1000).job(job).data({ id: 'once' });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ schedule }));
    await queue.start();

    // Wait well beyond the timeout
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Should still be exactly 1 execution
    expect(executionCount.value).toBe(1);

    await queue.stop();
  }, 20000);
});

// ============================================
// Schedule with Middleware Tests
// ============================================

describe('Schedules with Middleware', () => {
  it('should execute middleware with scheduled jobs', async () => {
    const q = initQueue.context<TestContext>().create();

    const executionOrder: string[] = [];

    const loggingMiddleware = q.middleware<JobContext<TestContext>, JobContext<TestContext>>(opts => {
      executionOrder.push('middleware-start');
      const result = opts.next({ ctx: opts.ctx });
      executionOrder.push('middleware-end');
      return result;
    });

    const job = q.job
      .use(loggingMiddleware)
      .name('test:scheduled-middleware')
      .input(z.object({ value: z.number() }))
      .handler(async () => {
        executionOrder.push('handler');
        return { success: true };
      });

    const schedule = q.schedule.interval(1500).job(job).data({ value: 42 });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ schedule }));
    await queue.start();

    await new Promise(resolve => setTimeout(resolve, 2500));

    // Should have executed with middleware
    expect(executionOrder).toContain('middleware-start');
    expect(executionOrder).toContain('handler');
    expect(executionOrder).toContain('middleware-end');

    await queue.stop();
  }, 20000);

  it('should apply middleware to inline schedule handlers', async () => {
    const q = initQueue.context<TestContext>().create();

    const middlewareExecuted = { value: false };
    const handlerExecuted = { value: false };

    const trackingMiddleware = q.middleware<JobContext<TestContext>, JobContext<TestContext>>(opts => {
      middlewareExecuted.value = true;
      return opts.next({ ctx: opts.ctx });
    });

    const schedule = q.schedule
      .interval(1000)
      .use(trackingMiddleware)
      .name('test:inline-with-middleware')
      .input(z.object({ data: z.string() }))
      .handler(async () => {
        handlerExecuted.value = true;
        return { result: 'done' };
      });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ schedule }));
    await queue.start();

    await new Promise(resolve => setTimeout(resolve, 2000));

    expect(middlewareExecuted.value).toBe(true);
    expect(handlerExecuted.value).toBe(true);

    await queue.stop();
  }, 20000);
});

// ============================================
// Schedule Name Generation Tests
// ============================================

describe('Schedule Name Generation', () => {
  it('should auto-generate name from job when not provided', () => {
    const q = initQueue.context<TestContext>().create();

    const job = q.job
      .name('test:auto-name-job')
      .input(z.object({ value: z.number() }))
      .handler(async () => ({ success: true }));

    const schedule = q.schedule.daily('09:00').job(job).data({ value: 1 });

    expect(schedule._internal.name).toBe('test:auto-name-job-schedule');
  });

  it('should use explicit name when provided for inline handler', () => {
    const q = initQueue.context<TestContext>().create();

    const schedule = q.schedule
      .cron('0 0 * * *')
      .name('custom-schedule-name')
      .input(z.object({ id: z.string() }))
      .handler(async () => ({ done: true }));

    expect(schedule._internal.name).toBe('custom-schedule-name');
  });

  it('should throw error if inline handler missing name', () => {
    const q = initQueue.context<TestContext>().create();

    expect(() => {
      // @ts-expect-error - Testing runtime validation
      q.schedule
        .interval(1000)
        .input(z.object({ value: z.number() }))
        .handler(async () => ({ result: 1 }));
    }).toThrow('Schedule name is required');
  });

  it('should throw error if inline handler missing input schema', () => {
    const q = initQueue.context<TestContext>().create();

    expect(() => {
      // @ts-expect-error - Testing runtime validation
      q.schedule
        .interval(1000)
        .name('test-schedule')
        .handler(async () => ({ result: 1 }));
    }).toThrow('Input schema is required');
  });
});

// ============================================
// Real-World Scenarios
// ============================================

describe('Real-World Schedule Scenarios', () => {
  it('should implement daily report generation', async () => {
    const q = initQueue.context<TestContext>().create();

    const reportsGenerated: string[] = [];

    const generateReportJob = q.job
      .name('test:daily-report')
      .input(z.object({ reportType: z.string(), date: z.string() }))
      .handler(async data => {
        reportsGenerated.push(`${data.reportType}-${data.date}`);
        return { generated: true, type: data.reportType };
      });

    // Daily at 9 AM (simulated with fast execution for testing)
    const schedule = q.schedule
      .everySeconds(2)
      .job(generateReportJob)
      .data({
        reportType: 'daily',
        date: new Date().toISOString().split('T')[0]!,
      });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ schedule }));
    await queue.start();

    await new Promise(resolve => setTimeout(resolve, 5000));

    expect(reportsGenerated.length).toBeGreaterThanOrEqual(2);
    expect(reportsGenerated[0]).toMatch(/^daily-\d{4}-\d{2}-\d{2}$/);

    await queue.stop();
  }, 20000);

  it('should implement health check with interval', async () => {
    const q = initQueue.context<TestContext>().create();

    const healthChecks: { timestamp: number; status: string }[] = [];

    const healthCheckJob = q.job
      .name('test:health-check')
      .input(z.object({ service: z.string() }))
      .handler(async data => {
        healthChecks.push({
          timestamp: Date.now(),
          status: 'healthy',
        });
        return { service: data.service, healthy: true };
      });

    // Check every 1 second
    const schedule = q.schedule.interval(1000).job(healthCheckJob).data({ service: 'api' });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ schedule }));
    await queue.start();

    await new Promise(resolve => setTimeout(resolve, 3500));

    expect(healthChecks.length).toBeGreaterThanOrEqual(3);

    // Verify checks happen at consistent intervals
    for (let i = 1; i < healthChecks.length; i++) {
      const interval = healthChecks[i]!.timestamp - healthChecks[i - 1]!.timestamp;
      expect(interval).toBeGreaterThanOrEqual(900);
      expect(interval).toBeLessThanOrEqual(1200);
    }

    await queue.stop();
  }, 20000);

  it('should implement reminder email with timeout', async () => {
    const q = initQueue.context<TestContext>().create();

    const reminderSent = { value: false };
    const sentAt = { value: 0 };

    const sendReminderJob = q.job
      .name('test:send-reminder')
      .input(z.object({ userId: z.string(), message: z.string() }))
      .handler(async data => {
        reminderSent.value = true;
        sentAt.value = Date.now();
        return { sent: true, userId: data.userId };
      });

    // Send reminder after 2 seconds (simulating 24 hours in production)
    const schedule = q.schedule.timeout(2000).job(sendReminderJob).data({
      userId: 'usr_123',
      message: 'Complete your profile',
    });

    const startTime = Date.now();

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ schedule }));
    await queue.start();

    await new Promise(resolve => setTimeout(resolve, 3000));

    expect(reminderSent.value).toBe(true);

    const delay = sentAt.value - startTime;
    expect(delay).toBeGreaterThanOrEqual(1800);
    expect(delay).toBeLessThanOrEqual(2500);

    // Verify it doesn't send again
    await new Promise(resolve => setTimeout(resolve, 2000));
    expect(reminderSent.value).toBe(true); // Still just once

    await queue.stop();
  }, 20000);
});
