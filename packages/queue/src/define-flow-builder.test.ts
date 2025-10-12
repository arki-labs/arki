import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { buildFlow } from './define-flow-builder';
import { defineJob } from './define-job';

describe('buildFlow (Builder Pattern)', () => {
  // Helper jobs for testing
  const validateJob = defineJob({
    name: 'test:validate',
    inputSchema: z.object({ orderId: z.string() }),
    handler: async data => ({ valid: true, orderId: data.orderId }),
  });

  const paymentJob = defineJob({
    name: 'test:payment',
    inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
    handler: async data => ({ charged: true, amount: data.amount }),
  });

  const inventoryJob = defineJob({
    name: 'test:inventory',
    inputSchema: z.object({ orderId: z.string(), items: z.array(z.string()) }),
    handler: async data => ({ reserved: true, itemCount: data.items.length }),
  });

  const notifyJob = defineJob({
    name: 'test:notify',
    inputSchema: z.object({ orderId: z.string(), message: z.string() }),
    handler: async data => ({ sent: true, message: data.message }),
  });

  describe('basic functionality', () => {
    it('should create a flow definition with a single step', () => {
      const flow = buildFlow('test:simple-flow', z.object({ orderId: z.string() }))
        .step('validate', {
          job: validateJob,
          data: input => input,
        })
        .build();

      expect(flow.name).toBe('test:simple-flow');
      expect(flow.inputSchema).toBeDefined();
      expect(flow.flow).toBeDefined();
      expect(flow.options).toBeUndefined();

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps).toHaveLength(1);
      expect(steps[0]!.id).toBe('validate');
    });

    it('should create a flow with multiple steps', () => {
      const flow = buildFlow('test:multi-step', z.object({ orderId: z.string() }))
        .step('validate', {
          job: validateJob,
          data: input => input,
        })
        .step('payment', {
          job: paymentJob,
          data: input => ({ orderId: input.orderId, amount: 100 }),
        })
        .step('notify', {
          job: notifyJob,
          data: input => ({ orderId: input.orderId, message: 'Order processed' }),
        })
        .build();

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps).toHaveLength(3);
      expect(steps[0]!.id).toBe('validate');
      expect(steps[1]!.id).toBe('payment');
      expect(steps[2]!.id).toBe('notify');
    });

    it('should create a flow with dependencies', () => {
      const flow = buildFlow('test:dependencies', z.object({ orderId: z.string() }))
        .step('validate', {
          job: validateJob,
          data: input => input,
        })
        .step('payment', {
          job: paymentJob,
          data: input => ({ orderId: input.orderId, amount: 100 }),
          dependsOn: ['validate'],
        })
        .step('inventory', {
          job: inventoryJob,
          data: input => ({ orderId: input.orderId, items: ['item1'] }),
          dependsOn: ['payment'],
        })
        .build();

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps[1]!.dependsOn).toEqual(['validate']);
      expect(steps[2]!.dependsOn).toEqual(['payment']);
    });

    it('should support multiple dependencies (fan-in pattern)', () => {
      const flow = buildFlow('test:fan-in', z.object({ orderId: z.string() }))
        .step('validate', {
          job: validateJob,
          data: input => input,
        })
        .step('payment', {
          job: paymentJob,
          data: input => ({ orderId: input.orderId, amount: 100 }),
          dependsOn: ['validate'],
        })
        .step('inventory', {
          job: inventoryJob,
          data: input => ({ orderId: input.orderId, items: ['item1'] }),
          dependsOn: ['validate'],
        })
        .step('notify', {
          job: notifyJob,
          data: input => ({ orderId: input.orderId, message: 'Complete' }),
          dependsOn: ['payment', 'inventory'], // Waits for both
        })
        .build();

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps[3]!.dependsOn).toEqual(['payment', 'inventory']);
    });
  });

  describe('type safety', () => {
    it('should provide type-safe dependency references', () => {
      const flow = buildFlow('test:type-safe', z.object({ orderId: z.string() }))
        .step('validate', {
          job: validateJob,
          data: input => input,
        })
        .step('payment', {
          job: paymentJob,
          data: input => ({ orderId: input.orderId, amount: 100 }),
          // TypeScript should only allow 'validate' here
          dependsOn: ['validate'],
        })
        .build();

      expect(flow.name).toBe('test:type-safe');
    });

    it('should evaluate data functions with input', () => {
      const flow = buildFlow('test:data-eval', z.object({ orderId: z.string(), amount: z.number() }))
        .step('payment', {
          job: paymentJob,
          data: input => ({ orderId: input.orderId, amount: input.amount }),
        })
        .build();

      const steps = flow.flow({ orderId: 'order_123', amount: 50 });
      expect(steps[0]!.data).toEqual({ orderId: 'order_123', amount: 50 });
    });
  });

  describe('flow options', () => {
    it('should accept flow options', () => {
      const flow = buildFlow(
        'test:options',
        z.object({ orderId: z.string() }),
        {
          defaultJobOptions: {
            removeOnComplete: true,
            attempts: 3,
          },
          prefix: 'custom-prefix',
        },
      )
        .step('validate', {
          job: validateJob,
          data: input => input,
        })
        .build();

      expect(flow.options?.defaultJobOptions?.removeOnComplete).toBe(true);
      expect(flow.options?.defaultJobOptions?.attempts).toBe(3);
      expect(flow.options?.prefix).toBe('custom-prefix');
    });
  });

  describe('step options', () => {
    it('should accept job options per step', () => {
      const flow = buildFlow('test:step-options', z.object({ orderId: z.string() }))
        .step('validate', {
          job: validateJob,
          data: input => input,
          opts: {
            priority: 1,
            attempts: 5,
          },
        })
        .build();

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps[0]!.opts?.priority).toBe(1);
      expect(steps[0]!.opts?.attempts).toBe(5);
    });

    it('should accept custom queue names per step', () => {
      const flow = buildFlow('test:custom-queues', z.object({ orderId: z.string() }))
        .step('validate', {
          job: validateJob,
          queueName: 'high-priority-queue',
          data: input => input,
        })
        .step('payment', {
          job: paymentJob,
          queueName: 'payment-queue',
          data: input => ({ orderId: input.orderId, amount: 100 }),
        })
        .build();

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps[0]!.queueName).toBe('high-priority-queue');
      expect(steps[1]!.queueName).toBe('payment-queue');
    });
  });

  describe('parallel execution patterns', () => {
    it('should support parallel steps (fan-out)', () => {
      const flow = buildFlow('test:fan-out', z.object({ orderId: z.string() }))
        .step('validate', {
          job: validateJob,
          data: input => input,
        })
        // These two run in parallel after validate
        .step('payment', {
          job: paymentJob,
          data: input => ({ orderId: input.orderId, amount: 100 }),
          dependsOn: ['validate'],
        })
        .step('inventory', {
          job: inventoryJob,
          data: input => ({ orderId: input.orderId, items: ['item1'] }),
          dependsOn: ['validate'],
        })
        .build();

      const steps = flow.flow({ orderId: 'order_123' });

      // Both payment and inventory depend only on validate
      // They should run in parallel
      expect(steps[1]!.dependsOn).toEqual(['validate']);
      expect(steps[2]!.dependsOn).toEqual(['validate']);
    });
  });
});
