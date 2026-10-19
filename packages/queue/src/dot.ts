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
 * `outboxPlugin()` provides `schedule` (transactional scheduling, `@arki/queue/outbox`), and
 * `outboxJobs()` lets `journalWorker({ jobs })` run the same `jobs(...)` slices from Postgres.
 */
import type { AnyFeatureSlice, Driver, MountedFeature } from '@arki/dot/feature';
import type { CtxOf, EmptyShape, NeedsShape, Service, WireNeeds } from '@arki/dot/plugin';
import type { RootDb } from '@arki/journal';
import type { JobsSource } from '@arki/journal/dot';
import { driver, entrypointsOf, instanceOf, sliceOf } from '@arki/dot/feature';
import { DotPluginError, plugin, service } from '@arki/dot/plugin';

import type { DurableSchedulerOptions } from './durable-scheduler.ts';
import type { InternalFlowDefinition } from './flow-builder.ts';
import type { Outbox, OutboxOptions, OutboxTx, Scheduled, ScheduleOptions } from './outbox/outbox.ts';
import type { QueueRegistry } from './outbox/registry.ts';
import type { QueueClient, QueueClientHandle, QueueClientOptions } from './queue-client.ts';
import type { InternalScheduleDefinition } from './schedule-builder.ts';
import type { FlowDefinition, QueueBuilder, QueueInstance, ScheduleDefinition } from './types/builder.ts';
import type { AnyJobDefinition, JobDefinition, JobOptions, TriggerOptions } from './types/job.ts';
import type { QueueMeta } from './types/queue.ts';
import { QUEUE_ACTION_META_SCHEMA } from './action-meta.ts';
import { debugWorker } from './debug.ts';
import { createDurableScheduler } from './durable-scheduler.ts';
import { triggerJob } from './job-builder.ts';
import { outbox } from './outbox/outbox.ts';
import { collectQueueDefinitions, isFlowDefinition, isJobDefinition, isScheduleDefinition } from './outbox/registry.ts';
import { outboxRunner } from './outbox/runner.ts';
import { createQueueClient } from './queue-client.ts';

export { QUEUE_ACTION_META_SCHEMA } from './action-meta.ts';
export type { QueueClient, QueueClientOptions } from './queue-client.ts';

export const QUEUE_PLUGIN_ERROR_CODES = {
  startupTimeout: 'ARKI_QUEUE_E001',
  doubleStart: 'ARKI_QUEUE_E002',
  stopBeforeStart: 'ARKI_QUEUE_E003',
  clientMissing: 'ARKI_QUEUE_E006',
} as const;

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

export type { QueueRegistry } from './outbox/registry.ts';

function retryMeta(options: JobOptions | undefined): JsonObject | undefined {
  const retry = options?.retry;
  if (retry === undefined) return undefined;
  return { attempts: Number.isFinite(retry.maxRetries) ? retry.maxRetries + 1 : 'unlimited' };
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
 * What a job declared in a feature's `jobs(...)` runs with, on top of the worker's `context` and
 * the job: `services`, the services of the feature that registered it — its needs (an instance's
 * rebound ones), infra, children's provides and `usecases`, without the kernel's `$` keys. Type the
 * feature's jobs with it: `initQueue.context<WorkerContext & FeatureJobContext<Services>>().create()`.
 *
 * Both workers hand it over (`queueWorker`, `outboxJobs`). A job registered outside a feature
 * (`q.createQueue(...).register(...)`) runs without it. A job two plain features list is one job:
 * it runs once, with the services of the first.
 */
export type FeatureJobContext<TServices> = { readonly services: TServices };

/** The payload of a feature's `jobs(...)` slice once the feature booted: its jobs and its services. */
export type FeatureJobs<TRegistry extends QueueRegistry = QueueRegistry> = {
  readonly registry: TRegistry;
  /** What the feature's jobs see as `ctx.services` ({@link FeatureJobContext}). */
  readonly services: object;
};

/**
 * The slice a `jobs(...)` declaration produces. The registry and the feature's services land
 * under `queue` in the feature's slice record, where `queueWorker()` collects them.
 * The slice's manifest actions are the PRODUCER side only (the feature can
 * enqueue these jobs wherever it is mounted); the consumer side belongs to
 * the worker, which exists only in the process that runs the jobs.
 */
export type QueueFeatureSlice<TRegistry extends QueueRegistry> = {
  /** Lets a `defineFeature` feature list it in `.entrypoints(...)`; object-form features ignore it. */
  readonly kind: 'queue';
  readonly key: 'queue';
  /** Empty: the producer ids need the feature's name, so they come from `actionsOf`. */
  readonly actions: readonly QueueDotAction[];
  /** The producer side, named after the feature: an instance's ids carry its instance (`send-mail#eu.produce`). */
  readonly actionsOf: (feature: string) => readonly QueueDotAction[];
  readonly registry: TRegistry;
  readonly resolve: (services: unknown) => FeatureJobs<TRegistry>;
};

/** A feature's services as its jobs see them: the kernel's `$` keys ($app, $plugin, …) belong to the unit. */
function jobServicesOf(services: unknown): object {
  if (typeof services !== 'object' || services === null) return {};
  return Object.fromEntries(Object.entries(services).filter(([key]) => !key.startsWith('$')));
}

/**
 * Declare a feature's jobs: `defineFeature('orders')….entrypoints(jobs(orderJobs))`,
 * or `feature('orders', { use: [jobs(orderJobs)] })` in the object form.
 * Each mounted copy of the feature runs them with its own services ({@link FeatureJobContext}).
 */
export function jobs<const TRegistry extends QueueRegistry>(registry: TRegistry): QueueFeatureSlice<TRegistry> {
  return {
    kind: 'queue',
    key: 'queue',
    actions: [],
    actionsOf: feature => queueProducerActions(featureRegistry(feature, registry)),
    registry,
    resolve: services => ({ registry, services: jobServicesOf(services) }),
  };
}

function isQueueRegistry(value: unknown): value is QueueRegistry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFeatureJobs(value: unknown): value is FeatureJobs {
  return (
    typeof value === 'object' &&
    value !== null &&
    'registry' in value &&
    isQueueRegistry(value.registry) &&
    'services' in value &&
    typeof value.services === 'object' &&
    value.services !== null
  );
}

function isJobsSlice(slice: AnyFeatureSlice): slice is AnyFeatureSlice & { readonly registry: QueueRegistry } {
  return slice.key === 'queue' && 'registry' in slice && isQueueRegistry(slice.registry);
}

/**
 * How a feature (or one of its units, `reports#eu/job-producers`) names its jobs: an instance
 * appends its instance (`send-mail#eu`), so two copies get two queues. A plain feature's names
 * never change (`undefined`): live queues, scheduler ids and stored outbox rows keep resolving.
 */
function jobNamingOf(owner: string): ((name: string) => string) | undefined {
  const instance = instanceOf(owner);
  return instance === undefined ? undefined : name => `${name}#${instance}`;
}

/** A job under another name. Registering it sets the copy's own `_queue`/`_worker`, never the original's. */
function renamedJob<TInput, TOutput, TDeps>(
  job: JobDefinition<TInput, TOutput, TDeps>,
  name: string,
): JobDefinition<TInput, TOutput, TDeps> {
  const { inputSchema, handler, options, middlewares } = job._internal;
  const copy: JobDefinition<TInput, TOutput, TDeps> = {
    _type: 'job',
    _internal: { name, inputSchema, handler, middlewares, ...(options === undefined ? {} : { options }) },
    trigger: (data, triggerOptions) => triggerJob(copy._internal, data, triggerOptions),
  };
  return copy;
}

/**
 * A feature instance's registry: every job, schedule and flow renamed by `rename`. Each job is
 * copied once, so a schedule or flow step points at the same copy the registry lists.
 */
function renamedRegistry(registry: QueueRegistry, rename: (name: string) => string): QueueRegistry {
  const copies = new Map<object, JobDefinition<unknown, unknown, unknown>>();
  const jobCopy = (job: JobDefinition<unknown, unknown, unknown>): JobDefinition<unknown, unknown, unknown> => {
    const known = copies.get(job);
    if (known !== undefined) return known;
    const copy = renamedJob(job, rename(job._internal.name));
    copies.set(job, copy);
    return copy;
  };
  const copyOf = (value: unknown): unknown => {
    if (isJobDefinition(value)) return jobCopy(value);
    if (isScheduleDefinition(value)) {
      const internal = value._internal as InternalScheduleDefinition;
      const renamed: InternalScheduleDefinition = {
        ...internal,
        name: rename(internal.name),
        job: jobCopy(internal.job),
      };
      return { ...value, _internal: renamed };
    }
    if (isFlowDefinition(value)) {
      const internal = value._internal as InternalFlowDefinition;
      const renamed: InternalFlowDefinition = {
        ...internal,
        name: rename(internal.name),
        steps: internal.steps.map(step => ({ ...step, job: jobCopy(step.job) })),
      };
      return { ...value, _internal: renamed };
    }
    if (isQueueRegistry(value)) return walk(value);
    return value;
  };
  const walk = (node: QueueRegistry): QueueRegistry =>
    Object.fromEntries(Object.entries(node).map(([key, value]) => [key, copyOf(value)]));
  return walk(registry);
}

/** The registry a mounted feature runs: its own for a plain feature, renamed copies for an instance. */
function featureRegistry(featureName: string, registry: QueueRegistry): QueueRegistry {
  const naming = jobNamingOf(featureName);
  return naming === undefined ? registry : renamedRegistry(registry, naming);
}

/** The jobs every feature declared, keyed by feature name — known before boot, for the manifest. */
function declaredRegistry(features: readonly MountedFeature[]): QueueRegistry {
  const registry: QueueRegistry = {};
  for (const f of features) {
    const slice = entrypointsOf(f).find(candidate => isJobsSlice(candidate));
    if (slice !== undefined) registry[f.name] = featureRegistry(f.name, slice.registry);
  }
  return registry;
}

/** The jobs every booted feature published, read from its slice record, and the services each feature's jobs run with. */
function bootedJobs(
  ctx: object,
  features: readonly MountedFeature[],
): { readonly registry: QueueRegistry; readonly services: Readonly<Record<string, object>> } {
  const registry: QueueRegistry = {};
  const services: Record<string, object> = {};
  for (const f of features) {
    const slice = sliceOf(ctx, f)['queue'];
    if (isFeatureJobs(slice)) {
      registry[f.name] = featureRegistry(f.name, slice.registry);
      services[f.name] = slice.services;
      continue;
    }
    debugWorker.debug('[{value1}] Feature "{featureName}" did not contribute a queue slice.', {
      value1: 'queue-worker',
      featureName: f.name,
    });
  }
  return { registry, services };
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
  options: DurableSchedulerOptions,
): ReturnType<typeof createDurableSchedulerPlugin<'durable-scheduler'>>;
export function durableScheduler<N extends string>(
  options: DurableSchedulerOptions & { readonly name: N },
): ReturnType<typeof createDurableSchedulerPlugin<N>>;
export function durableScheduler(options: DurableSchedulerPluginOptions) {
  return createDurableSchedulerPlugin(options.name ?? 'durable-scheduler', options);
}

function createDurableSchedulerPlugin<const Name extends string>(name: Name, options: DurableSchedulerOptions) {
  return plugin({
    name,
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
export function queue(options: QueueClientOptions): ReturnType<typeof createQueuePlugin<'queue'>>;
export function queue<N extends string>(
  options: QueueClientOptions & { readonly name: N },
): ReturnType<typeof createQueuePlugin<N>>;
export function queue(options: QueuePluginOptions) {
  return createQueuePlugin(options.name ?? 'queue', options);
}

function createQueuePlugin<const Name extends string>(name: Name, options: QueueClientOptions) {
  let handle: QueueClientHandle | undefined;
  return plugin({
    name,
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
        const { registry, services } = bootedJobs(ctx, features);
        const resolvedContext = await options.context(ctx);
        const instance = options.q.createQueue({
          connection: client.connection,
          keyPrefix: client.keyPrefix,
          createContext: () => resolvedContext,
        });
        await instance.register(registry, { services });
        await instance.start();
        return instance;
      };

      const runtime = await Promise.race([start(), timeoutAfter(startupTimeoutMs, pluginName)]);
      handle = runtime;
      return runtime;
    };

    return plugin<WorkerShape<TNeeds>, EmptyShape>({
      name: pluginName,
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

export type OutboxPluginOptions = OutboxOptions & {
  readonly name?: string;
};

/**
 * Provide the `schedule` service (`@arki/queue/outbox`): `schedule.runAfter(tx, job, args)` writes
 * the job row in the caller's transaction. Opens nothing and needs nothing; mount it with `.use()`
 * in every process that schedules, and run the rows with `journalWorker({ jobs: outboxJobs(...) })`.
 */
export function outboxPlugin(options: OutboxOptions): ReturnType<typeof createOutboxPlugin<'outbox'>>;
export function outboxPlugin<N extends string>(
  options: OutboxOptions & { readonly name: N },
): ReturnType<typeof createOutboxPlugin<N>>;
export function outboxPlugin(options: OutboxPluginOptions) {
  return createOutboxPlugin(options.name ?? 'outbox', options);
}

function createOutboxPlugin<const Name extends string>(name: Name, options: OutboxOptions) {
  return plugin({
    name,
    configure(ctx) {
      ctx.declareProvides('outbox');
    },
    provides: { schedule: () => outbox(options) },
  });
}

export type OutboxJobsOptions<TNeeds extends NeedsShape, TContext> = {
  /** Services the job context is built from, besides `db`. Use `{}` for none. Missing ones fail boot. */
  readonly needs: TNeeds;
  /** Build the job context. Runs once, on the first job, then cached (as `queueWorker`'s `context`). */
  readonly context: (services: CtxOf<TNeeds> & { readonly db: RootDb }) => TContext | Promise<TContext>;
};

/**
 * Run every mounted feature's `jobs(...)` slice from the journal's jobs table:
 * `.serve(journalWorker({ listen, jobs: outboxJobs({ needs, context }) }))`. The same slice
 * feeds Redis workers (`queueWorker`) and this runner; the worker's manifest lists `<job>.consume`.
 */
export function outboxJobs<TNeeds extends NeedsShape & NoReservedKeys, TContext>(
  options: OutboxJobsOptions<TNeeds, TContext>,
): JobsSource<TNeeds> {
  return {
    needs: options.needs,
    actions: features => queueConsumerActions(declaredRegistry(features)),
    build: (features, services) => {
      const booted = bootedJobs(services, features);
      return outboxRunner({
        registry: booted.registry,
        services: booted.services,
        context: () => options.context(services),
      });
    },
  };
}

/** The input type of a job definition, read from its `trigger`. */
type InputOf<TJob> = TJob extends {
  readonly trigger: (data: infer TInput, options?: TriggerOptions) => Promise<string>;
}
  ? TInput
  : never;

/** A job's producer on the Redis lane: enqueue under the feature's name for it (`send-mail#eu` in an instance). */
export type JobProducer<TInput> = {
  enqueue(data: TInput, options?: TriggerOptions): Promise<string>;
};

export type JobProducers<TJobs> = { readonly [K in keyof TJobs]: JobProducer<InputOf<TJobs[K]>> };

/** A job's producer on the outbox lane: a row in the caller's transaction, under the feature's name for it. */
export type OutboxProducer<TInput> = {
  runAfter(tx: OutboxTx, args: TInput, options?: ScheduleOptions): Promise<Scheduled>;
  runAt(tx: OutboxTx, args: TInput, at: Date, options?: Omit<ScheduleOptions, 'delayMs'>): Promise<Scheduled>;
};

export type OutboxProducers<TJobs> = { readonly [K in keyof TJobs]: OutboxProducer<InputOf<TJobs[K]>> };

type JobsRecord = Readonly<Record<string, AnyJobDefinition>>;

/**
 * One producer per job, each bound to the name the owning feature runs it under. `unit` is the
 * producing plugin's own name: inside an instance it is `reports#eu/job-producers`, so the
 * producer and the worker (`jobs(...)` of `reports#eu`) both derive `send-mail#eu` and cannot drift.
 */
function producersOf<TProducer>(
  jobsToProduce: JobsRecord,
  unit: string,
  producerOf: (job: JobDefinition<unknown, unknown, unknown>) => TProducer,
): Readonly<Record<string, TProducer>> {
  const naming = jobNamingOf(unit);
  const producers: Record<string, TProducer> = {};
  for (const [key, job] of Object.entries(jobsToProduce)) {
    if (!isJobDefinition(job)) continue;
    producers[key] = producerOf(naming === undefined ? job : renamedJob(job, naming(job._internal.name)));
  }
  return producers;
}

/**
 * A feature's producers on the Redis lane, as feature-private infra:
 * `defineFeature('reports').needs({ queue: queuePlugin.provides.queue }).infra(jobProducers({ sendMail }))`,
 * then `deps.jobs.sendMail.enqueue(data)` in a usecase. In an instance (`reports.instance('eu', …)`)
 * it enqueues to `send-mail#eu`, the queue that instance's `jobs(...)` runs; in a plain feature
 * to `send-mail`, exactly as `queue.enqueue(sendMail, data)`.
 */
export function jobProducers<const TJobs extends JobsRecord>(jobsToProduce: TJobs) {
  return plugin({
    name: 'job-producers',
    needs: { queue: service<QueueClient>() },
    provides: {
      jobs: ({ queue: client, $plugin }): JobProducers<TJobs> =>
        // Erasure seam: each producer takes its own job's input; `producersOf` walks them untyped.
        producersOf(jobsToProduce, $plugin, job => ({
          enqueue: (data: unknown, options?: TriggerOptions) => client.enqueue(job, data, options),
        })) as JobProducers<TJobs>,
    },
  });
}

/**
 * A feature's producers on the outbox lane (`@arki/queue/outbox`), as feature-private infra:
 * `.needs({ schedule: scheduling.provides.schedule }).infra(outboxProducers({ sendMail }))`, then
 * `deps.jobs.sendMail.runAfter(tx, args)`. Rows carry the feature's name for the job (`send-mail#eu`
 * in an instance), which `outboxJobs()` resolves to that instance's job. A feature mounts one of
 * `jobProducers` and `outboxProducers`: both provide `jobs`.
 */
export function outboxProducers<const TJobs extends JobsRecord>(jobsToProduce: TJobs) {
  return plugin({
    name: 'outbox-producers',
    needs: { schedule: service<Outbox>() },
    provides: {
      jobs: ({ schedule, $plugin }): OutboxProducers<TJobs> =>
        // Erasure seam: each producer takes its own job's input; `producersOf` walks them untyped.
        producersOf(jobsToProduce, $plugin, job => ({
          runAfter: (tx: OutboxTx, args: unknown, options?: ScheduleOptions) =>
            schedule.runAfter(tx, job, args, options),
          runAt: (tx: OutboxTx, args: unknown, at: Date, options?: Omit<ScheduleOptions, 'delayMs'>) =>
            schedule.runAt(tx, job, args, at, options),
        })) as OutboxProducers<TJobs>,
    },
  });
}
