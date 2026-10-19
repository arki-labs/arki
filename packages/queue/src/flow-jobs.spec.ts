/**
 * T(flow-tree): a flow becomes BullMQ flow jobs, without Redis.
 * Why it matters: BullMQ flows are trees. A child job has exactly one parent,
 * and a parent runs only after all its children. So the builder must reject a
 * step that two steps wait on (BullMQ cannot run it once for both), and the
 * tree it hands BullMQ must put every step in the queue its job's worker
 * reads, with the job's own retry defaults (a FlowProducer never applies
 * queue defaults). Starting a flow must validate its input before anything
 * reaches Redis.
 */
import { describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';
import { InvalidInput } from '@arki/failure';
import { backoff } from '@arki/resilience';

import { QUEUE_DEFINITION_ERROR_CODES, QueueDefinitionError } from './errors.ts';
import { toFlowJobs } from './flow-jobs.ts';
import { initQueue } from './init.ts';
import { createQueueClient } from './queue-client.ts';

const q = initQueue.context<{ readonly app: string }>().create();
const orderInput = z.object({ orderId: z.string() });

const validateJob = q.job
  .name('orders.validate')
  .input(orderInput)
  .handler(() => Promise.resolve('valid'));
const reserveJob = q.job
  .name('orders.reserve')
  .input(z.object({ orderId: z.string(), hold: z.boolean() }))
  .handler(() => Promise.resolve('reserved'));
const paymentJob = q.job
  .name('orders.payment')
  .input(orderInput)
  .options({ retry: backoff.exponential({ base: 1000 }).upTo(6) })
  .handler(() => Promise.resolve('paid'));
const notifyJob = q.job
  .name('orders.notify')
  .input(z.object({ to: z.string() }))
  .handler(() => Promise.resolve('sent'));

/** The README flow: validate and reserve in parallel, then payment, then notify. */
const orderFlow = q.flow
  .name('orders:process')
  .input(orderInput)
  .step('validate', { job: validateJob, data: input => ({ orderId: input.orderId }) })
  .step('reserve', { job: reserveJob, data: input => ({ orderId: input.orderId, hold: true }) })
  .step('payment', {
    job: paymentJob,
    data: input => ({ orderId: input.orderId }),
    dependsOn: ['validate', 'reserve'],
    opts: { priority: 2 },
  })
  .step('notify', {
    job: notifyJob,
    data: input => ({ to: `buyer-of-${input.orderId}` }),
    dependsOn: ['payment'],
  })
  .build();

/** The old README flow: inventory and notify both wait on payment. Not a tree. */
function buildFanOutFlow() {
  return q.flow
    .name('orders:fan-out')
    .input(orderInput)
    .step('payment', { job: paymentJob, data: input => input })
    .step('inventory', { job: validateJob, data: input => input, dependsOn: ['payment'] })
    .step('notify', { job: notifyJob, data: input => ({ to: input.orderId }), dependsOn: ['payment'] })
    .build();
}

describe('flow builder: flows are trees', () => {
  it('rejects a step that two steps depend on, with ARKI_QUEUE_E017', () => {
    expect(buildFanOutFlow).toThrow(QueueDefinitionError);
    try {
      buildFanOutFlow();
    } catch (error) {
      if (!(error instanceof QueueDefinitionError)) throw error;
      expect(error.code).toBe(QUEUE_DEFINITION_ERROR_CODES.stepWithManyDependents);
      expect(error.message).toContain('"payment"');
      expect(error.remediation).toMatch(/chain/i);
      expect(error.remediation).toMatch(/two flows/);
    }
  });
});

describe('toFlowJobs', () => {
  it('nests the README flow as one tree, children before parents, in the jobs own queues', () => {
    const jobs = toFlowJobs(orderFlow, { orderId: 'o-1' });

    expect(jobs).toHaveLength(1);
    const [notify] = jobs;
    expect(notify).toMatchObject({ name: 'orders.notify', queueName: 'orders.notify', data: { to: 'buyer-of-o-1' } });

    const [payment] = notify?.children ?? [];
    expect(payment).toMatchObject({ queueName: 'orders.payment', data: { orderId: 'o-1' } });
    expect(notify?.children).toHaveLength(1);

    const children = payment?.children ?? [];
    expect(children.map(child => child.queueName)).toEqual(['orders.validate', 'orders.reserve']);
    expect(children.map(child => child.data)).toEqual([{ orderId: 'o-1' }, { orderId: 'o-1', hold: true }]);
    expect(children.every(child => child.children === undefined)).toBe(true);
  });

  it("carries each job's retry defaults, under the step's own options", () => {
    const [notify] = toFlowJobs(orderFlow, { orderId: 'o-1' });
    const payment = notify?.children?.[0];

    // The job declared 7 attempts; a FlowProducer would otherwise default to 1
    expect(payment?.opts).toMatchObject({ attempts: 7, priority: 2 });
    // A job with no retry options gets the same default its queue applies to enqueue(job)
    expect(notify?.opts).toMatchObject({ attempts: 3 });
  });

  it('makes every step with no dependent its own root', () => {
    const twoRoots = q.flow
      .name('orders:two-roots')
      .input(orderInput)
      .step('validate', { job: validateJob, data: input => input })
      .step('notify', { job: notifyJob, data: input => ({ to: input.orderId }) })
      .build();

    expect(toFlowJobs(twoRoots, { orderId: 'o-2' }).map(job => job.queueName)).toEqual([
      'orders.validate',
      'orders.notify',
    ]);
  });
});

describe('enqueue(flow, input)', () => {
  it('rejects input that fails the flow schema with ARKI_QUEUE_E018, before touching Redis', async () => {
    // Port 1 has no Redis: an attempt to connect would fail differently
    const handle = createQueueClient({ connection: 'redis://127.0.0.1:1' });
    try {
      // @ts-expect-error the input type is inferred from the flow: orderId is a string
      const started = handle.client.enqueue(orderFlow, { orderId: 42 });
      await expect(started).resolves.toMatchObject({ code: InvalidInput.code });
    } finally {
      await handle.close();
    }
  });
});
