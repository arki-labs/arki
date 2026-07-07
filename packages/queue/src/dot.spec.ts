import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { initQueue } from './init.ts';
import { project } from './projection.ts';
import { queueConsumerActions, queueProducerActions } from './dot.ts';

const q = initQueue.create();

const sendEmail = q.job
  .name('email:send')
  .input(z.object({ to: z.string() }))
  .handler(async () => ({ ok: true }));

const resizeImage = q.job
  .name('image:resize')
  .input(z.object({ imageId: z.string() }))
  .handler(async () => ({ ok: true }));

const registry = q.registry({
  notifications: q.registry({ sendEmail }),
  image: q.registry({ resizeImage }),
});

describe('queue DOT topology actions', () => {
  it('creates inbound consumer and outbound producer actions from nested registries', () => {
    expect(queueConsumerActions(registry).map(action => `${action.direction}:${action.id}`)).toEqual([
      'in:email:send.consume',
      'in:image:resize.consume',
    ]);
    expect(queueProducerActions(registry).map(action => `${action.direction}:${action.id}`)).toEqual([
      'out:email:send.produce',
      'out:image:resize.produce',
    ]);
  });

  it('projects queue topology by queue name', () => {
    const actions = [...queueConsumerActions(registry), ...queueProducerActions(registry)].map(action => ({
      ...action,
      pip: 'queue-runtime',
    }));

    expect(
      project({
        app: { name: 'queue-app' },
        actions,
      }),
    ).toEqual({
      format: 'queue-topology',
      queues: [
        {
          name: 'email:send',
          consumers: [{ id: 'email:send.consume', pip: 'queue-runtime' }],
          producers: [{ id: 'email:send.produce', pip: 'queue-runtime' }],
        },
        {
          name: 'image:resize',
          consumers: [{ id: 'image:resize.consume', pip: 'queue-runtime' }],
          producers: [{ id: 'image:resize.produce', pip: 'queue-runtime' }],
        },
      ],
    });
  });
});
