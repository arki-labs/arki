import type { CtxOf, EmptyShape, NeedsShape, Plugin, Token, WireNeeds } from '@arki/dot/plugin';
import { DotPluginError, plugin } from '@arki/dot/plugin';

import { debugWorker } from './debug.ts';
import type { DurableScheduler, DurableSchedulerOptions } from './durable-scheduler.ts';
import { createDurableScheduler } from './durable-scheduler.ts';
import type { InternalFlowDefinition } from './flow-builder.ts';
import type { QueueInstanceOptions } from './create-queue.ts';
import type { InternalScheduleDefinition } from './schedule-builder.ts';
import type { FlowDefinition, QueueBuilder, QueueInstance, ScheduleDefinition } from './types/builder.ts';
import type { JobDefinition, JobOptions } from './types/job.ts';
import type { QueueMeta } from './types/queue.ts';

export const QUEUE_ACTION_META_SCHEMA = '@arki/queue/action-meta@1';

export const QUEUE_PLUGIN_ERROR_CODES = {
  startupTimeout: 'ARKI_QUEUE_E001',
  doubleStart: 'ARKI_QUEUE_E002',
  stopBeforeStart: 'ARKI_QUEUE_E003',
  exclusiveModes: 'ARKI_QUEUE_E004',
  featureMissing: 'ARKI_QUEUE_E005',
} as const;

const QUEUE_RUNTIME_PLUGIN_VERSION = '2.1.0';
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

export type QueueFeatureToken = Token<object, string>;

export type QueueRuntimeHandle = {
  stop(): Promise<void>;
};

export type QueueRuntimeOptions<TNeeds extends NeedsShape & NoReservedKeys> = {
  readonly name?: string;
  readonly needs: TNeeds;
  readonly registry: QueueRegistry;
  readonly start: (services: CtxOf<TNeeds>) => Promise<QueueRuntimeHandle>;
  readonly startupTimeoutMs?: number;
  readonly blocking?: boolean;
};

export type QueueRuntimeFeatureOptions<
  TNeeds extends NeedsShape & NoReservedKeys,
  TContext,
  TFeatures extends readonly QueueFeatureToken[],
> = {
  readonly name?: string;
  readonly needs: TNeeds;
  readonly q: QueueBuilder<TContext, QueueMeta>;
  readonly features: TFeatures;
  readonly context: (services: CtxOf<TNeeds>) => TContext | Promise<TContext>;
  readonly connection: QueueInstanceOptions<TContext>['connection'];
  readonly keyPrefix?: string;
  readonly startupTimeoutMs?: number;
  readonly blocking?: boolean;
};

export type QueueFeatureNeeds<TFeatures extends readonly QueueFeatureToken[]> = {
  // Value = the token's OWN payload type: the kernel guard then checks
  // exactly what the feature plugin provides. A payload without `queue`
  // simply contributes nothing at collection time.
  readonly [Tok in TFeatures[number] as Tok extends Token<unknown, infer K> ? K : never]: Tok extends Token<
    infer TPayload,
    string
  >
    ? TPayload
    : never;
};

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
    typeof value === 'object' &&
    value !== null &&
    '_type' in value &&
    (value as { _type?: unknown })._type === 'flow'
  );
}

type QueueDefinition =
  | JobDefinition<unknown, unknown, unknown>
  | ScheduleDefinition
  | FlowDefinition;

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
  const meta: JsonObject = {
    kind: 'schedule',
    scheduleType: internal.type,
    queue: internal.name,
    value: typeof internal.value === 'number' ? internal.value : internal.value,
    ...(internal.options?.timezone === undefined ? {} : { timezone: internal.options.timezone }),
  };
  return {
    id: `${internal.name}.fire`,
    binding: 'queue',
    direction: 'in',
    address: internal.name,
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

/** The `@arki/feature` slice contract a `jobs(...)` declaration produces. */
export type QueueFeatureSlice<TRegistry extends QueueRegistry> = {
  readonly key: 'queue';
  readonly actions: readonly QueueDotAction[];
  readonly resolve: (services: unknown) => TRegistry;
};

/**
 * Declare a feature's queue registry as a boot-time slice
 * (`defineFeature(..., { use: [jobs(registry)] })`). The payload lands
 * under `queue` in the feature's slice token — where
 * `queueRuntime({ features })` collects it — and the derived actions
 * join the feature's manifest.
 */
export function jobs<const TRegistry extends QueueRegistry>(registry: TRegistry): QueueFeatureSlice<TRegistry> {
  return { key: 'queue', actions: queueActions(registry), resolve: () => registry };
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

function assertExclusiveMode(options: QueueRuntimeOptions<NeedsShape & NoReservedKeys> | QueueRuntimeFeatureOptions<NeedsShape & NoReservedKeys, unknown, readonly QueueFeatureToken[]>): void {
  const hasRegistry = 'registry' in options || 'start' in options;
  const hasFeatures = 'features' in options || 'q' in options || 'context' in options;
  if (hasRegistry && hasFeatures) {
    throw queuePluginError({
      code: QUEUE_PLUGIN_ERROR_CODES.exclusiveModes,
      message: '[queue] queueRuntime options cannot mix registry/start mode with q/features/context mode.',
      remediation: 'Use either queueRuntime({ registry, start, ... }) or queueRuntime({ q, features, context, connection, ... }).',
      docsSlug: 'arki-queue-e004',
    });
  }
}

function featureRegistry(options: {
  readonly features: readonly QueueFeatureToken[];
  readonly record: Readonly<Record<string, { readonly queue?: QueueRegistry } | undefined>>;
}): QueueRegistry {
  const registry: QueueRegistry = {};
  for (const feature of options.features) {
    const slice = options.record[feature.key];
    if (slice === undefined) {
      throw queuePluginError({
        code: QUEUE_PLUGIN_ERROR_CODES.featureMissing,
        message: `[queue] feature token "${feature.key}" was not provided by any earlier plugin.`,
        remediation:
          'Mount the feature plugin that provides this token before queueRuntime(...). The typed builder catches this unless composition was erased.',
        docsSlug: 'arki-queue-e005',
      });
    }
    if (slice.queue !== undefined) {
      registry[feature.key] = slice.queue;
      continue;
    }
    debugWorker('[%s] Feature "%s" did not contribute a queue slice.', 'queue-runtime', feature.key);
  }
  return registry;
}

function timeoutAfter(ms: number, pluginName: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        queuePluginError({
          code: QUEUE_PLUGIN_ERROR_CODES.startupTimeout,
          message: `[queue] runtime "${pluginName}" startup timed out after ${String(ms)}ms.`,
          remediation:
            'Check Redis connectivity and worker dependency assembly, or raise startupTimeoutMs if the runtime intentionally needs more time.',
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
 * `schedule({ ..., durable: DurableSchedules })`. Boot only builds the
 * backend; Redis is touched when the schedule plugin starts it.
 */
export function durableScheduler(
  options: DurableSchedulerPluginOptions,
): Plugin<EmptyShape, { readonly [DURABLE_SCHEDULES_KEY]: DurableScheduler }> {
  return plugin({
    name: options.name ?? 'durable-scheduler',
    version: QUEUE_RUNTIME_PLUGIN_VERSION,
    configure(ctx) {
      ctx.declareProvides('durable-scheduler');
    },
    boot: () => ({ [DURABLE_SCHEDULES_KEY]: createDurableScheduler(options) }),
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

/**
 * Build a DOT plugin that owns queue worker lifecycle while the app keeps
 * ownership of concrete runtime assembly.
 */
export function queueRuntime<TNeeds extends NeedsShape & NoReservedKeys>(
  options: QueueRuntimeOptions<TNeeds>,
): Plugin<WireNeeds<TNeeds>, EmptyShape>;
export function queueRuntime<
  TNeeds extends NeedsShape & NoReservedKeys,
  TContext,
  const TFeatures extends readonly QueueFeatureToken[],
>(
  options: QueueRuntimeFeatureOptions<TNeeds, TContext, TFeatures>,
): Plugin<WireNeeds<TNeeds> & QueueFeatureNeeds<TFeatures>, EmptyShape>;
export function queueRuntime<
  TNeeds extends NeedsShape & NoReservedKeys,
  TContext,
  const TFeatures extends readonly QueueFeatureToken[],
>(
  options: QueueRuntimeOptions<TNeeds> | QueueRuntimeFeatureOptions<TNeeds, TContext, TFeatures>,
): Plugin<WireNeeds<TNeeds>, EmptyShape> {
  assertExclusiveMode(options as QueueRuntimeOptions<NeedsShape & NoReservedKeys> | QueueRuntimeFeatureOptions<NeedsShape & NoReservedKeys, unknown, readonly QueueFeatureToken[]>);
  const pluginName = options.name ?? 'queue-runtime';
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const blocking = options.blocking ?? false;
  const registry = 'registry' in options ? options.registry : {};

  let started = false;
  let handle: QueueRuntimeHandle | undefined;
  let startup: Promise<QueueRuntimeHandle | void> | undefined;

  const runStartup = async (ctx: CtxOf<TNeeds> & Readonly<Record<string, unknown>>): Promise<QueueRuntimeHandle> => {
    const start = async (): Promise<QueueRuntimeHandle> => {
      if ('registry' in options) {
        return options.start(ctx);
      }

      const features = featureRegistry({
        features: options.features,
        record: ctx as Readonly<Record<string, { readonly queue?: QueueRegistry } | undefined>>,
      });
      // Context is assembled exactly ONCE, inside the guarded start: an
      // assembly failure (missing creds) must degrade boot like any other
      // startup failure instead of failing every job run, and expensive
      // context graphs must not be rebuilt per execution. Per-run
      // enrichment belongs to job middleware, not this factory.
      const resolvedContext = await options.context(ctx);
      const queue: QueueInstance = options.q.createQueue({
        connection: options.connection,
        ...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
        createContext: () => resolvedContext,
      });
      await queue.register(features);
      await queue.start();
      return queue;
    };

    const runtime = await Promise.race([start(), timeoutAfter(startupTimeoutMs, pluginName)]);
    handle = runtime;
    return runtime;
  };

  const needs =
    'registry' in options
      ? options.needs
      : {
          ...options.needs,
          ...Object.fromEntries(options.features.map(feature => [feature.key, feature])),
        };

  const inner = plugin<NeedsShape & NoReservedKeys, EmptyShape>({
    name: pluginName,
    version: QUEUE_RUNTIME_PLUGIN_VERSION,
    needs,
    actions: 'registry' in options ? queueActions(registry) : [],
    configure(ctx) {
      ctx.registerProjection({
        format: 'queue-topology',
        binding: 'queue',
        module: '@arki/queue/projection',
      });
      ctx.declareProvides('queue-runtime');
    },
    async start(ctx) {
      if (started || startup !== undefined) {
        throw queuePluginError({
          code: QUEUE_PLUGIN_ERROR_CODES.doubleStart,
          message: `[queue] runtime "${pluginName}" was started twice.`,
          remediation: 'Call app.start() once, or call app.stop() before starting the queue runtime again.',
          docsSlug: 'arki-queue-e002',
        });
      }

      started = true;
      if (blocking) {
        startup = runStartup(ctx as CtxOf<TNeeds> & Readonly<Record<string, unknown>>);
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

      startup = runStartup(ctx as CtxOf<TNeeds> & Readonly<Record<string, unknown>>).catch((error: unknown) => {
        debugWorker('[%s] Queue runtime startup failed: %s', pluginName, error instanceof Error ? error.message : String(error));
        started = false;
        handle = undefined;
      });
    },
    async stop() {
      if (!started && startup === undefined && handle === undefined) {
        throw queuePluginError({
          code: QUEUE_PLUGIN_ERROR_CODES.stopBeforeStart,
          message: `[queue] runtime "${pluginName}" was stopped before it started.`,
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

  return inner as unknown as Plugin<WireNeeds<TNeeds>, EmptyShape>;
}
