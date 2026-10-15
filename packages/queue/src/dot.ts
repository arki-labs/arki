/**
 * DOT adapters for `@arki/queue`, split along the hexagon:
 *
 *   defineApp('shop')
 *     .use(queue({ connection }))          // driven: the client features enqueue with
 *     .features([orders])                  // orders declares `use: [jobs(orderJobs)]`
 *     .serve(queueWorker({ q, context }))  // driving: runs the mounted features' jobs
 *
 * `queue()` provides the `queue` service. `queueWorker()` is bound to the
 * features the app mounted, so the app never lists them a second time.
 * `durableScheduler()` is the BullMQ backend `@arki/schedule` uses.
 */
import type { AnyFeatureSlice, Driver, MountedFeature } from '@arki/dot/feature';
import type { CtxOf, EmptyShape, NeedsShape, Plugin, Service, WireNeeds } from '@arki/dot/plugin';
import { driver, entrypointsOf, sliceOf } from '@arki/dot/feature';
import { DotPluginError, plugin, service } from '@arki/dot/plugin';

import type { DurableScheduler, DurableSchedulerOptions } from './durable-scheduler.ts';
import type { InternalFlowDefinition } from './flow-builder.ts';
import type { QueueClient, QueueClientHandle, QueueClientOptions } from './queue-client.ts';
import type { InternalScheduleDefinition } from './schedule-builder.ts';
import type { FlowDefinition, QueueBuilder, QueueInstance, ScheduleDefinition } from './types/builder.ts';
import type { JobDefinition, JobOptions } from './types/job.ts';
import type { QueueMeta } from './types/queue.ts';
import { QUEUE_ACTION_META_SCHEMA } from './action-meta.ts';
import { debugWorker } from './debug.ts';
import { createDurableScheduler } from './durable-scheduler.ts';
import { createQueueClient } from './queue-client.ts';

export { QUEUE_ACTION_META_SCHEMA } from './action-meta.ts';
export type { QueueClient, QueueClientOptions } from './queue-client.ts';

export const QUEUE_PLUGIN_ERROR_CODES = {
  startupTimeout: 'ARKI_QUEUE_E001',
  doubleStart: 'ARKI_QUEUE_E002',
  stopBeforeStart: 'ARKI_QUEUE_E003',
  clientMissing: 'ARKI_QUEUE_E006',
} as const;

const QUEUE_PLUGIN_VERSION = '3.0.0';
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
type NoReservedKeys = Readonly<Record<`$${string}`, never>>;

export type QueueDotAction = {
  readonly id: string;
  readonly binding: 'queue';
  readonly direction: 'in' | 'out';
  readonly address: string;
  readonly summary?: string;
  readonly metaSchema: typeof QUEUE_ACTION_META_SCHEMA;
  readonly meta: JsonObject;
};

export type QueueRegistry = Record<string, unknown>;

function isJobDefinition(value: unknown): value is JobDefinition<unknown, unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_type' in value &&
    (value as { _type?: unknown })._type === 'job' &&
    '_internal' in value &&
    typeof (value as { _internal?: { name?: unknown } })._internal?.name === 'string'
  );
}

function isScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_type' in value &&
    (value as { _type?: unknown })._type === 'schedule'
  );
}

function isFlowDefinition(value: unknown): value is FlowDefinition {
  return (
    typeof value === 'object' && value !== null && '_type' in value && (value as { _type?: unknown })._type === 'flow'
  );
}

type QueueDefinition = JobDefinition<unknown, unknown, unknown> | ScheduleDefinition | FlowDefinition;

function collectQueueDefinitions(
  registry: QueueRegistry,
  definitions: QueueDefinition[] = [],
): readonly QueueDefinition[] {
  for (const value of Object.values(registry)) {
    if (isJobDefinition(value) || isScheduleDefinition(value) || isFlowDefinition(value)) {
      definitions.push(value);
      continue;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      collectQueueDefinitions(value as QueueRegistry, definitions);
    }
  }
  return definitions;
}

function retryMeta(options: JobOptions | undefined): JsonObject | undefined {
  const retry = options?.retry;
  if (retry === undefined) return undefined;
  const meta: JsonObject = { attempts: retry.attempts };
  if (retry.backoff !== undefined) {
    meta['backoff'] = {
      type: retry.backoff.type,
      ...('delay' in retry.backoff ? { delay: retry.backoff.delay } : {}),
    };
  }
  return meta;
}

function actionForJob(job: JobDefinition<unknown, unknown, unknown>, direction: 'in' | 'out'): QueueDotAction {
  const name = job._internal.name;
  const options = job._internal.options;
  const meta: JsonObject = {
    kind: 'job',
    queue: name,
    ...(options?.maxParallelism === undefined ? {} : { maxParallelism: options.maxParallelism }),
    ...(retryMeta(options) === undefined ? {} : { retry: retryMeta(options) }),
  };
  return {
    id: `${name}.${direction === 'in' ? 'consume' : 'produce'}`,
    binding: 'queue',
    direction,
    address: name,
    metaSchema: QUEUE_ACTION_META_SCHEMA,
    meta,
  };
}

function actionForSchedule(schedule: ScheduleDefinition): QueueDotAction {
  const internal = schedule._internal as InternalScheduleDefinition;
  // A schedule adds to its job's own queue; it has no queue of its own.
  const queue = internal.job._internal.name;
  const meta: JsonObject = {
    kind: 'schedule',
    scheduleType: internal.type,
    queue,
    value: typeof internal.value === 'number' ? internal.value : internal.value,
    ...(internal.options?.timezone === undefined ? {} : { timezone: internal.options.timezone }),
  };
  return {
    id: `${internal.name}.fire`,
    binding: 'queue',
    direction: 'in',
    address: queue,
    metaSchema: QUEUE_ACTION_META_SCHEMA,
    meta,
  };
}

function actionForFlow(flow: FlowDefinition, direction: 'in' | 'out'): QueueDotAction {
  const internal = flow._internal as InternalFlowDefinition;
  const meta: JsonObject = {
    kind: 'flow',
    queue: internal.name,
    steps: internal.steps.length,
  };
  return {
    id: `${internal.name}.${direction === 'in' ? 'consume' : 'produce'}`,
    binding: 'queue',
    direction,
    address: internal.name,
    metaSchema: QUEUE_ACTION_META_SCHEMA,
    meta,
  };
}

export function queueConsumerActions(registry: QueueRegistry): readonly QueueDotAction[] {
  return collectQueueDefinitions(registry).flatMap(definition => {
    if (isJobDefinition(definition)) return [actionForJob(definition, 'in')];
    if (isScheduleDefinition(definition)) return [actionForSchedule(definition)];
    return [actionForFlow(definition, 'in')];
  });
}

export function queueProducerActions(registry: QueueRegistry): readonly QueueDotAction[] {
  return collectQueueDefinitions(registry).flatMap(definition => {
    if (isJobDefinition(definition)) return [actionForJob(definition, 'out')];
    if (isFlowDefinition(definition)) return [actionForFlow(definition, 'out')];
    return [];
  });
}

export function queueActions(registry: QueueRegistry): readonly QueueDotAction[] {
  return [...queueConsumerActions(registry), ...queueProducerActions(registry)];
}

/**
 * The slice a `jobs(...)` declaration produces. The registry lands under
 * `queue` in the feature's slice record, where `queueWorker()` collects it.
 * The slice's manifest actions are the PRODUCER side only (the feature can
 * enqueue these jobs wherever it is mounted); the consumer side belongs to
 * the worker, which exists only in the process that runs the jobs.
 */
export type QueueFeatureSlice<TRegistry extends QueueRegistry> = {
  /** Lets a `defineFeature` feature list it in `.entrypoints(...)`; object-form features ignore it. */
  readonly kind: 'queue';
  readonly key: 'queue';
  readonly actions: readonly QueueDotAction[];
  readonly registry: TRegistry;
  readonly resolve: (services: unknown) => TRegistry;
};

/**
 * Declare a feature's jobs: `defineFeature('orders')….entrypoints(jobs(orderJobs))`,
 * or `feature('orders', { use: [jobs(orderJobs)] })` in the object form.
 */
export function jobs<const TRegistry extends QueueRegistry>(registry: TRegistry): QueueFeatureSlice<TRegistry> {
  return { kind: 'queue', key: 'queue', actions: queueProducerActions(registry), registry, resolve: () => registry };
}

function isQueueRegistry(value: unknown): value is QueueRegistry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJobsSlice(slice: AnyFeatureSlice): slice is AnyFeatureSlice & { readonly registry: QueueRegistry } {
  return slice.key === 'queue' && 'registry' in slice && isQueueRegistry(slice.registry);
}

/** The jobs every feature declared, keyed by feature name — known before boot, for the manifest. */
function declaredRegistry(features: readonly MountedFeature[]): QueueRegistry {
  const registry: QueueRegistry = {};
  for (const f of features) {
    const slice = entrypointsOf(f).find(candidate => isJobsSlice(candidate));
    if (slice !== undefined) registry[f.name] = slice.registry;
  }
  return registry;
}

/** The jobs every booted feature published, read from its slice record. */
function bootedRegistry(ctx: object, features: readonly MountedFeature[]): QueueRegistry {
  const registry: QueueRegistry = {};
  for (const f of features) {
    const slice = sliceOf(ctx, f)['queue'];
    if (isQueueRegistry(slice)) {
      registry[f.name] = slice;
      continue;
    }
    debugWorker.debug('[{value1}] Feature "{featureName}" did not contribute a queue slice.', {
      value1: 'queue-worker',
      featureName: f.name,
    });
  }
  return registry;
}

function queuePluginError(args: {
  code: (typeof QUEUE_PLUGIN_ERROR_CODES)[keyof typeof QUEUE_PLUGIN_ERROR_CODES];
  message: string;
  remediation: string;
  docsSlug: string;
}): DotPluginError {
  return new DotPluginError({
    code: args.code,
    message: args.message,
    remediation: args.remediation,
    docsUrl: `https://arki.dev/queue/errors/${args.docsSlug}`,
  });
}

function timeoutAfter(ms: number, pluginName: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        queuePluginError({
          code: QUEUE_PLUGIN_ERROR_CODES.startupTimeout,
          message: `[queue] worker "${pluginName}" startup timed out after ${String(ms)}ms.`,
          remediation:
            'Check Redis connectivity and the worker context factory, or raise startupTimeoutMs if the worker intentionally needs more time.',
          docsSlug: 'arki-queue-e001',
        }),
      );
    }, ms);
    timer.unref();
  });
}

/**
 * Wire key of `@arki/schedule`'s `DurableSchedules` token. Kept as a plain
 * string so `@arki/queue` does not depend on `@arki/schedule`; the app
 * builder checks that the provided service fits what `schedule()` needs.
 */
export const DURABLE_SCHEDULES_KEY = 'arki.schedule.durable';

export type DurableSchedulerPluginOptions = DurableSchedulerOptions & {
  readonly name?: string;
};

/**
 * Provide the BullMQ durable backend for `@arki/schedule`. Mount it before
 * `schedule({ ..., durable: DurableSchedules })`. Its factory only builds
 * the backend; Redis is touched when the schedule plugin starts it.
 */
export function durableScheduler(
  options: DurableSchedulerPluginOptions,
): Plugin<EmptyShape, { readonly [DURABLE_SCHEDULES_KEY]: DurableScheduler }> {
  return plugin({
    name: options.name ?? 'durable-scheduler',
    version: QUEUE_PLUGIN_VERSION,
    configure(ctx) {
      ctx.declareProvides('durable-scheduler');
    },
    provides: { [DURABLE_SCHEDULES_KEY]: () => createDurableScheduler(options) },
    // The schedule plugin stops the backend first; stop() is idempotent, so
    // this only matters when nothing else stopped it.
    async stop(ctx) {
      await ctx[DURABLE_SCHEDULES_KEY].stop();
    },
    async dispose(ctx) {
      await ctx[DURABLE_SCHEDULES_KEY].stop();
    },
  });
}

export type QueuePluginOptions = QueueClientOptions & {
  readonly name?: string;
};

/**
 * Provide the `queue` client features enqueue with. Mount it with `.use()`,
 * before `.features()`. Its factory opens no connection: each job's BullMQ
 * queue opens on its first `enqueue`. Stop closes them.
 */
export function queue(options: QueuePluginOptions): Plugin<EmptyShape, { readonly queue: QueueClient }> {
  let handle: QueueClientHandle | undefined;
  return plugin({
    name: options.name ?? 'queue',
    version: QUEUE_PLUGIN_VERSION,
    configure(ctx) {
      ctx.registerProjection({
        format: 'queue-topology',
        binding: 'queue',
        module: '@arki/queue/projection',
      });
      ctx.declareProvides('queue-client');
    },
    provides: {
      queue: () => {
        handle = createQueueClient(options);
        return handle.client;
      },
    },
    async stop() {
      await handle?.close();
    },
    async dispose() {
      await handle?.close();
    },
  });
}

function isQueueClient(value: unknown): value is QueueClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    'enqueue' in value &&
    typeof value.enqueue === 'function' &&
    'keyPrefix' in value &&
    typeof value.keyPrefix === 'string' &&
    'connection' in value
  );
}

/**
 * The `queue` client from a worker hook's context. The builder guard already
 * proves it is there; this reads it without a cast (the hook context is a
 * mapped type over the caller's generic needs, which TS cannot index).
 */
function queueClientOf(ctx: object, pluginName: string): QueueClient {
  const value: unknown = 'queue' in ctx ? ctx.queue : undefined;
  if (isQueueClient(value)) return value;
  throw queuePluginError({
    code: QUEUE_PLUGIN_ERROR_CODES.clientMissing,
    message: `[queue] worker "${pluginName}" found no queue client under "queue".`,
    remediation: 'Mount queue({ connection }) with .use(...) before .features(...) and .serve(queueWorker(...)).',
    docsSlug: 'arki-queue-e006',
  });
}

/** What every worker needs on top of its own needs: the client it shares connection and prefix with. */
type WorkerShape<TNeeds extends NeedsShape> = TNeeds & { readonly queue: Service<QueueClient> };

export type QueueWorkerOptions<TNeeds extends NeedsShape & NoReservedKeys, TContext> = {
  readonly name?: string;
  /** Services the job context is built from, besides the `queue` client. Use `{}` for none. */
  readonly needs: TNeeds;
  readonly q: QueueBuilder<TContext, QueueMeta>;
  /**
   * Build the job context. Runs exactly ONCE, inside the guarded start: an
   * assembly failure (missing credentials) degrades boot like any other
   * startup failure instead of failing every job run, and an expensive
   * context graph is not rebuilt per execution. Per-run enrichment belongs
   * to job middleware.
   */
  readonly context: (services: CtxOf<WorkerShape<TNeeds>>) => TContext | Promise<TContext>;
  readonly startupTimeoutMs?: number;
  /** Wait for the workers in `app.start()`. Default: start in the background. */
  readonly blocking?: boolean;
};

/**
 * Run the jobs of every feature the app mounted. Mount it with `.serve()`:
 * it is bound to the app's features (each `jobs(...)` slice), uses the
 * `queue` client's connection and key prefix, and owns the consumer side of
 * the manifest (`<job>.consume`, `<schedule>.fire`).
 */
export function queueWorker<TContext, TNeeds extends NeedsShape & NoReservedKeys>(
  options: QueueWorkerOptions<TNeeds, TContext>,
): Driver<WireNeeds<WorkerShape<TNeeds>>, EmptyShape> {
  const pluginName = options.name ?? 'queue-worker';
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const blocking = options.blocking ?? false;
  const needs: WorkerShape<TNeeds> = { ...options.needs, queue: service<QueueClient>() };

  return driver(features => {
    let started = false;
    let handle: QueueInstance | undefined;
    let startup: Promise<QueueInstance | void> | undefined;

    const runStartup = async (ctx: CtxOf<WorkerShape<TNeeds>>): Promise<QueueInstance> => {
      const start = async (): Promise<QueueInstance> => {
        const client = queueClientOf(ctx, pluginName);
        const registry = bootedRegistry(ctx, features);
        const resolvedContext = await options.context(ctx);
        const instance = options.q.createQueue({
          connection: client.connection,
          keyPrefix: client.keyPrefix,
          createContext: () => resolvedContext,
        });
        await instance.register(registry);
        await instance.start();
        return instance;
      };

      const runtime = await Promise.race([start(), timeoutAfter(startupTimeoutMs, pluginName)]);
      handle = runtime;
      return runtime;
    };

    return plugin<WorkerShape<TNeeds>, EmptyShape>({
      name: pluginName,
      version: QUEUE_PLUGIN_VERSION,
      needs,
      actions: queueConsumerActions(declaredRegistry(features)),
      configure(ctx) {
        ctx.declareProvides('queue-worker');
      },
      async start(ctx) {
        if (started || startup !== undefined) {
          throw queuePluginError({
            code: QUEUE_PLUGIN_ERROR_CODES.doubleStart,
            message: `[queue] worker "${pluginName}" was started twice.`,
            remediation: 'Call app.start() once, or call app.stop() before starting the queue worker again.',
            docsSlug: 'arki-queue-e002',
          });
        }

        started = true;
        if (blocking) {
          startup = runStartup(ctx);
          try {
            await startup;
          } catch (error) {
            startup = undefined;
            handle = undefined;
            started = false;
            throw error;
          }
          return;
        }

        startup = runStartup(ctx).catch((error: unknown) => {
          debugWorker.debug('[{pluginName}] Queue worker startup failed', {
            pluginName,
            error: error instanceof Error ? error.message : String(error),
          });
          started = false;
          handle = undefined;
        });
      },
      async stop() {
        if (!started && startup === undefined && handle === undefined) {
          throw queuePluginError({
            code: QUEUE_PLUGIN_ERROR_CODES.stopBeforeStart,
            message: `[queue] worker "${pluginName}" was stopped before it started.`,
            remediation: 'Only call stop after a successful start, or let the DOT app lifecycle manage shutdown.',
            docsSlug: 'arki-queue-e003',
          });
        }

        const runtime = handle ?? (await startup);
        startup = undefined;
        handle = undefined;
        started = false;
        await runtime?.stop();
      },
      async dispose() {
        const runtime = handle ?? (await startup);
        startup = undefined;
        handle = undefined;
        started = false;
        await runtime?.stop();
      },
    });
  });
}
