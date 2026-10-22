/** An incomplete acknowledgement never authorizes replay of accepted business effects. */
import type * as BullMQ from 'bullmq';
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';

import { z } from '@arki/contracts';

import type { FlowEnqueueFailure } from './flow-jobs.ts';
import type { FlowEnqueueResult } from './types/builder.ts';
import { initQueue } from './init.ts';
import { createQueueClient } from './queue-client.ts';
import { QueueAcceptanceUnknown } from './errors.ts';

const addBulk = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock('bullmq', async original => ({
  ...(await original<typeof BullMQ>()),
  FlowProducer: class {
    addBulk = addBulk;
    close() {
      return Promise.resolve();
    }
  },
}));
afterEach(() => addBulk.mockReset());

const q = initQueue.create();
const job = q.job.name('ack.job').input(z.string()).handler(() => Promise.resolve('done'));
const flow = q.flow
  .name('ack.flow')
  .input(z.string())
  .step('child', { job, data: input => input })
  .step('__proto__', { job, data: input => input, dependsOn: ['child'] })
  .build();
const child = { job: { id: 'child-id', name: 'ack.job', queueName: 'ack.job' } };
const root = { job: { id: 'root-id', name: 'ack.job', queueName: 'ack.job' }, children: [child] };

it.each([
  undefined,
  null,
  {},
  [],
  [undefined],
  [null],
  [{}],
  [{ ...root, job: {} }],
  [{ ...root, job: { ...root.job, id: '' } }],
  [{ ...root, job: { ...root.job, id: 12 } }],
  [{ ...root, job: { ...root.job, name: 'wrong' } }],
  [{ ...root, job: { ...root.job, queueName: 'wrong' } }],
  [{ ...root, children: undefined }],
  [{ ...root, children: null }],
  [{ ...root, children: [] }],
  [{ ...root, children: [child, child] }],
  [{ ...root, children: [{ ...child, children: [child] }] }],
  [root, root],
  [{ get job() { throw new Error('private acknowledgement defect'); } }],
])('returns uncertainty for malformed acknowledgement %# without resubmitting', async acknowledgement => {
  addBulk.mockResolvedValue(acknowledgement);
  const handle = createQueueClient({ connection: 'redis://127.0.0.1:1' });
  try {
    const result = await handle.client.enqueue(flow, 'input');
    expectTypeOf(result).toEqualTypeOf<FlowEnqueueResult | FlowEnqueueFailure>();
    expect(QueueAcceptanceUnknown.is(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private acknowledgement defect');
    expect(addBulk).toHaveBeenCalledTimes(1);
  } finally {
    await handle.close();
  }
});

it('returns every confirmed opaque ID, including prototype-named steps', async () => {
  addBulk.mockResolvedValue([root]);
  const handle = createQueueClient({ connection: 'redis://127.0.0.1:1' });
  try {
    const result = await handle.client.enqueue(flow, 'input');
    expect(result).toEqual({ flow: 'ack.flow', jobIds: { ['__proto__']: 'root-id', child: 'child-id' } });
    expect(addBulk).toHaveBeenCalledTimes(1);
  } finally {
    await handle.close();
  }
});
