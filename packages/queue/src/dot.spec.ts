import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { DotLifecycleErrorCode } from '@arki/dot/pip';
import { pip, service } from '@arki/dot/pip';

import { initQueue } from './init.ts';
import { project } from './projection.ts';
import { QUEUE_PIP_ERROR_CODES, queueConsumerActions, queueProducerActions, queueRuntime } from './dot.ts';

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

type Dependency = {
  readonly name: string;
};

const dependency = pip({
  name: 'dependency',
  boot: () => ({ dependency: { name: 'test-dependency' } satisfies Dependency }),
});

function wait(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

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

  it('queueRuntime declares queue actions and the queue topology projection', () => {
    const app = defineApp('queue-app')
      .use(dependency)
      .use(
        queueRuntime({
          needs: { dependency: service<Dependency>() },
          registry,
          start: async () => ({ stop: async () => {} }),
        }),
      )
      .configure();

    expect(app.manifest.actions.map(action => `${action.direction}:${action.id}`)).toEqual([
      'in:email:send.consume',
      'in:image:resize.consume',
      'out:email:send.produce',
      'out:image:resize.produce',
    ]);
    expect(app.manifest.projections).toEqual([
      {
        format: 'queue-topology',
        binding: 'queue',
        module: '@arki/queue/projection',
        pip: 'queue-runtime',
      },
    ]);
  });

  it('starts non-blocking by default and drains the runtime handle on stop', async () => {
    let resolveStartup: (handle: { stop(): Promise<void> }) => void = () => {};
    const startup = new Promise<{ stop(): Promise<void> }>(resolve => {
      resolveStartup = resolve;
    });
    const stopped: string[] = [];
    const seenDependencies: string[] = [];

    const app = await defineApp('queue-app')
      .use(dependency)
      .use(
        queueRuntime({
          needs: { dependency: service<Dependency>() },
          registry,
          start: async ({ dependency: dep }) => {
            seenDependencies.push(dep.name);
            return startup;
          },
        }),
      )
      .start();

    expect(seenDependencies).toEqual(['test-dependency']);
    resolveStartup({
      async stop() {
        stopped.push('stopped');
      },
    });

    await app.dispose();

    expect(stopped).toEqual(['stopped']);
  });

  it('throws a coded error when blocking startup exceeds the timeout', async () => {
    const starting = defineApp('queue-app')
      .use(dependency)
      .use(
        queueRuntime({
          needs: { dependency: service<Dependency>() },
          registry,
          blocking: true,
          startupTimeoutMs: 1,
          start: async () => new Promise<never>(() => {}),
        }),
      )
      .start();

    await expect(starting).rejects.toMatchObject({
      code: DotLifecycleErrorCode.StartFailed,
      cause: { code: QUEUE_PIP_ERROR_CODES.startupTimeout },
    });
  });

  it('degrades on non-blocking startup timeout and lets app shutdown continue', async () => {
    const app = await defineApp('queue-app')
      .use(dependency)
      .use(
        queueRuntime({
          needs: { dependency: service<Dependency>() },
          registry,
          startupTimeoutMs: 1,
          start: async () => new Promise<never>(() => {}),
        }),
      )
      .start();

    await wait(5);
    await app.dispose();

    expect(app.state).toBe('disposed');
  });
});
