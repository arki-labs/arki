/**
 * The queue's DOT adapters follow the hexagon: `queue()` is the driven client
 * features enqueue with (mounted with `.use`, before the features), and
 * `queueWorker()` is the driving adapter that runs the features' jobs (mounted
 * with `.serve`, bound to the features the app already mounted). These tests
 * break if the app has to list its features twice, if a feature cannot reach
 * the client, or if the manifest claims a process consumes queues it does not.
 *
 * Listed under `files` in tsconfig.json: the `@ts-expect-error` lines fail
 * `bun run typecheck` if a wiring guard stops firing.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { defineFeature, feature } from '@arki/dot/feature';
import { DotLifecycleErrorCode, plugin, service } from '@arki/dot/plugin';
import { orThrow, UnexpectedDefect } from '@arki/failure';

import type { QueueClient } from './dot.ts';
import type { QueueBuilder, QueueInstance } from './types/builder.ts';
import type { QueueMeta } from './types/queue.ts';
import {
  durableScheduler,
  jobs,
  queue,
  QUEUE_PLUGIN_ERROR_CODES,
  queueActions,
  queueConsumerActions,
  queueProducerActions,
  queueWorker,
} from './dot.ts';
import { QUEUE_DEFINITION_ERROR_CODES } from './errors.ts';
import { initQueue } from './init.ts';
import { project } from './projection.ts';

const q = initQueue.create();
// Never contacted: boot opens no connection and these tests run no real worker.
const REDIS_URL = 'redis://127.0.0.1:1';

// The constructors derive their exact factories and lifecycle callbacks from plugin().
const _queuePlugin = queue({ connection: REDIS_URL });
const _namedQueuePlugin = queue({ connection: REDIS_URL, name: 'mail-queue' });
const _schedulerPlugin = durableScheduler({ connection: REDIS_URL });
const _namedSchedulerPlugin = durableScheduler({ connection: REDIS_URL, name: 'mail-scheduler' });
expectTypeOf(_queuePlugin.provides.queue.provider).toEqualTypeOf<'queue'>();
expectTypeOf(_namedQueuePlugin.provides.queue.provider).toEqualTypeOf<'mail-queue'>();
expectTypeOf(_schedulerPlugin.provides['arki.schedule.durable'].provider).toEqualTypeOf<'durable-scheduler'>();
expectTypeOf(_namedSchedulerPlugin.provides['arki.schedule.durable'].provider).toEqualTypeOf<'mail-scheduler'>();
expectTypeOf<typeof _queuePlugin.factories>().toEqualTypeOf<{ readonly queue: (ctx: never) => QueueClient }>();
expectTypeOf<typeof _queuePlugin.hooks.stop>().toEqualTypeOf<
  ((ctx: never) => undefined | Promise<undefined>) | undefined
>();

const sendEmail = q.job
  .name('email:send')
  .input(z.object({ to: z.string() }))
  .handler(() => Promise.resolve({ ok: true }));

const resizeImage = q.job
  .name('image:resize')
  .input(z.object({ imageId: z.string() }))
  .handler(() => Promise.resolve({ ok: true }));

const registry = q.registry({
  notifications: q.registry({ sendEmail }),
  image: q.registry({ resizeImage }),
});

const dailyEmail = q.schedule.cron('0 8 * * *', { timezone: 'UTC' }).job(sendEmail).data({ to: 'team@example.com' });

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

const dependency = plugin({
  name: 'dependency',
  provides: { dependency: () => ({ name: 'test-dependency' }) satisfies Dependency },
});

const orders = feature('orders', { use: [jobs(registry)] });
// A feature with no jobs: the worker must skip it, not fail.
const billing = feature('billing', {});

type QueueCtx = {
  readonly dependencyName: string;
};

/** A `q` whose createQueue hands back `instance` and records what the worker passed it. */
function fakeBuilder(instance: QueueInstance) {
  const seen: {
    connection?: unknown;
    keyPrefix?: string;
    createContext?: () => QueueCtx | Promise<QueueCtx>;
  } = {};
  const real = initQueue.context<QueueCtx>().create();
  const fakeQ: QueueBuilder<QueueCtx, QueueMeta> = {
    ...real,
    createQueue(options) {
      seen.connection = options.connection;
      seen.keyPrefix = options.keyPrefix;
      seen.createContext = options.createContext;
      return {
        ...instance,
        queues: () => new Map(),
        enqueue: () => Promise.reject(new Error('the fake queue instance never enqueues')),
      };
    },
  };
  return { fakeQ, seen };
}

const done = (): Promise<void> => Promise.resolve();
/** A start that never settles. */
const hang = (): Promise<never> =>
  new Promise<never>(() => {
    // never settles
  });

function idleInstance(): QueueInstance {
  return { register: done, start: done, stop: done };
}

function kindOf(action: { readonly meta: Readonly<Record<string, unknown>> }): string {
  const kind = action.meta['kind'];
  return typeof kind === 'string' ? kind : '';
}

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
    expect(queueActions(fullRegistry).map(action => `${action.direction}:${action.id}:${kindOf(action)}`)).toEqual([
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
    const actions = [
      ...queueConsumerActions(registry).map(action => ({ ...action, plugin: 'queue-worker' })),
      ...queueProducerActions(registry).map(action => ({ ...action, plugin: 'orders' })),
    ];

    expect(project({ app: { name: 'queue-app' }, actions })).toEqual({
      format: 'queue-topology',
      queues: [
        {
          name: 'email:send',
          consumers: [{ id: 'email:send.consume', plugin: 'queue-worker' }],
          producers: [{ id: 'email:send.produce', plugin: 'orders' }],
        },
        {
          name: 'image:resize',
          consumers: [{ id: 'image:resize.consume', plugin: 'queue-worker' }],
          producers: [{ id: 'image:resize.produce', plugin: 'orders' }],
        },
      ],
    });
  });
});

describe('queue() — the driven client', () => {
  it('lets a feature need the queue client, and registers the topology projection', async () => {
    // Why: features enqueue through a service they declare, so the client
    // must be a `.use()` adapter mounted BEFORE `.features()`.
    let seen: QueueClient | undefined;
    const checkout = feature('checkout', {
      needs: { queue: service<QueueClient>() },
      boot: ({ queue: client }) => {
        seen = client;
      },
    });

    const app = await orThrow(
      defineApp('api')
        .use(queue({ connection: REDIS_URL, keyPrefix: 'shop:' }))
        .features([checkout])
        .start(),
    );

    expect(seen?.keyPrefix).toBe('shop:');
    expect(app.services.queue).toBe(seen);
    expect(app.manifest.projections).toEqual([
      { format: 'queue-topology', binding: 'queue', module: '@arki/queue/projection', plugin: 'queue' },
    ]);
    // Boot opened no connection, so dispose has nothing to drain.
    await orThrow(app.dispose());
    expect(app.state).toBe('disposed');
  });

  it('a feature that needs the client does not compile without queue()', () => {
    const checkout = feature('checkout', { needs: { queue: service<QueueClient>() } });
    // @ts-expect-error — nothing provides `queue` before the features
    defineApp('api').features([checkout]);
    expect(true).toBe(true);
  });

  it('an API process that only enqueues claims to produce, never to consume', () => {
    // Why: the jobs() slice travels with the feature into every process. Only
    // the process running queueWorker() consumes, so only it may say so.
    const app = orThrow(
      defineApp('api')
        .use(queue({ connection: REDIS_URL }))
        .features([orders])
        .configure(),
    );

    expect(app.manifest.actions.map(action => `${action.plugin}:${action.id}`)).toEqual([
      'orders:email:send.produce',
      'orders:image:resize.produce',
    ]);
  });
});

describe('queueWorker() — the driving adapter', () => {
  it('binds to the mounted features: the app lists them once', async () => {
    let registered: Record<string, unknown> | undefined;
    let started = 0;
    let stopped = 0;
    const { fakeQ, seen } = fakeBuilder({
      register(next) {
        registered = next;
        return done();
      },
      start() {
        started += 1;
        return done();
      },
      stop() {
        stopped += 1;
        return done();
      },
    });
    let contextCalls = 0;

    const app = await orThrow(
      defineApp('worker')
        .use(dependency)
        .use(queue({ connection: REDIS_URL, keyPrefix: 'shop:' }))
        .features([orders, billing])
        .serve(
          queueWorker({
            q: fakeQ,
            needs: { dependency: service<Dependency>() },
            blocking: true,
            context: ({ dependency: dep }) => {
              contextCalls += 1;
              return { dependencyName: dep.name };
            },
          }),
        )
        .start(),
    );

    // Only features with a jobs() slice contribute; billing is skipped.
    expect(registered).toEqual({ orders: registry });
    // The worker reads where to consume from the client, so producer and
    // consumer can never disagree on connection or key prefix.
    expect(seen.connection).toBe(REDIS_URL);
    expect(seen.keyPrefix).toBe('shop:');
    // Context is assembled once inside the guarded start: repeated
    // createContext() calls (one per job run) return the SAME object.
    const first = await seen.createContext?.();
    const second = await seen.createContext?.();
    expect(first).toEqual({ dependencyName: 'test-dependency' });
    expect(second).toBe(first);
    expect(contextCalls).toBe(1);
    expect(started).toBe(1);

    // The worker owns the consumer side; the feature keeps the producer side.
    expect(app.manifest.actions.map(action => `${action.plugin}:${action.id}`)).toEqual([
      'orders:email:send.produce',
      'orders:image:resize.produce',
      'queue-worker:email:send.consume',
      'queue-worker:image:resize.consume',
    ]);

    await orThrow(app.dispose());
    expect(stopped).toBe(1);
  });

  it("reads a defineFeature feature's jobs() entrypoint, next to an object-form feature", async () => {
    // Why: during the migration an app mounts both forms. The worker must
    // register both registries and claim the consumer side of both, before boot.
    let registered: Record<string, unknown> | undefined;
    const { fakeQ } = fakeBuilder({ ...idleInstance(), register: next => ((registered = next), done()) });
    const encodeVideo = q.job
      .name('video:encode')
      .input(z.object({ videoId: z.string() }))
      .handler(() => Promise.resolve({ ok: true }));
    const media = defineFeature('media').entrypoints(jobs(q.registry({ encodeVideo })));

    const app = await orThrow(
      defineApp('mixed-worker')
        .infra(dependency, queue({ connection: REDIS_URL }))
        .features([orders, media])
        .entrypoints(queueWorker({ q: fakeQ, needs: {}, blocking: true, context: () => ({ dependencyName: 'x' }) }))
        .start(),
    );

    expect(Object.keys(registered ?? {})).toEqual(['orders', 'media']);
    expect(app.manifest.actions.map(action => `${action.plugin}:${action.id}`)).toEqual([
      'orders:email:send.produce',
      'orders:image:resize.produce',
      'media:video:encode.produce',
      'queue-worker:email:send.consume',
      'queue-worker:image:resize.consume',
      'queue-worker:video:encode.consume',
    ]);
    await orThrow(app.dispose());
  });

  it('does not compile without the queue client it shares connection with', () => {
    const { fakeQ } = fakeBuilder(idleInstance());
    const worker = queueWorker({ q: fakeQ, needs: {}, context: () => ({ dependencyName: 'x' }) });
    // @ts-expect-error — queueWorker needs `queue`; mount queue() with .use first
    defineApp('worker').features([orders]).serve(worker);
    expect(true).toBe(true);
  });

  it('starts non-blocking by default and drains the instance on stop', async () => {
    let releaseStart: (() => void) | undefined;
    const stopped: string[] = [];
    const { fakeQ } = fakeBuilder({
      register: done,
      start: () =>
        new Promise<void>(resolve => {
          releaseStart = resolve;
        }),
      stop: () => {
        stopped.push('stopped');
        return done();
      },
    });

    const app = await orThrow(
      defineApp('worker')
        .use(queue({ connection: REDIS_URL }))
        .features([orders])
        .serve(queueWorker({ q: fakeQ, needs: {}, context: () => ({ dependencyName: 'x' }) }))
        .start(),
    );

    // app.start() resolved while the workers are still starting.
    releaseStart?.();
    await orThrow(app.dispose());

    expect(stopped).toEqual(['stopped']);
  });

  it('returns a coded defect when blocking startup exceeds the timeout', async () => {
    const { fakeQ } = fakeBuilder({ ...idleInstance(), start: hang });

    const starting = defineApp('worker')
      .use(queue({ connection: REDIS_URL }))
      .features([orders])
      .serve(
        queueWorker({
          q: fakeQ,
          needs: {},
          blocking: true,
          startupTimeoutMs: 1,
          context: () => ({ dependencyName: 'x' }),
        }),
      )
      .start();

    const failure = await starting;
    expect(UnexpectedDefect.is(failure)).toBe(true);
    expect(failure).toMatchObject({
      cause: {
        code: DotLifecycleErrorCode.StartFailed,
        phase: 'start',
        plugin: 'queue-worker',
        cause: { code: QUEUE_PLUGIN_ERROR_CODES.startupTimeout },
      },
    });
  });

  it('degrades on non-blocking startup timeout and lets app shutdown continue', async () => {
    const { fakeQ } = fakeBuilder({ ...idleInstance(), start: hang });

    const app = await orThrow(
      defineApp('worker')
        .use(queue({ connection: REDIS_URL }))
        .features([orders])
        .serve(queueWorker({ q: fakeQ, needs: {}, startupTimeoutMs: 1, context: () => ({ dependencyName: 'x' }) }))
        .start(),
    );

    await wait(5);
    await orThrow(app.dispose());

    expect(app.state).toBe('disposed');
  });
});

// Error URLs need one meaning per code; preserve the older builder diagnostic.
describe('queue diagnostic identities', () => {
  it('keeps missing clients distinct from missing declaration names', () => {
    expect(QUEUE_DEFINITION_ERROR_CODES.missingName).toBe('ARKI_QUEUE_E006');
    expect(QUEUE_PLUGIN_ERROR_CODES.clientMissing).toBe('ARKI_QUEUE_E019');
  });
});
