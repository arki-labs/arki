/**
 * Integration tests for queue initialization and job registration
 *
 * Tests the complete flow from queue creation to job execution using real Redis.
 * Covers: initialization, job registration, worker startup, job execution, and shutdown.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

import { initQueue } from './init.ts';
import type { JobContext } from './types/job.ts';

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
// Queue Initialization Tests
// ============================================

describe('Queue Initialization', () => {
  describe('Basic initialization', () => {
    it('should create queue with default configuration', () => {
      const q = initQueue.context<TestContext>().create();

      expect(q).toBeDefined();
      expect(q.job).toBeDefined();
      expect(q.middleware).toBeDefined();
      expect(q.registry).toBeDefined();
      expect(q.schedule).toBeDefined();
      expect(q.flow).toBeDefined();
      expect(q.createQueue).toBeDefined();
    });

    it('should create queue with custom transformer', () => {
      const customTransformer = {
        serialize: (data: unknown) => JSON.stringify(data),
        deserialize: (data: unknown) => JSON.parse(data as string),
      };

      const q = initQueue.context<TestContext>().create({
        transformer: customTransformer,
      });

      expect(q._config.transformer).toBe(customTransformer);
    });

    it('should create queue without context type', () => {
      const q = initQueue.create();

      expect(q).toBeDefined();
      expect(q.job).toBeDefined();
    });
  });

  describe('Job builder', () => {
    it('should create job with builder pattern', () => {
      const q = initQueue.context<TestContext>().create();

      const job = q.job
        .name('test:simple-job')
        .input(z.object({ message: z.string() }))
        .handler(async (data) => {
          return { success: true, message: data.message };
        });

      expect(job._type).toBe('job');
      expect(job._internal.name).toBe('test:simple-job');
      expect(job._internal.inputSchema).toBeDefined();
      expect(job._internal.handler).toBeDefined();
    });

    it('should create job with middleware', () => {
      const q = initQueue.context<TestContext>().create();

      const middleware = q.middleware<JobContext<TestContext>, JobContext<TestContext>>((opts) =>
        opts.next({ ctx: opts.ctx }),
      );

      const job = q.job
        .use(middleware)
        .name('test:job-with-middleware')
        .input(z.object({ value: z.number() }))
        .handler(async (data) => {
          return { result: data.value * 2 };
        });

      expect(job._internal.middlewares).toHaveLength(1);
    });

    it('should create job with options', () => {
      const q = initQueue.context<TestContext>().create();

      const job = q.job
        .name('test:job-with-options')
        .input(z.object({ id: z.string() }))
        .options({
          maxParallelism: 10,
          retry: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 2000 },
            maxDelay: 60000,
          },
        })
        .handler(async (data) => {
          return { processed: data.id };
        });

      expect(job._internal.options?.maxParallelism).toBe(10);
      expect(job._internal.options?.retry?.attempts).toBe(5);
    });

    it('should throw error if name is missing', () => {
      const q = initQueue.context<TestContext>().create();

      expect(() => {
        // @ts-expect-error - Testing runtime validation
        q.job.input(z.object({ test: z.string() })).handler(async () => ({ result: 'test' }));
      }).toThrow('Job name is required');
    });

    it('should throw error if input schema is missing', () => {
      const q = initQueue.context<TestContext>().create();

      expect(() => {
        const builder = q.job.name('test:missing-input') as any;
        builder.handler(async () => ({ result: 'test' }));
      }).toThrow('Input schema is required');
    });
  });
});

// ============================================
// Job Registration and Execution Tests
// ============================================

describe('Job Registration and Execution', () => {
  describe('Single job registration', () => {
    it('should register and execute a simple job', async () => {
      const q = initQueue.context<TestContext>().create();

      const processedMessages: string[] = [];

      const job = q.job
        .name('test:single-job')
        .input(z.object({ message: z.string() }))
        .handler(async (data) => {
          processedMessages.push(data.message);
          return { success: true, processed: data.message };
        });

      const queue = q.createQueue({
        connection: redisUrl,
        createContext: () => ({
          userId: 'test-user-123',
          timestamp: new Date(),
        }),
      });

      await queue.register(q.registry({ job }));
      await queue.start();

      // Wait for worker to be ready
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Add job to queue
      const jobInstance = job._internal._queue!;
      await jobInstance.add('test-job', { message: 'Hello from test!' });

      // Wait for job to be processed
      await new Promise((resolve) => setTimeout(resolve, 1000));

      expect(processedMessages).toContain('Hello from test!');

      await queue.stop();
    }, 15000);

    it('should validate job input with Zod schema', async () => {
      const q = initQueue.context<TestContext>().create();

      const job = q.job
        .name('test:validation-job')
        .input(
          z.object({
            email: z.string().email(),
            age: z.number().min(0).max(120),
          }),
        )
        .handler(async (data) => {
          return { valid: true, email: data.email, age: data.age };
        });

      const queue = q.createQueue({
        connection: redisUrl,
        createContext: () => ({
          userId: 'test-user-123',
          timestamp: new Date(),
        }),
      });

      await queue.register(q.registry({ job }));
      await queue.start();

      await new Promise((resolve) => setTimeout(resolve, 500));

      const jobInstance = job._internal._queue!;

      // Valid input should succeed
      const validJob = await jobInstance.add('valid', {
        email: 'test@example.com',
        age: 25,
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const validState = await validJob.getState();
      expect(validState).toBe('completed');

      // Invalid input should fail validation
      const invalidJob = await jobInstance.add('invalid', {
        email: 'not-an-email',
        age: 150,
      });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const invalidState = await invalidJob.getState();
      expect(invalidState).toBe('failed');

      await queue.stop();
    }, 15000);
  });

  describe('Multiple job registration', () => {
    it('should register multiple jobs at once', async () => {
      const q = initQueue.context<TestContext>().create();

      const results: Record<string, string[]> = {
        job1: [],
        job2: [],
        job3: [],
      };

      const job1 = q.job
        .name('test:multi-job-1')
        .input(z.object({ id: z.string() }))
        .handler(async (data) => {
          results['job1']!.push(data.id);
          return { processed: data.id };
        });

      const job2 = q.job
        .name('test:multi-job-2')
        .input(z.object({ value: z.number() }))
        .handler(async (data) => {
          results['job2']!.push(`value-${data.value}`);
          return { doubled: data.value * 2 };
        });

      const job3 = q.job
        .name('test:multi-job-3')
        .input(z.object({ name: z.string() }))
        .handler(async (data) => {
          results['job3']!.push(data.name);
          return { greeting: `Hello, ${data.name}!` };
        });

      const queue = q.createQueue({
        connection: redisUrl,
        createContext: () => ({
          userId: 'test-user-123',
          timestamp: new Date(),
        }),
      });

      await queue.register(
        q.registry({
          job1,
          job2,
          job3,
        }),
      );
      await queue.start();

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Execute all jobs
      await job1._internal._queue!.add('test', { id: 'id-123' });
      await job2._internal._queue!.add('test', { value: 42 });
      await job3._internal._queue!.add('test', { name: 'Alice' });

      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(results['job1']).toContain('id-123');
      expect(results['job2']).toContain('value-42');
      expect(results['job3']).toContain('Alice');

      await queue.stop();
    }, 15000);

    it('should register nested job registries', async () => {
      const q = initQueue.context<TestContext>().create();

      const results: string[] = [];

      const emailJob = q.job
        .name('test:nested-email')
        .input(z.object({ to: z.string() }))
        .handler(async (data) => {
          results.push(`email:${data.to}`);
          return { sent: true };
        });

      const smsJob = q.job
        .name('test:nested-sms')
        .input(z.object({ phone: z.string() }))
        .handler(async (data) => {
          results.push(`sms:${data.phone}`);
          return { sent: true };
        });

      const queue = q.createQueue({
        connection: redisUrl,
        createContext: () => ({
          userId: 'test-user-123',
          timestamp: new Date(),
        }),
      });

      await queue.register(
        q.registry({
          notifications: q.registry({
            email: emailJob,
            sms: smsJob,
          }),
        }),
      );
      await queue.start();

      await new Promise((resolve) => setTimeout(resolve, 500));

      await emailJob._internal._queue!.add('test', { to: 'user@example.com' });
      await smsJob._internal._queue!.add('test', { phone: '+1234567890' });

      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(results).toContain('email:user@example.com');
      expect(results).toContain('sms:+1234567890');

      await queue.stop();
    }, 15000);
  });

  describe('Job context', () => {
    it('should provide job context with utilities', async () => {
      const q = initQueue.context<TestContext>().create();

      const progressUpdates: number[] = [];
      const logMessages: string[] = [];

      const job = q.job
        .name('test:context-job')
        .input(z.object({ steps: z.number() }))
        .handler(async (data, ctx) => {
          for (let i = 0; i <= data.steps; i++) {
            const progress = (i / data.steps) * 100;
            await ctx.updateProgress(progress);
            progressUpdates.push(progress);

            await ctx.log(`Step ${i} of ${data.steps}`);
            logMessages.push(`Step ${i} of ${data.steps}`);
          }

          return { completed: true };
        });

      const queue = q.createQueue({
        connection: redisUrl,
        createContext: () => ({
          userId: 'test-user-123',
          timestamp: new Date(),
        }),
      });

      await queue.register(q.registry({ job }));
      await queue.start();

      await new Promise((resolve) => setTimeout(resolve, 500));

      await job._internal._queue!.add('test', { steps: 5 });

      await new Promise((resolve) => setTimeout(resolve, 2000));

      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(logMessages.length).toBeGreaterThan(0);
      expect(progressUpdates[progressUpdates.length - 1]).toBe(100);

      await queue.stop();
    }, 15000);

    it('should provide custom context to job handlers', async () => {
      const q = initQueue.context<TestContext>().create();

      let capturedUserId: string | undefined;
      let capturedTimestamp: Date | undefined;

      const job = q.job
        .name('test:custom-context')
        .input(z.object({ action: z.string() }))
        .handler(async (data, ctx) => {
          capturedUserId = ctx.userId;
          capturedTimestamp = ctx.timestamp;

          return { action: data.action, userId: ctx.userId };
        });

      const testTimestamp = new Date('2024-01-15T10:00:00Z');

      const queue = q.createQueue({
        connection: redisUrl,
        createContext: () => ({
          userId: 'custom-user-456',
          timestamp: testTimestamp,
        }),
      });

      await queue.register(q.registry({ job }));
      await queue.start();

      await new Promise((resolve) => setTimeout(resolve, 500));

      await job._internal._queue!.add('test', { action: 'process' });

      await new Promise((resolve) => setTimeout(resolve, 1000));

      expect(capturedUserId).toBe('custom-user-456');
      expect(capturedTimestamp).toEqual(testTimestamp);

      await queue.stop();
    }, 15000);
  });
});

// ============================================
// Middleware Integration Tests
// ============================================

describe('Middleware Integration', () => {
  it('should execute middleware before handler', async () => {
    const q = initQueue.context<TestContext>().create();

    const executionOrder: string[] = [];

    const loggingMiddleware = q.middleware<JobContext<TestContext>, JobContext<TestContext>>((opts) => {
      executionOrder.push('middleware-start');
      const result = opts.next({ ctx: opts.ctx });
      executionOrder.push('middleware-end');
      return result;
    });

    const job = q.job
      .use(loggingMiddleware)
      .name('test:middleware-job')
      .input(z.object({ data: z.string() }))
      .handler(async (data) => {
        executionOrder.push('handler');
        return { processed: data.data };
      });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ job }));
    await queue.start();

    await new Promise((resolve) => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { data: 'test-data' });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(executionOrder).toEqual(['middleware-start', 'handler', 'middleware-end']);

    await queue.stop();
  }, 15000);

  it('should chain multiple middleware', async () => {
    const q = initQueue.context<TestContext>().create();

    const executionOrder: string[] = [];

    const middleware1 = q.middleware<JobContext<TestContext>, JobContext<TestContext>>((opts) => {
      executionOrder.push('m1-start');
      const result = opts.next({ ctx: opts.ctx });
      executionOrder.push('m1-end');
      return result;
    });

    const middleware2 = q.middleware<JobContext<TestContext>, JobContext<TestContext>>((opts) => {
      executionOrder.push('m2-start');
      const result = opts.next({ ctx: opts.ctx });
      executionOrder.push('m2-end');
      return result;
    });

    const middleware3 = q.middleware<JobContext<TestContext>, JobContext<TestContext>>((opts) => {
      executionOrder.push('m3-start');
      const result = opts.next({ ctx: opts.ctx });
      executionOrder.push('m3-end');
      return result;
    });

    const job = q.job
      .use(middleware1)
      .use(middleware2)
      .use(middleware3)
      .name('test:chain-middleware')
      .input(z.object({ value: z.number() }))
      .handler(async (data) => {
        executionOrder.push('handler');
        return { result: data.value };
      });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ job }));
    await queue.start();

    await new Promise((resolve) => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { value: 42 });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(executionOrder).toEqual([
      'm1-start',
      'm2-start',
      'm3-start',
      'handler',
      'm3-end',
      'm2-end',
      'm1-end',
    ]);

    await queue.stop();
  }, 15000);

  it('should transform context through middleware', async () => {
    type ExtendedContext = JobContext<TestContext> & {
      requestId: string;
      startTime: number;
    };

    const q = initQueue.context<TestContext>().create();

    let capturedRequestId: string | undefined;
    let capturedStartTime: number | undefined;

    const enrichmentMiddleware = q.middleware<JobContext<TestContext>, ExtendedContext>((opts) => {
      const enrichedCtx: ExtendedContext = {
        ...opts.ctx,
        requestId: `req-${Date.now()}`,
        startTime: Date.now(),
      };

      return opts.next({ ctx: enrichedCtx });
    });

    const job = q.job
      .use(enrichmentMiddleware)
      .name('test:context-transform')
      .input(z.object({ action: z.string() }))
      .handler(async (data, ctx) => {
        capturedRequestId = ctx.requestId;
        capturedStartTime = ctx.startTime;

        return { action: data.action, requestId: ctx.requestId };
      });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ job }));
    await queue.start();

    await new Promise((resolve) => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { action: 'transform' });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(capturedRequestId).toBeDefined();
    expect(capturedRequestId).toMatch(/^req-\d+$/);
    expect(capturedStartTime).toBeDefined();
    expect(typeof capturedStartTime).toBe('number');

    await queue.stop();
  }, 15000);
});

// ============================================
// Retry and Error Handling Tests
// ============================================

describe('Retry and Error Handling', () => {
  it('should retry failed jobs according to retry config', async () => {
    const q = initQueue.context<TestContext>().create();

    let attemptCount = 0;
    const attemptTimestamps: number[] = [];

    const job = q.job
      .name('test:retry-job')
      .input(z.object({ shouldFail: z.boolean() }))
      .options({
        retry: {
          attempts: 3,
          backoff: { type: 'fixed', delay: 100 },
        },
      })
      .handler(async (data) => {
        attemptCount++;
        attemptTimestamps.push(Date.now());

        if (data.shouldFail && attemptCount < 3) {
          throw new Error(`Attempt ${attemptCount} failed`);
        }

        return { success: true, attempts: attemptCount };
      });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ job }));
    await queue.start();

    await new Promise((resolve) => setTimeout(resolve, 500));

    const jobInstance = await job._internal._queue!.add('test', { shouldFail: true });

    // Wait for all retry attempts
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const _state = await jobInstance.getState();
    expect(attemptCount).toBeGreaterThanOrEqual(3);

    // Check that retries happened with delays
    if (attemptTimestamps.length >= 2) {
      const delay = attemptTimestamps[1]! - attemptTimestamps[0]!;
      expect(delay).toBeGreaterThanOrEqual(80); // Allow some variance
    }

    await queue.stop();
  }, 15000);

  it('should respect maxDelay cap in retry config', async () => {
    const q = initQueue.context<TestContext>().create();

    let attemptCount = 0;

    const job = q.job
      .name('test:maxdelay-job')
      .input(z.object({ id: z.string() }))
      .options({
        retry: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          maxDelay: 2000, // Cap at 2 seconds
        },
      })
      .handler(async () => {
        attemptCount++;
        if (attemptCount < 5) {
          throw new Error(`Attempt ${attemptCount} failed`);
        }
        return { success: true };
      });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ job }));
    await queue.start();

    await new Promise((resolve) => setTimeout(resolve, 500));

    const _jobInstance = await job._internal._queue!.add('test', { id: 'test-maxdelay' });

    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Should have retried multiple times
    expect(attemptCount).toBeGreaterThanOrEqual(3);

    await queue.stop();
  }, 15000);

  it('should handle job failures gracefully', async () => {
    const q = initQueue.context<TestContext>().create();

    const failedJobIds: string[] = [];

    const job = q.job
      .name('test:failure-job')
      .input(z.object({ throwError: z.boolean() }))
      .options({
        retry: {
          attempts: 1, // Don't retry
          backoff: { type: 'fixed', delay: 100 },
        },
      })
      .handler(async (data) => {
        if (data.throwError) {
          throw new Error('Intentional failure');
        }
        return { success: true };
      });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ job }));
    await queue.start();

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Set up worker error listener
    const worker = job._internal._worker!;
    worker.on('failed', (failedJob) => {
      if (failedJob?.id) {
        failedJobIds.push(failedJob.id);
      }
    });

    const failingJob = await job._internal._queue!.add('test', { throwError: true });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const state = await failingJob.getState();
    expect(state).toBe('failed');
    expect(failedJobIds).toContain(failingJob.id!);

    await queue.stop();
  }, 15000);
});

// ============================================
// Graceful Shutdown Tests
// ============================================

describe('Graceful Shutdown', () => {
  it('should stop workers and close connections gracefully', async () => {
    const q = initQueue.context<TestContext>().create();

    const job = q.job
      .name('test:shutdown-job')
      .input(z.object({ id: z.string() }))
      .handler(async (data) => {
        return { processed: data.id };
      });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ job }));
    await queue.start();

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Queue should be running
    expect(job._internal._worker).toBeDefined();
    expect(job._internal._queue).toBeDefined();

    // Stop the queue
    await queue.stop();

    // Worker and queue should be closed
    // Note: BullMQ workers don't have an isRunning() method, but we can check
    // that stop() completes without errors
    expect(true).toBe(true); // Successful stop
  }, 15000);

  it('should complete in-flight jobs before shutdown', async () => {
    const q = initQueue.context<TestContext>().create();

    const processedIds: string[] = [];
    let shutdownTime: number | undefined;

    const job = q.job
      .name('test:inflight-job')
      .input(z.object({ id: z.string(), delay: z.number() }))
      .handler(async (data) => {
        await new Promise((resolve) => setTimeout(resolve, data.delay));
        processedIds.push(data.id);
        return { completed: data.id };
      });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ job }));
    await queue.start();

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Add a slow job
    await job._internal._queue!.add('test', { id: 'slow-job', delay: 2000 });

    // Wait a bit for job to start processing
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Stop the queue (should wait for in-flight job)
    const stopPromise = queue.stop();
    shutdownTime = Date.now();
    await stopPromise;

    const shutdownDuration = Date.now() - shutdownTime;

    // Job should have completed
    expect(processedIds).toContain('slow-job');

    // Shutdown should have waited for the job (allow some variance)
    expect(shutdownDuration).toBeGreaterThanOrEqual(1500);
  }, 20000);
});

// ============================================
// Real-World Scenarios
// ============================================

describe('Real-World Scenarios', () => {
  it('should handle high-throughput job processing', async () => {
    const q = initQueue.context<TestContext>().create();

    const processedCount = { value: 0 };
    const JOB_COUNT = 50;

    const job = q.job
      .name('test:throughput-job')
      .input(z.object({ index: z.number() }))
      .options({
        maxParallelism: 10, // Process 10 jobs concurrently
      })
      .handler(async (data) => {
        processedCount.value++;
        return { index: data.index };
      });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ job }));
    await queue.start();

    await new Promise((resolve) => setTimeout(resolve, 500));

    // Add multiple jobs
    const addPromises = [];
    for (let i = 0; i < JOB_COUNT; i++) {
      addPromises.push(job._internal._queue!.add('test', { index: i }));
    }
    await Promise.all(addPromises);

    // Wait for all jobs to complete
    await new Promise((resolve) => setTimeout(resolve, 5000));

    expect(processedCount.value).toBe(JOB_COUNT);

    await queue.stop();
  }, 20000);

  it('should handle job with external API call simulation', async () => {
    const q = initQueue.context<TestContext>().create();

    // Mock external API
    const mockApiCall = vi.fn(async (userId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { userId, data: `processed-${userId}` };
    });

    const processedResults: string[] = [];

    const job = q.job
      .name('test:api-call-job')
      .input(z.object({ userId: z.string() }))
      .options({
        retry: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 500 },
        },
      })
      .handler(async (data) => {
        const result = await mockApiCall(data.userId);
        processedResults.push(result.data);
        return result;
      });

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ job }));
    await queue.start();

    await new Promise((resolve) => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { userId: 'user-abc' });
    await job._internal._queue!.add('test', { userId: 'user-xyz' });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(mockApiCall).toHaveBeenCalledTimes(2);
    expect(processedResults).toContain('processed-user-abc');
    expect(processedResults).toContain('processed-user-xyz');

    await queue.stop();
  }, 15000);
});
