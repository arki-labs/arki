/**
 * Integration tests for middleware execution chain
 *
 * Tests the complete middleware functionality including:
 * - Middleware execution order (onion: the handler runs inside every next())
 * - Context transformation
 * - Async middleware operations
 * - Error handling
 * - Real-world middleware patterns
 */
import type { Job as BullMQJob, Queue } from 'bullmq';
import type { StartedTestContainer } from 'testcontainers';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { z } from '@arki/contracts';
import { backoff } from '@arki/resilience';

import type { JobContext } from './types/job.ts';
import { initQueue } from './init.ts';

// Test context types
type BaseContext = {
  userId: string;
  timestamp: Date;
};

type ExtendedContext = JobContext<BaseContext> & {
  requestId: string;
  startTime: number;
};

type AuthContext = JobContext<BaseContext> & {
  authenticated: boolean;
  permissions: string[];
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
}, 60_000);

afterAll(async () => {
  if (redisContainer) {
    await redisContainer.stop();
    console.log('✓ Redis container stopped');
  }
}, 30_000);

// ============================================
// Basic Middleware Execution Tests
// ============================================

describe('Basic Middleware Execution', () => {
  it('should execute single middleware', async () => {
    const q = initQueue.context<BaseContext>().create();

    const executionLog: string[] = [];

    const middleware = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(opts => {
      executionLog.push('middleware-executed');
      return opts.next({ ctx: opts.ctx });
    });

    const job = q.job
      .use(middleware)
      .name('test-single-middleware')
      .input(z.object({ value: z.number() }))
      .handler(async data => {
        executionLog.push('handler-executed');
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

    await new Promise(resolve => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { value: 42 });

    await new Promise(resolve => setTimeout(resolve, 1000));

    expect(executionLog).toContain('middleware-executed');
    expect(executionLog).toContain('handler-executed');
    expect(executionLog.indexOf('middleware-executed')).toBeLessThan(executionLog.indexOf('handler-executed'));

    await queue.stop();
  }, 15_000);

  it('should execute middleware chain in order', async () => {
    const q = initQueue.context<BaseContext>().create();

    const executionOrder: string[] = [];

    const middleware1 = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(opts => {
      executionOrder.push('m1-start');
      const result = opts.next({ ctx: opts.ctx });
      executionOrder.push('m1-end');
      return result;
    });

    const middleware2 = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(opts => {
      executionOrder.push('m2-start');
      const result = opts.next({ ctx: opts.ctx });
      executionOrder.push('m2-end');
      return result;
    });

    const middleware3 = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(opts => {
      executionOrder.push('m3-start');
      const result = opts.next({ ctx: opts.ctx });
      executionOrder.push('m3-end');
      return result;
    });

    const job = q.job
      .use(middleware1)
      .use(middleware2)
      .use(middleware3)
      .name('test-chain-order')
      .input(z.object({ value: z.number() }))
      .handler(async () => {
        executionOrder.push('handler');
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

    await new Promise(resolve => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { value: 1 });

    await new Promise(resolve => setTimeout(resolve, 1000));

    expect(executionOrder).toEqual(['m1-start', 'm2-start', 'm3-start', 'handler', 'm3-end', 'm2-end', 'm1-end']);

    await queue.stop();
  }, 15_000);

  it('should execute middleware without calling next (early return)', async () => {
    const q = initQueue.context<BaseContext>().create();

    const executionLog: string[] = [];

    const shortCircuitMiddleware = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(async opts => {
      executionLog.push('short-circuit');
      // Don't call opts.next() - early return
      return { ctx: opts.ctx };
    });

    const laterMiddleware = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(opts => {
      executionLog.push('later-middleware');
      return opts.next({ ctx: opts.ctx });
    });

    const job = q.job
      .use(shortCircuitMiddleware)
      .use(laterMiddleware)
      .name('test-short-circuit')
      .input(z.object({ value: z.number() }))
      .handler(async () => {
        executionLog.push('handler');
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

    await new Promise(resolve => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { value: 1 });

    await new Promise(resolve => setTimeout(resolve, 1000));

    expect(executionLog).toContain('short-circuit');
    // Later middleware and handler should not execute
    expect(executionLog).not.toContain('later-middleware');
    expect(executionLog).not.toContain('handler');

    await queue.stop();
  }, 15_000);
});

// ============================================
// Context Transformation Tests
// ============================================

describe('Context Transformation', () => {
  it('should transform context through middleware', async () => {
    const q = initQueue.context<BaseContext>().create();

    let capturedRequestId: string | undefined;
    let capturedStartTime: number | undefined;

    const enrichmentMiddleware = q.middleware<JobContext<BaseContext>, ExtendedContext>(opts => {
      const enrichedCtx: ExtendedContext = {
        ...opts.ctx,
        requestId: `req-${Date.now()}`,
        startTime: Date.now(),
      };

      return opts.next({ ctx: enrichedCtx });
    });

    const job = q.job
      .use(enrichmentMiddleware)
      .name('test-context-transform')
      .input(z.object({ value: z.number() }))
      .handler(async (data, ctx) => {
        capturedRequestId = ctx.requestId;
        capturedStartTime = ctx.startTime;

        return { value: data.value, requestId: ctx.requestId };
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

    await new Promise(resolve => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { value: 42 });

    await new Promise(resolve => setTimeout(resolve, 1000));

    expect(capturedRequestId).toBeDefined();
    expect(capturedRequestId).toMatch(/^req-\d+$/);
    expect(capturedStartTime).toBeDefined();
    expect(typeof capturedStartTime).toBe('number');

    await queue.stop();
  }, 15_000);

  it('should chain context transformations', async () => {
    type Step1Context = JobContext<BaseContext> & { step1: string };
    type Step2Context = Step1Context & { step2: number };
    type Step3Context = Step2Context & { step3: boolean };

    const q = initQueue.context<BaseContext>().create();

    let capturedContext: Partial<Step3Context> = {};

    const middleware1 = q.middleware<JobContext<BaseContext>, Step1Context>(opts => {
      return opts.next({ ctx: { ...opts.ctx, step1: 'added-by-m1' } });
    });

    const middleware2 = q.middleware<Step1Context, Step2Context>(opts => {
      return opts.next({ ctx: { ...opts.ctx, step2: 42 } });
    });

    const middleware3 = q.middleware<Step2Context, Step3Context>(opts => {
      return opts.next({ ctx: { ...opts.ctx, step3: true } });
    });

    const job = q.job
      .use(middleware1)
      .use(middleware2)
      .use(middleware3)
      .name('test-chain-transform')
      .input(z.object({ value: z.number() }))
      .handler(async (data, ctx) => {
        capturedContext = ctx;
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

    await new Promise(resolve => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { value: 1 });

    await new Promise(resolve => setTimeout(resolve, 1000));

    expect(capturedContext.step1).toBe('added-by-m1');
    expect(capturedContext.step2).toBe(42);
    expect(capturedContext.step3).toBe(true);

    await queue.stop();
  }, 15_000);

  it('should access original context in middleware', async () => {
    const q = initQueue.context<BaseContext>().create();

    let capturedUserId: string | undefined;
    let capturedTimestamp: Date | undefined;

    const middleware = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(opts => {
      capturedUserId = opts.ctx.userId;
      capturedTimestamp = opts.ctx.timestamp;

      return opts.next({ ctx: opts.ctx });
    });

    const job = q.job
      .use(middleware)
      .name('test-original-context')
      .input(z.object({ value: z.number() }))
      .handler(async () => ({ result: 1 }));

    const testTimestamp = new Date('2024-01-15T10:00:00Z');

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'original-user-456',
        timestamp: testTimestamp,
      }),
    });

    await queue.register(q.registry({ job }));
    await queue.start();

    await new Promise(resolve => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { value: 1 });

    await new Promise(resolve => setTimeout(resolve, 1000));

    expect(capturedUserId).toBe('original-user-456');
    expect(capturedTimestamp).toEqual(testTimestamp);

    await queue.stop();
  }, 15_000);
});

// ============================================
// Async Middleware Tests
// ============================================

describe('Async Middleware Operations', () => {
  it('should handle async middleware operations', async () => {
    const q = initQueue.context<BaseContext>().create();

    const mockAsyncOperation = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { apiData: 'fetched' };
    });

    let capturedData: { apiData: string } | undefined;

    const asyncMiddleware = q.middleware<JobContext<BaseContext>, JobContext<BaseContext> & { apiData: string }>(
      async opts => {
        const result = await mockAsyncOperation();

        return opts.next({
          ctx: {
            ...opts.ctx,
            apiData: result.apiData,
          },
        });
      },
    );

    const job = q.job
      .use(asyncMiddleware)
      .name('test-async-middleware')
      .input(z.object({ value: z.number() }))
      .handler(async (data, ctx) => {
        capturedData = { apiData: ctx.apiData };
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

    await new Promise(resolve => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { value: 1 });

    await new Promise(resolve => setTimeout(resolve, 1500));

    expect(mockAsyncOperation).toHaveBeenCalled();
    expect(capturedData).toEqual({ apiData: 'fetched' });

    await queue.stop();
  }, 15_000);

  it('should handle multiple async middleware in sequence', async () => {
    const q = initQueue.context<BaseContext>().create();

    const executionOrder: string[] = [];

    const asyncMiddleware1 = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(async opts => {
      executionOrder.push('async1-start');
      await new Promise(resolve => setTimeout(resolve, 50));
      executionOrder.push('async1-middle');
      const result = await opts.next({ ctx: opts.ctx });
      executionOrder.push('async1-end');
      return result;
    });

    const asyncMiddleware2 = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(async opts => {
      executionOrder.push('async2-start');
      await new Promise(resolve => setTimeout(resolve, 50));
      executionOrder.push('async2-middle');
      const result = await opts.next({ ctx: opts.ctx });
      executionOrder.push('async2-end');
      return result;
    });

    const job = q.job
      .use(asyncMiddleware1)
      .use(asyncMiddleware2)
      .name('test-async-sequence')
      .input(z.object({ value: z.number() }))
      .handler(async () => {
        executionOrder.push('handler');
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

    await new Promise(resolve => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { value: 1 });

    await new Promise(resolve => setTimeout(resolve, 2000));

    expect(executionOrder).toEqual([
      'async1-start',
      'async1-middle',
      'async2-start',
      'async2-middle',
      'handler',
      'async2-end',
      'async1-end',
    ]);

    await queue.stop();
  }, 15_000);
});

// ============================================
// Real-World Middleware Patterns
// ============================================

describe('Real-World Middleware Patterns', () => {
  it('should implement logging middleware', async () => {
    const q = initQueue.context<BaseContext>().create();

    const logs: { level: string; message: string; data?: unknown }[] = [];

    const loggingMiddleware = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(async opts => {
      const startTime = Date.now();

      logs.push({
        level: 'info',
        message: 'Job started',
        data: { userId: opts.ctx.userId, jobData: opts.data },
      });

      try {
        const result = await opts.next({ ctx: opts.ctx });

        const duration = Date.now() - startTime;
        logs.push({
          level: 'info',
          message: 'Job completed',
          data: { duration },
        });

        return result;
      } catch (error) {
        logs.push({
          level: 'error',
          message: 'Job failed',
          data: { error: error instanceof Error ? error.message : 'Unknown error' },
        });
        throw error;
      }
    });

    const job = q.job
      .use(loggingMiddleware)
      .name('test-logging-middleware')
      .input(z.object({ taskId: z.string() }))
      .handler(async data => {
        return { taskId: data.taskId, completed: true };
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

    await new Promise(resolve => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { taskId: 'task-123' });

    await new Promise(resolve => setTimeout(resolve, 1500));

    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0]!.message).toBe('Job started');
    expect(logs.at(-1)!.message).toBe('Job completed');

    await queue.stop();
  }, 15_000);

  it('should implement timing middleware', async () => {
    const q = initQueue.context<BaseContext>().create();

    const timings: { jobName: string; duration: number }[] = [];

    const timingMiddleware = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(async opts => {
      const startTime = Date.now();

      const result = await opts.next({ ctx: opts.ctx });

      const duration = Date.now() - startTime;
      timings.push({
        jobName: opts.job.name,
        duration,
      });

      return result;
    });

    const job = q.job
      .use(timingMiddleware)
      .name('test-timing-middleware')
      .input(z.object({ delay: z.number() }))
      .handler(async data => {
        await new Promise(resolve => setTimeout(resolve, data.delay));
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

    await new Promise(resolve => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { delay: 200 });

    await new Promise(resolve => setTimeout(resolve, 1500));

    expect(timings.length).toBe(1);
    expect(timings[0]!.duration).toBeGreaterThanOrEqual(180);

    await queue.stop();
  }, 15_000);

  it('should implement authentication middleware', async () => {
    const q = initQueue.context<BaseContext>().create();

    let wasAuthenticated = false;
    let capturedPermissions: string[] = [];

    const authMiddleware = q.middleware<JobContext<BaseContext>, AuthContext>(opts => {
      const authCtx: AuthContext = {
        ...opts.ctx,
        authenticated: true,
        permissions: ['read', 'write', 'delete'],
      };

      return opts.next({ ctx: authCtx });
    });

    const job = q.job
      .use(authMiddleware)
      .name('test-auth-middleware')
      .input(z.object({ action: z.string() }))
      .handler(async (data, ctx) => {
        wasAuthenticated = ctx.authenticated;
        capturedPermissions = ctx.permissions;

        return { action: data.action, authorized: true };
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

    await new Promise(resolve => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { action: 'delete' });

    await new Promise(resolve => setTimeout(resolve, 1000));

    expect(wasAuthenticated).toBe(true);
    expect(capturedPermissions).toEqual(['read', 'write', 'delete']);

    await queue.stop();
  }, 15_000);

  it('should implement validation middleware', async () => {
    const q = initQueue.context<BaseContext>().create();

    const validationErrors: string[] = [];
    const processedValues: number[] = [];

    const validationMiddleware = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(async opts => {
      const data = opts.data as { value: number };

      // Validate business rules
      if (data.value < 0) {
        validationErrors.push('Value must be positive');
        // Short-circuit - don't call next()
        return { ctx: opts.ctx };
      }

      if (data.value > 1000) {
        validationErrors.push('Value must be less than 1000');
        return { ctx: opts.ctx };
      }

      // Valid - continue
      return opts.next({ ctx: opts.ctx });
    });

    const job = q.job
      .use(validationMiddleware)
      .name('test-validation-middleware')
      .input(z.object({ value: z.number() }))
      .handler(async data => {
        processedValues.push(data.value);
        return { processed: true };
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

    await new Promise(resolve => setTimeout(resolve, 500));

    // Valid value
    await job._internal._queue!.add('valid', { value: 50 });
    // Invalid values
    await job._internal._queue!.add('negative', { value: -10 });
    await job._internal._queue!.add('too-large', { value: 2000 });

    await new Promise(resolve => setTimeout(resolve, 2000));

    expect(processedValues).toEqual([50]); // Only valid value processed
    expect(validationErrors.length).toBeGreaterThanOrEqual(2);

    await queue.stop();
  }, 15_000);
});

// ============================================
// Error Handling in Middleware
// ============================================

describe('Error Handling in Middleware', () => {
  it('should propagate errors from middleware', async () => {
    const q = initQueue.context<BaseContext>().create();

    const errorMiddleware = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(async () => {
      throw new Error('Middleware error');
    });

    const job = q.job
      .use(errorMiddleware)
      .name('test-error-middleware')
      .input(z.object({ value: z.number() }))
      .options({
        retry: backoff.constant(100).upTo(0),
      })
      .handler(async () => {
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

    await new Promise(resolve => setTimeout(resolve, 500));

    const jobInstance = await job._internal._queue!.add('test', { value: 1 });

    await new Promise(resolve => setTimeout(resolve, 1500));

    const state = await jobInstance.getState();
    expect(state).toBe('failed');

    await queue.stop();
  }, 15_000);

  it('should handle errors gracefully in middleware try-catch', async () => {
    const q = initQueue.context<BaseContext>().create();

    const errorLog: string[] = [];
    let handlerExecuted = false;

    const errorHandlingMiddleware = q.middleware<JobContext<BaseContext>, JobContext<BaseContext>>(async opts => {
      try {
        throw new Error('Simulated error');
      } catch (error) {
        errorLog.push(error instanceof Error ? error.message : 'Unknown error');
        // Continue despite error
        return opts.next({ ctx: opts.ctx });
      }
    });

    const job = q.job
      .use(errorHandlingMiddleware)
      .name('test-error-handling')
      .input(z.object({ value: z.number() }))
      .handler(async () => {
        handlerExecuted = true;
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

    await new Promise(resolve => setTimeout(resolve, 500));

    await job._internal._queue!.add('test', { value: 1 });

    await new Promise(resolve => setTimeout(resolve, 1000));

    expect(errorLog).toContain('Simulated error');
    expect(handlerExecuted).toBe(true);

    await queue.stop();
  }, 15_000);
});

// ============================================
// Onion Order: middleware wraps the handler
// ============================================

/** Add one job and wait until its worker has finished with it. */
async function runToEnd(queue: Queue, name: string, data: unknown): Promise<BullMQJob> {
  const added = await queue.add(name, data);
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await added.getState();
    if (state === 'completed' || state === 'failed') {
      const settled = await queue.getJob(added.id ?? '');
      if (!settled) throw new Error(`Job ${added.id} disappeared`);
      return settled;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Job ${added.id} did not finish`);
}

describe('Onion order (middleware wraps the handler)', () => {
  const createContext = () => ({ userId: 'onion-user', timestamp: new Date() });

  it('runs mw1-before, mw2-before, handler, mw2-after, mw1-after', async () => {
    const q = initQueue.context<BaseContext>().create();
    const order: string[] = [];

    const tracing = (label: string) =>
      q.middleware(async ({ next }) => {
        order.push(`${label}-before`);
        try {
          return await next();
        } finally {
          order.push(`${label}-after`);
        }
      });

    const job = q.job
      .use(tracing('mw1'))
      .use(tracing('mw2'))
      .name('onion-order')
      .input(z.object({}))
      .handler(async () => {
        // Yield first: an `after` that ran before the handler finished would land here.
        await new Promise(resolve => setTimeout(resolve, 50));
        order.push('handler');
      });

    const queue = q.createQueue({ connection: redisUrl, createContext });
    await queue.register(q.registry({ job }));
    await queue.start();

    const settled = await runToEnd(job._internal._queue!, 'onion-order', {});

    expect(settled.finishedOn).toBeDefined();
    expect(order).toEqual(['mw1-before', 'mw2-before', 'handler', 'mw2-after', 'mw1-after']);

    await queue.stop();
  }, 15_000);

  it('rejects a middleware next() with the handler error, so its catch sees it', async () => {
    const q = initQueue.context<BaseContext>().create();
    const caught: string[] = [];

    const catching = q.middleware(async ({ next }) => {
      try {
        return await next();
      } catch (error) {
        caught.push(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });

    const job = q.job
      .use(catching)
      .name('onion-error')
      .input(z.object({}))
      .options({ retry: backoff.constant(10).upTo(0) })
      .handler(async () => {
        throw new Error('handler failed');
      });

    const queue = q.createQueue({ connection: redisUrl, createContext });
    await queue.register(q.registry({ job }));
    await queue.start();

    const settled = await runToEnd(job._internal._queue!, 'onion-error', {});

    expect(caught).toEqual(['handler failed']);
    expect(JSON.parse(settled.failedReason)).toMatchObject({ code: 'failure.unexpected_defect' });

    await queue.stop();
  }, 15_000);

  it('lets a middleware see the handler result, and the job returns it', async () => {
    const q = initQueue.context<BaseContext>().create();
    const seen: unknown[] = [];

    const observing = q.middleware(async ({ next }) => {
      const result = await next();
      seen.push(result.output);
      return result;
    });

    const job = q.job
      .use(observing)
      .name('onion-result')
      .input(z.object({ a: z.number(), b: z.number() }))
      .handler(async data => ({ sum: data.a + data.b }));

    const queue = q.createQueue({ connection: redisUrl, createContext });
    await queue.register(q.registry({ job }));
    await queue.start();

    const settled = await runToEnd(job._internal._queue!, 'onion-result', { a: 1, b: 2 });

    expect(seen).toEqual([{ sum: 3 }]);
    expect(settled.returnvalue).toEqual({ sum: 3 });

    await queue.stop();
  }, 15_000);

  it('passes the context from next({ ctx }) to the handler', async () => {
    const q = initQueue.context<BaseContext>().create();
    const handlerTraceIds: string[] = [];

    const withTrace = q.middleware<JobContext<BaseContext>, JobContext<BaseContext> & { traceId: string }>(
      ({ ctx, next }) => next({ ctx: { ...ctx, traceId: 'trace-1' } }),
    );

    const job = q.job
      .use(withTrace)
      .name('onion-context')
      .input(z.object({}))
      .handler(async (_data, ctx) => {
        handlerTraceIds.push(ctx.traceId);
      });

    const queue = q.createQueue({ connection: redisUrl, createContext });
    await queue.register(q.registry({ job }));
    await queue.start();

    await runToEnd(job._internal._queue!, 'onion-context', {});

    expect(handlerTraceIds).toEqual(['trace-1']);

    await queue.stop();
  }, 15_000);
});
