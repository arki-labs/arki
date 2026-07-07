import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { DotLifecycleErrorCode } from '@arki/dot/pip';
import { pip, provide, service, token } from '@arki/dot/pip';

import { initQueue } from './init.ts';
import { project } from './projection.ts';
import type { QueueBuilder, QueueInstance } from './types/builder.ts';
import type { QueueMeta } from './types/queue.ts';
import {
  QUEUE_PIP_ERROR_CODES,
  queueActions,
  queueConsumerActions,
  queueProducerActions,
  queueRuntime,
} from './dot.ts';

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

const dailyEmail = q.schedule
  .cron('0 8 * * *', { timezone: 'UTC' })
  .job(sendEmail)
  .data({ to: 'team@example.com' });

const imageFlow = q.flow
  .name('image:process')
  .input(z.object({ imageId: z.string() }))
  .step('resize', {
    job: resizeImage,
    data: input => ({ imageId: input.imageId }),
  })
  .build();

const fullRegistry = q.registry({
  registry,
  dailyEmail,
  imageFlow,
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

  it('queueActions covers jobs, queue-backed schedules, and flows', () => {
    expect(queueActions(fullRegistry).map(action => `${action.direction}:${action.id}:${action.meta['kind']}`)).toEqual([
      'in:email:send.consume:job',
      'in:image:resize.consume:job',
      'in:email:send-schedule.fire:schedule',
      'in:image:process.consume:flow',
      'out:email:send.produce:job',
      'out:image:resize.produce:job',
      'out:image:process.produce:flow',
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

  it('feature mode registers feature-provided registries and leaves action ownership with the feature', async () => {
    type QueueCtx = {
      readonly dependencyName: string;
    };

    const Orders = token<{ readonly queue?: typeof registry }>()('feature.orders');
    const ordersPip = pip({
      name: 'orders',
      actions: queueActions(registry),
      boot: () => provide(Orders, { queue: registry }),
    });

    let registered: Record<string, unknown> | undefined;
    let createContext: (() => QueueCtx | Promise<QueueCtx>) | undefined;
    let createdContext: QueueCtx | undefined;
    let started = 0;
    let stopped = 0;
    const queue: QueueInstance = {
      async register(nextRegistry) {
        registered = nextRegistry;
      },
      async start() {
        if (createContext !== undefined) {
          createdContext = await createContext();
        }
        started += 1;
      },
      async stop() {
        stopped += 1;
      },
    };
    const fakeQ: QueueBuilder<QueueCtx, QueueMeta> = {
      _config: q._config,
      job: q.job,
      middleware: q.middleware,
      registry: q.registry,
      schedule: q.schedule,
      flow: q.flow,
      createQueue(options) {
        createContext = options.createContext;
        return queue;
      },
    };

    const app = await defineApp('queue-feature-app')
      .use(dependency)
      .use(ordersPip)
      .use(
        queueRuntime({
          q: fakeQ,
          features: [Orders] as const,
          needs: { dependency: service<Dependency>() },
          connection: 'redis://localhost:6379',
          blocking: true,
          context: ({ dependency: dep }) => ({ dependencyName: dep.name }),
        }),
      )
      .start();

    expect(app.manifest.actions.every(action => action.pip === 'orders')).toBe(true);
    expect(app.manifest.actions.map(action => action.id)).toEqual([
      'email:send.consume',
      'image:resize.consume',
      'email:send.produce',
      'image:resize.produce',
    ]);
    expect(createdContext).toEqual({ dependencyName: 'test-dependency' });
    expect(registered).toEqual({ 'feature.orders': registry });
    expect(started).toBe(1);

    await app.dispose();
    expect(stopped).toBe(1);
  });

  it('feature mode requires feature tokens to be provided earlier', () => {
    const Ghost = token<{ readonly queue?: typeof registry }>()('feature.ghost');
    // @ts-expect-error — feature token has no provider before queueRuntime(...)
    defineApp('queue-feature-guard').use(
      queueRuntime({
        q,
        features: [Ghost] as const,
        needs: {},
        connection: 'redis://localhost:6379',
        context: () => ({}),
      }),
    );
    expect(true).toBe(true);
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
