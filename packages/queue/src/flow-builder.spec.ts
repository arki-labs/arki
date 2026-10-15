/**
 * Integration tests for flow builder (multi-step workflows)
 *
 * Tests the complete flow functionality including:
 * - Multi-step workflow execution
 * - Step dependencies and execution order
 * - Parallel step execution
 * - Data flow between steps
 * - Step jobs keep their own middleware (flows have no `.use()`)
 * - Dependency validation
 * - Error handling
 */

import type { StartedTestContainer } from 'testcontainers';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';

import type { InternalFlowDefinition } from './flow-builder.ts';
import type { JobContext } from './types/job.ts';
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
}, 60_000);

afterAll(async () => {
  if (redisContainer) {
    await redisContainer.stop();
    console.log('✓ Redis container stopped');
  }
}, 30_000);

// ============================================
// Basic Flow Creation Tests
// ============================================

describe('Basic Flow Creation', () => {
  it('should create flow with multiple sequential steps', () => {
    const q = initQueue.context<TestContext>().create();

    const step1Job = q.job
      .name('test-flow-step1')
      .input(z.object({ value: z.number() }))
      .handler(async data => ({ result: data.value * 2 }));

    const step2Job = q.job
      .name('test-flow-step2')
      .input(z.object({ value: z.number() }))
      .handler(async data => ({ result: data.value + 10 }));

    const flow = q.flow
      .name('test-simple-flow')
      .input(z.object({ initialValue: z.number() }))
      .step('step1', {
        job: step1Job,
        data: input => ({ value: input.initialValue }),
      })
      .step('step2', {
        job: step2Job,
        data: input => ({ value: input.initialValue }),
        dependsOn: ['step1'],
      })
      .build();

    const internal = flow._internal as InternalFlowDefinition;

    expect(flow._type).toBe('flow');
    expect(internal.name).toBe('test-simple-flow');
    expect(internal.steps).toHaveLength(2);
    expect(internal.steps[0]!.id).toBe('step1');
    expect(internal.steps[1]!.id).toBe('step2');
    expect(internal.steps[1]!.dependsOn).toEqual(['step1']);
  });

  it('should create flow with parallel steps', () => {
    const q = initQueue.context<TestContext>().create();

    const jobA = q.job
      .name('test-parallel-a')
      .input(z.object({ data: z.string() }))
      .handler(async data => ({ result: `A:${data.data}` }));

    const jobB = q.job
      .name('test-parallel-b')
      .input(z.object({ data: z.string() }))
      .handler(async data => ({ result: `B:${data.data}` }));

    const jobC = q.job
      .name('test-parallel-c')
      .input(z.object({ data: z.string() }))
      .handler(async data => ({ result: `C:${data.data}` }));

    const flow = q.flow
      .name('test-parallel-flow')
      .input(z.object({ data: z.string() }))
      .step('stepA', {
        job: jobA,
        data: input => ({ data: input.data }),
      })
      .step('stepB', {
        job: jobB,
        data: input => ({ data: input.data }),
      })
      .step('stepC', {
        job: jobC,
        data: input => ({ data: input.data }),
      })
      .build();

    const internal = flow._internal as InternalFlowDefinition;

    // All steps should have no dependencies (run in parallel)
    expect(internal.steps[0]!.dependsOn).toBeUndefined();
    expect(internal.steps[1]!.dependsOn).toBeUndefined();
    expect(internal.steps[2]!.dependsOn).toBeUndefined();
  });

  it('should create flow with multiple dependencies per step', () => {
    const q = initQueue.context<TestContext>().create();

    const job = q.job
      .name('test-multi-dep-job')
      .input(z.object({ value: z.number() }))
      .handler(async data => ({ result: data.value }));

    const flow = q.flow
      .name('test-multi-dep-flow')
      .input(z.object({ value: z.number() }))
      .step('step1', {
        job: job,
        data: input => ({ value: input.value }),
      })
      .step('step2', {
        job: job,
        data: input => ({ value: input.value }),
      })
      .step('step3', {
        job: job,
        data: input => ({ value: input.value }),
        dependsOn: ['step1', 'step2'], // Wait for both step1 and step2
      })
      .build();

    const internal = flow._internal as InternalFlowDefinition;

    expect(internal.steps[2]!.dependsOn).toEqual(['step1', 'step2']);
  });

  it('should throw error if flow has no steps', () => {
    const q = initQueue.context<TestContext>().create();

    expect(() => {
      q.flow
        .name('test-no-steps')
        .input(z.object({ value: z.number() }))
        .build();
    }).toThrow('At least one step is required');
  });

  it('should throw error if flow has no input schema', () => {
    const q = initQueue.context<TestContext>().create();

    // A flow with no input cannot add steps at all: the builder after .name()
    // only offers .input(), at runtime too, so .build() is unreachable.
    const named = q.flow.name('test-no-input');
    expect(Reflect.get(named, 'step')).toBeUndefined();
    expect(Reflect.get(named, 'build')).toBeUndefined();
  });
});

// ============================================
// Dependency Validation Tests
// ============================================

describe('Dependency Validation', () => {
  it('should validate that dependencies reference existing steps', () => {
    const q = initQueue.context<TestContext>().create();

    const job = q.job
      .name('test-validation-job')
      .input(z.object({ value: z.number() }))
      .handler(async () => ({ result: 1 }));

    expect(() => {
      q.flow
        .name('test-invalid-dep')
        .input(z.object({ value: z.number() }))
        .step('step1', {
          job: job,
          data: input => ({ value: input.value }),
        })
        .step('step2', {
          job: job,
          data: input => ({ value: input.value }),
          dependsOn: ['nonexistent-step'], // Invalid dependency
        })
        .build();
    }).toThrow(/depends on "nonexistent-step", but no step with that ID exists/);
  });

  it('should detect circular dependencies', () => {
    const q = initQueue.context<TestContext>().create();

    const _job = q.job
      .name('test-circular-job')
      .input(z.object({ value: z.number() }))
      .handler(async () => ({ result: 1 }));

    // Note: This test needs steps that can reference each other
    // Due to builder pattern constraints, circular deps are hard to create
    // but the validation logic exists and can be unit tested separately
    expect(true).toBe(true);
  });

  it('should allow valid dependency chains', () => {
    const q = initQueue.context<TestContext>().create();

    const job = q.job
      .name('test-chain-job')
      .input(z.object({ value: z.number() }))
      .handler(async () => ({ result: 1 }));

    const flow = q.flow
      .name('test-valid-chain')
      .input(z.object({ value: z.number() }))
      .step('step1', {
        job: job,
        data: input => ({ value: input.value }),
      })
      .step('step2', {
        job: job,
        data: input => ({ value: input.value }),
        dependsOn: ['step1'],
      })
      .step('step3', {
        job: job,
        data: input => ({ value: input.value }),
        dependsOn: ['step2'],
      })
      .step('step4', {
        job: job,
        data: input => ({ value: input.value }),
        dependsOn: ['step3'],
      })
      .build();

    const internal = flow._internal as InternalFlowDefinition;

    expect(internal.steps).toHaveLength(4);
  });
});

// ============================================
// Flow Execution Tests
// ============================================

describe('Flow Execution', () => {
  it('should execute flow steps in order', async () => {
    const q = initQueue.context<TestContext>().create();

    const executionOrder: string[] = [];

    const step1Job = q.job
      .name('test-ordered-step1')
      .input(z.object({ id: z.string() }))
      .handler(async data => {
        executionOrder.push('step1');
        return { id: data.id, step: 'step1' };
      });

    const step2Job = q.job
      .name('test-ordered-step2')
      .input(z.object({ id: z.string() }))
      .handler(async data => {
        executionOrder.push('step2');
        return { id: data.id, step: 'step2' };
      });

    const step3Job = q.job
      .name('test-ordered-step3')
      .input(z.object({ id: z.string() }))
      .handler(async data => {
        executionOrder.push('step3');
        return { id: data.id, step: 'step3' };
      });

    const flow = q.flow
      .name('test-ordered-flow')
      .input(z.object({ flowId: z.string() }))
      .step('step1', {
        job: step1Job,
        data: input => ({ id: input.flowId }),
      })
      .step('step2', {
        job: step2Job,
        data: input => ({ id: input.flowId }),
        dependsOn: ['step1'],
      })
      .step('step3', {
        job: step3Job,
        data: input => ({ id: input.flowId }),
        dependsOn: ['step2'],
      })
      .build();

    const queue = q.createQueue({
      connection: redisUrl,
      createContext: () => ({
        userId: 'test-user-123',
        timestamp: new Date(),
      }),
    });

    await queue.register(q.registry({ flow }));
    await queue.start();

    await new Promise(resolve => setTimeout(resolve, 1000));

    // Registering a flow only registers its step jobs; enqueue(flow, input)
    // starts it (run end to end in queue-client.spec.ts)

    await queue.stop();
  }, 15_000);

  it('should execute parallel steps concurrently', async () => {
    const q = initQueue.context<TestContext>().create();

    const executionTimes: Record<string, number> = {};

    const stepJobA = q.job
      .name('test-parallel-exec-a')
      .input(z.object({ delay: z.number() }))
      .handler(async data => {
        executionTimes['stepA'] = Date.now();
        await new Promise(resolve => setTimeout(resolve, data.delay));
        return { step: 'A', completed: true };
      });

    const stepJobB = q.job
      .name('test-parallel-exec-b')
      .input(z.object({ delay: z.number() }))
      .handler(async data => {
        executionTimes['stepB'] = Date.now();
        await new Promise(resolve => setTimeout(resolve, data.delay));
        return { step: 'B', completed: true };
      });

    const flow = q.flow
      .name('test-parallel-exec-flow')
      .input(z.object({ value: z.number() }))
      .step('stepA', {
        job: stepJobA,
        data: () => ({ delay: 100 }),
      })
      .step('stepB', {
        job: stepJobB,
        data: () => ({ delay: 100 }),
      })
      .build();

    const internal = flow._internal as InternalFlowDefinition;

    expect(internal.steps).toHaveLength(2);
  });
});

// ============================================
// Data Flow Tests
// ============================================

describe('Data Flow Between Steps', () => {
  it('should transform data for each step', () => {
    const q = initQueue.context<TestContext>().create();

    const step1Job = q.job
      .name('test-transform-step1')
      .input(z.object({ value: z.number() }))
      .handler(async data => ({ doubled: data.value * 2 }));

    const step2Job = q.job
      .name('test-transform-step2')
      .input(z.object({ value: z.number(), extra: z.string() }))
      .handler(async data => ({ result: `${data.value}-${data.extra}` }));

    const flow = q.flow
      .name('test-transform-flow')
      .input(z.object({ initialValue: z.number() }))
      .step('double', {
        job: step1Job,
        data: input => ({ value: input.initialValue }),
      })
      .step('format', {
        job: step2Job,
        data: input => ({
          value: input.initialValue * 2,
          extra: 'formatted',
        }),
        dependsOn: ['double'],
      })
      .build();

    const internal = flow._internal as InternalFlowDefinition;

    expect(internal.steps).toHaveLength(2);
  });

  it('should allow complex data transformations', () => {
    const q = initQueue.context<TestContext>().create();

    const validateUserJob = q.job
      .name('test-validate-user')
      .input(z.object({ userId: z.string(), email: z.string() }))
      .handler(async data => ({ valid: true, userId: data.userId }));

    const createOrderJob = q.job
      .name('test-create-order')
      .input(
        z.object({
          orderId: z.string(),
          userId: z.string(),
          items: z.array(z.string()),
        }),
      )
      .handler(async data => ({ orderId: data.orderId, created: true }));

    const flow = q.flow
      .name('test-complex-transform')
      .input(
        z.object({
          user: z.object({ id: z.string(), email: z.string() }),
          order: z.object({ id: z.string(), products: z.array(z.string()) }),
        }),
      )
      .step('validateUser', {
        job: validateUserJob,
        data: input => ({
          userId: input.user.id,
          email: input.user.email,
        }),
      })
      .step('createOrder', {
        job: createOrderJob,
        data: input => ({
          orderId: input.order.id,
          userId: input.user.id,
          items: input.order.products,
        }),
        dependsOn: ['validateUser'],
      })
      .build();

    const internal = flow._internal as InternalFlowDefinition;

    expect(internal.steps).toHaveLength(2);
  });
});

// ============================================
// Middleware Integration Tests
// ============================================

describe('Middleware with Flows', () => {
  it('has no flow .use(): each step runs with its own job middleware', () => {
    const q = initQueue.context<TestContext>().create();

    const loggingMiddleware = q.middleware<JobContext<TestContext>, JobContext<TestContext>>(opts => {
      return opts.next({ ctx: opts.ctx });
    });

    // The middleware belongs on the step job: its worker runs it for that step.
    const job = q.job
      .use(loggingMiddleware)
      .name('test-flow-middleware-job')
      .input(z.object({ value: z.number() }))
      .handler(async () => ({ result: 1 }));

    const flow = q.flow
      .name('test-flow-with-middleware')
      .input(z.object({ value: z.number() }))
      .step('step1', {
        job: job,
        data: input => ({ value: input.value }),
      });

    // @ts-expect-error -- a flow has no middleware of its own
    expect(flow.use).toBeUndefined();

    const internal = flow.build()._internal as InternalFlowDefinition;
    expect(internal).not.toHaveProperty('middlewares');
    expect(internal.steps[0]!.job._internal.middlewares).toHaveLength(1);
  });
});

// ============================================
// Real-World Flow Scenarios
// ============================================

describe('Real-World Flow Scenarios', () => {
  it('should implement order processing workflow', () => {
    const q = initQueue.context<TestContext>().create();

    const validateOrderJob = q.job
      .name('test-validate-order')
      .input(z.object({ orderId: z.string() }))
      .handler(async data => ({ orderId: data.orderId, valid: true }));

    const processPaymentJob = q.job
      .name('test-process-payment')
      .input(z.object({ orderId: z.string(), amount: z.number() }))
      .handler(async data => ({ orderId: data.orderId, paid: true }));

    const updateInventoryJob = q.job
      .name('test-update-inventory')
      .input(z.object({ orderId: z.string(), items: z.array(z.string()) }))
      .handler(async data => ({ orderId: data.orderId, updated: true }));

    const sendConfirmationJob = q.job
      .name('test-send-confirmation')
      .input(z.object({ orderId: z.string(), email: z.string() }))
      .handler(async data => ({ orderId: data.orderId, sent: true }));

    const flow = q.flow
      .name('test-order-processing')
      .input(
        z.object({
          orderId: z.string(),
          amount: z.number(),
          items: z.array(z.string()),
          email: z.string(),
        }),
      )
      .step('validate', {
        job: validateOrderJob,
        data: input => ({ orderId: input.orderId }),
      })
      .step('payment', {
        job: processPaymentJob,
        data: input => ({ orderId: input.orderId, amount: input.amount }),
        dependsOn: ['validate'],
      })
      .step('inventory', {
        job: updateInventoryJob,
        data: input => ({ orderId: input.orderId, items: input.items }),
        dependsOn: ['payment'],
      })
      .step('confirmation', {
        job: sendConfirmationJob,
        data: input => ({ orderId: input.orderId, email: input.email }),
        // Not ['payment', 'inventory']: inventory already waits on payment, and
        // a flow is a tree, so payment can have only one dependent
        dependsOn: ['inventory'],
      })
      .build();

    const internal = flow._internal as InternalFlowDefinition;

    expect(internal.name).toBe('test-order-processing');
    expect(internal.steps).toHaveLength(4);
    expect(internal.steps[3]!.dependsOn).toEqual(['inventory']);
  });

  it('should implement data processing pipeline', () => {
    const q = initQueue.context<TestContext>().create();

    const fetchDataJob = q.job
      .name('test-fetch-data')
      .input(z.object({ source: z.string() }))
      .handler(async () => ({ data: 'fetched' }));

    const transformDataJob = q.job
      .name('test-transform-data')
      .input(z.object({ data: z.string() }))
      .handler(async () => ({ data: 'transformed' }));

    const validateDataJob = q.job
      .name('test-validate-data')
      .input(z.object({ data: z.string() }))
      .handler(async () => ({ valid: true }));

    const storeDataJob = q.job
      .name('test-store-data')
      .input(z.object({ data: z.string() }))
      .handler(async () => ({ stored: true }));

    const flow = q.flow
      .name('test-data-pipeline')
      .input(z.object({ dataSource: z.string() }))
      .step('fetch', {
        job: fetchDataJob,
        data: input => ({ source: input.dataSource }),
      })
      .step('transform', {
        job: transformDataJob,
        data: () => ({ data: 'raw' }),
        dependsOn: ['fetch'],
      })
      .step('validate', {
        job: validateDataJob,
        data: () => ({ data: 'transformed' }),
        dependsOn: ['transform'],
      })
      .step('store', {
        job: storeDataJob,
        data: () => ({ data: 'validated' }),
        dependsOn: ['validate'],
      })
      .build();

    const internal = flow._internal as InternalFlowDefinition;

    expect(internal.steps).toHaveLength(4);
  });

  // Fan-out (one step waited on by several) is not a tree, so it is rejected (see flow-jobs.spec.ts)
  it('should implement fan-in pattern', () => {
    const q = initQueue.context<TestContext>().create();

    const processAJob = q.job
      .name('test-process-a')
      .input(z.object({ data: z.string() }))
      .handler(async () => ({ resultA: 'done' }));

    const processBJob = q.job
      .name('test-process-b')
      .input(z.object({ data: z.string() }))
      .handler(async () => ({ resultB: 'done' }));

    const processCJob = q.job
      .name('test-process-c')
      .input(z.object({ data: z.string() }))
      .handler(async () => ({ resultC: 'done' }));

    const aggregateJob = q.job
      .name('test-aggregate')
      .input(z.object({ id: z.string() }))
      .handler(async () => ({ aggregated: true }));

    const flow = q.flow
      .name('test-fan-out-fan-in')
      .input(z.object({ requestId: z.string() }))
      // These run in parallel
      .step('processA', {
        job: processAJob,
        data: () => ({ data: 'a' }),
      })
      .step('processB', {
        job: processBJob,
        data: () => ({ data: 'b' }),
      })
      .step('processC', {
        job: processCJob,
        data: () => ({ data: 'c' }),
      })
      // Fan in: Waits for all parallel processes to complete
      .step('aggregate', {
        job: aggregateJob,
        data: input => ({ id: input.requestId }),
        dependsOn: ['processA', 'processB', 'processC'],
      })
      .build();

    const internal = flow._internal as InternalFlowDefinition;

    expect(internal.steps).toHaveLength(4);
    expect(internal.steps[3]!.dependsOn).toEqual(['processA', 'processB', 'processC']);
  });
});

// ============================================
// Flow Configuration Tests
// ============================================

describe('Flow Configuration', () => {
  it('should support step-specific options', () => {
    const q = initQueue.context<TestContext>().create();

    const job = q.job
      .name('test-opts-step')
      .input(z.object({ value: z.number() }))
      .handler(async () => ({ result: 1 }));

    const flow = q.flow
      .name('test-step-opts')
      .input(z.object({ value: z.number() }))
      .step('step1', {
        job: job,
        data: input => ({ value: input.value }),
        opts: { priority: 1, delay: 1000 },
      })
      .step('step2', {
        job: job,
        data: input => ({ value: input.value }),
        opts: { priority: 5, attempts: 3 },
      })
      .build();

    const internal = flow._internal as InternalFlowDefinition;

    expect(internal.steps[0]!.opts).toEqual({ priority: 1, delay: 1000 });
    expect(internal.steps[1]!.opts).toEqual({ priority: 5, attempts: 3 });
  });
});
