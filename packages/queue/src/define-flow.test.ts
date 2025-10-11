import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { defineFlow } from './define-flow';
import { defineJob } from './define-job';

describe('defineFlow', () => {
  // Helper jobs for testing
  const validateJob = defineJob({
    name: 'test:validate',
    schema: z.object({ orderId: z.string() }),
    handler: async data => ({ valid: true, orderId: data.orderId }),
  });

  const paymentJob = defineJob({
    name: 'test:payment',
    schema: z.object({ orderId: z.string(), amount: z.number() }),
    handler: async data => ({ charged: true, amount: data.amount }),
  });

  const inventoryJob = defineJob({
    name: 'test:inventory',
    schema: z.object({ orderId: z.string(), items: z.array(z.string()) }),
    handler: async data => ({ reserved: true, itemCount: data.items.length }),
  });

  const notifyJob = defineJob({
    name: 'test:notify',
    schema: z.object({ orderId: z.string(), message: z.string() }),
    handler: async data => ({ sent: true, message: data.message }),
  });

  describe('basic functionality', () => {
    it('should create a flow definition with required fields', () => {
      const flow = defineFlow({
        name: 'test:simple-flow',
        schema: z.object({ orderId: z.string() }),
        flow: input => [
          {
            id: 'validate',
            job: validateJob,
            data: input,
          },
        ],
      });

      expect(flow.name).toBe('test:simple-flow');
      expect(flow.schema).toBeDefined();
      expect(flow.flow).toBeDefined();
      expect(flow.options).toBeUndefined();
    });

    it('should create a flow with multiple steps', () => {
      const flow = defineFlow({
        name: 'test:multi-step',
        schema: z.object({ orderId: z.string() }),
        flow: input => [
          {
            id: 'validate',
            job: validateJob,
            data: input,
          },
          {
            id: 'payment',
            job: paymentJob,
            data: { orderId: input.orderId, amount: 100 },
          },
          {
            id: 'notify',
            job: notifyJob,
            data: { orderId: input.orderId, message: 'Order processed' },
          },
        ],
      });

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps).toHaveLength(3);
      expect(steps[0]!.id).toBe('validate');
      expect(steps[1]!.id).toBe('payment');
      expect(steps[2]!.id).toBe('notify');
    });

    it('should create a flow with dependencies', () => {
      const flow = defineFlow({
        name: 'test:dependencies',
        schema: z.object({ orderId: z.string() }),
        flow: input => [
          {
            id: 'validate',
            job: validateJob,
            data: input,
          },
          {
            id: 'payment',
            job: paymentJob,
            data: { orderId: input.orderId, amount: 100 },
            dependsOn: ['validate'],
          },
          {
            id: 'inventory',
            job: inventoryJob,
            data: { orderId: input.orderId, items: ['item1'] },
            dependsOn: ['payment'],
          },
        ],
      });

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps[1]!.dependsOn).toEqual(['validate']);
      expect(steps[2]!.dependsOn).toEqual(['payment']);
    });

    it('should support multiple dependencies (fan-in pattern)', () => {
      const flow = defineFlow({
        name: 'test:fan-in',
        schema: z.object({ orderId: z.string() }),
        flow: input => [
          {
            id: 'validate',
            job: validateJob,
            data: input,
          },
          {
            id: 'payment',
            job: paymentJob,
            data: { orderId: input.orderId, amount: 100 },
            dependsOn: ['validate'],
          },
          {
            id: 'inventory',
            job: inventoryJob,
            data: { orderId: input.orderId, items: ['item1'] },
            dependsOn: ['validate'],
          },
          {
            id: 'notify',
            job: notifyJob,
            data: { orderId: input.orderId, message: 'Complete' },
            dependsOn: ['payment', 'inventory'], // Waits for both
          },
        ],
      });

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps[3]!.dependsOn).toEqual(['payment', 'inventory']);
    });
  });

  describe('automatic type inference (with as const)', () => {
    it('should infer step IDs from flow definition with as const', () => {
      const flow = defineFlow({
        name: 'test:auto-inference',
        schema: z.object({ orderId: z.string() }),
        flow: input =>
          [
            {
              id: 'validate',
              job: validateJob,
              data: input,
            },
            {
              id: 'payment',
              job: paymentJob,
              data: { orderId: input.orderId, amount: 100 },
              dependsOn: ['validate'], // Should be type-safe with as const
            },
          ] as const,
      });

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps).toHaveLength(2);
      expect(steps[0]!.id).toBe('validate');
      expect(steps[1]!.id).toBe('payment');
      expect(steps[1]!.dependsOn).toEqual(['validate']);
    });

    it('should work with complex dependency graphs using as const', () => {
      const flow = defineFlow({
        name: 'test:complex-inference',
        schema: z.object({ orderId: z.string() }),
        flow: input =>
          [
            {
              id: 'step1',
              job: validateJob,
              data: input,
            },
            {
              id: 'step2',
              job: paymentJob,
              data: { orderId: input.orderId, amount: 100 },
              dependsOn: ['step1'],
            },
            {
              id: 'step3',
              job: inventoryJob,
              data: { orderId: input.orderId, items: [] },
              dependsOn: ['step1'],
            },
            {
              id: 'step4',
              job: notifyJob,
              data: { orderId: input.orderId, message: 'Done' },
              dependsOn: ['step2', 'step3'],
            },
          ] as const,
      });

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps).toHaveLength(4);
    });
  });

  describe('explicit type parameter', () => {
    it('should work with explicit step ID type', () => {
      type OrderSteps = 'validate' | 'payment' | 'inventory' | 'notify';

      const flow = defineFlow<{ orderId: string }, OrderSteps>({
        name: 'test:explicit-type',
        schema: z.object({ orderId: z.string() }),
        flow: input => [
          {
            id: 'validate',
            job: validateJob,
            data: input,
          },
          {
            id: 'payment',
            job: paymentJob,
            data: { orderId: input.orderId, amount: 100 },
            dependsOn: ['validate'], // Type-safe with explicit type parameter
          },
        ],
      });

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps).toHaveLength(2);
    });
  });

  describe('flow options', () => {
    it('should accept flow options', () => {
      const flow = defineFlow({
        name: 'test:options',
        schema: z.object({ orderId: z.string() }),
        flow: input => [
          {
            id: 'validate',
            job: validateJob,
            data: input,
          },
        ],
        options: {
          defaultJobOptions: {
            removeOnComplete: true,
            attempts: 3,
          },
          prefix: 'custom-prefix',
        },
      });

      expect(flow.options?.defaultJobOptions?.removeOnComplete).toBe(true);
      expect(flow.options?.defaultJobOptions?.attempts).toBe(3);
      expect(flow.options?.prefix).toBe('custom-prefix');
    });
  });

  describe('step options', () => {
    it('should accept job options per step', () => {
      const flow = defineFlow({
        name: 'test:step-options',
        schema: z.object({ orderId: z.string() }),
        flow: input => [
          {
            id: 'validate',
            job: validateJob,
            data: input,
            opts: {
              priority: 1,
              attempts: 5,
            },
          },
        ],
      });

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps[0]!.opts?.priority).toBe(1);
      expect(steps[0]!.opts?.attempts).toBe(5);
    });

    it('should accept custom queue names per step', () => {
      const flow = defineFlow({
        name: 'test:custom-queues',
        schema: z.object({ orderId: z.string() }),
        flow: input => [
          {
            id: 'validate',
            job: validateJob,
            queueName: 'high-priority-queue',
            data: input,
          },
          {
            id: 'payment',
            job: paymentJob,
            queueName: 'payment-queue',
            data: { orderId: input.orderId, amount: 100 },
          },
        ],
      });

      const steps = flow.flow({ orderId: 'order_123' });
      expect(steps[0]!.queueName).toBe('high-priority-queue');
      expect(steps[1]!.queueName).toBe('payment-queue');
    });
  });

  describe('schema validation', () => {
    it('should work with simple schema', () => {
      const flow = defineFlow({
        name: 'test:simple-schema',
        schema: z.string(),
        flow: input => [
          {
            id: 'process',
            job: notifyJob,
            data: { orderId: input, message: 'Processing' },
          },
        ],
      });

      expect(flow.schema.parse('order_123')).toBe('order_123');
    });

    it('should work with complex nested schema', () => {
      const flow = defineFlow({
        name: 'test:complex-schema',
        schema: z.object({
          order: z.object({
            id: z.string(),
            customer: z.object({
              id: z.string(),
              email: z.string().email(),
            }),
          }),
          items: z.array(
            z.object({
              sku: z.string(),
              quantity: z.number(),
            }),
          ),
        }),
        flow: input => [
          {
            id: 'validate',
            job: validateJob,
            data: { orderId: input.order.id },
          },
        ],
      });

      const validData = {
        order: {
          id: 'order_123',
          customer: {
            id: 'customer_456',
            email: 'test@example.com',
          },
        },
        items: [
          { sku: 'SKU001', quantity: 2 },
          { sku: 'SKU002', quantity: 1 },
        ],
      };

      expect(flow.schema.parse(validData)).toEqual(validData);
    });
  });

  describe('flow execution', () => {
    it('should generate steps based on input data', () => {
      const flow = defineFlow({
        name: 'test:dynamic-steps',
        schema: z.object({
          orderId: z.string(),
          items: z.array(z.string()),
        }),
        flow: input => [
          {
            id: 'validate',
            job: validateJob,
            data: { orderId: input.orderId },
          },
          {
            id: 'inventory',
            job: inventoryJob,
            data: { orderId: input.orderId, items: input.items },
            dependsOn: ['validate'],
          },
        ],
      });

      const steps = flow.flow({
        orderId: 'order_123',
        items: ['item1', 'item2', 'item3'],
      });

      expect(steps).toHaveLength(2);
      expect(steps[1]!.data).toEqual({
        orderId: 'order_123',
        items: ['item1', 'item2', 'item3'],
      });
    });

    it('should support conditional step generation', () => {
      const flow = defineFlow({
        name: 'test:conditional',
        schema: z.object({
          orderId: z.string(),
          requiresPayment: z.boolean(),
        }),
        flow: input => {
          const steps = [
            {
              id: 'validate' as const,
              job: validateJob,
              data: { orderId: input.orderId },
            },
          ];

          if (input.requiresPayment) {
            steps.push({
              id: 'payment' as const,
              job: paymentJob,
              data: { orderId: input.orderId, amount: 100 },
              dependsOn: ['validate'] as const,
            });
          }

          steps.push({
            id: 'notify' as const,
            job: notifyJob,
            data: { orderId: input.orderId, message: 'Done' },
            dependsOn: input.requiresPayment ? (['payment'] as const) : (['validate'] as const),
          });

          return steps;
        },
      });

      // With payment
      const stepsWithPayment = flow.flow({
        orderId: 'order_123',
        requiresPayment: true,
      });
      expect(stepsWithPayment).toHaveLength(3);
      expect(stepsWithPayment[1]!.id).toBe('payment');

      // Without payment
      const stepsWithoutPayment = flow.flow({
        orderId: 'order_456',
        requiresPayment: false,
      });
      expect(stepsWithoutPayment).toHaveLength(2);
      expect(stepsWithoutPayment[1]!.id).toBe('notify');
    });
  });

  describe('parallel execution patterns', () => {
    it('should support parallel steps (fan-out)', () => {
      const flow = defineFlow({
        name: 'test:fan-out',
        schema: z.object({ orderId: z.string() }),
        flow: input => [
          {
            id: 'validate',
            job: validateJob,
            data: input,
          },
          // These two run in parallel after validate
          {
            id: 'payment',
            job: paymentJob,
            data: { orderId: input.orderId, amount: 100 },
            dependsOn: ['validate'],
          },
          {
            id: 'inventory',
            job: inventoryJob,
            data: { orderId: input.orderId, items: ['item1'] },
            dependsOn: ['validate'],
          },
        ],
      });

      const steps = flow.flow({ orderId: 'order_123' });

      // Both payment and inventory depend only on validate
      // They should run in parallel
      expect(steps[1]!.dependsOn).toEqual(['validate']);
      expect(steps[2]!.dependsOn).toEqual(['validate']);
    });
  });

  describe('naming conventions', () => {
    it('should accept various naming patterns', () => {
      const patterns = [
        'orders:process-complex',
        'payments:multi-step-verification',
        'notifications:batch-send',
        'data:etl-pipeline',
      ];

      patterns.forEach(name => {
        const flow = defineFlow({
          name,
          schema: z.object({}),
          flow: () => [],
        });

        expect(flow.name).toBe(name);
      });
    });
  });

  describe('type inference', () => {
    it('should infer input type from schema', () => {
      const flow = defineFlow({
        name: 'test:inference',
        schema: z.object({
          orderId: z.string(),
          amount: z.number(),
          items: z.array(z.string()),
        }),
        flow: input => {
          // TypeScript should infer input correctly
          const orderId: string = input.orderId;
          const amount: number = input.amount;
          const items: string[] = input.items;

          return [
            {
              id: 'validate',
              job: validateJob,
              data: { orderId },
            },
          ];
        },
      });

      expect(flow.name).toBe('test:inference');
    });
  });
});
