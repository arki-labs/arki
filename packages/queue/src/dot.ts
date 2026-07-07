import type { CtxOf, EmptyShape, NeedsShape, Pip, WireNeeds } from '@arki/dot/pip';
import { DotPipError, pip } from '@arki/dot/pip';

import { debugWorker } from './debug.ts';
import type { JobDefinition, JobOptions } from './types/job.ts';

export const QUEUE_ACTION_META_SCHEMA = '@arki/queue/action-meta@1';

export const QUEUE_PIP_ERROR_CODES = {
  startupTimeout: 'ARKI_QUEUE_E001',
  doubleStart: 'ARKI_QUEUE_E002',
  stopBeforeStart: 'ARKI_QUEUE_E003',
} as const;

const QUEUE_RUNTIME_PIP_VERSION = '2.1.0';
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
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

function collectJobs(registry: QueueRegistry, jobs: JobDefinition<unknown, unknown, unknown>[] = []): readonly JobDefinition<unknown, unknown, unknown>[] {
  for (const value of Object.values(registry)) {
    if (isJobDefinition(value)) {
      jobs.push(value);
      continue;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      collectJobs(value as QueueRegistry, jobs);
    }
  }
  return jobs;
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

export function queueConsumerActions(registry: QueueRegistry): readonly QueueDotAction[] {
  return collectJobs(registry).map(job => actionForJob(job, 'in'));
}

export function queueProducerActions(registry: QueueRegistry): readonly QueueDotAction[] {
  return collectJobs(registry).map(job => actionForJob(job, 'out'));
}

function queuePipError(args: {
  code: (typeof QUEUE_PIP_ERROR_CODES)[keyof typeof QUEUE_PIP_ERROR_CODES];
  message: string;
  remediation: string;
  docsSlug: string;
}): DotPipError {
  return new DotPipError({
    code: args.code,
    message: args.message,
    remediation: args.remediation,
    docsUrl: `https://arki.dev/queue/errors/${args.docsSlug}`,
  });
}

function timeoutAfter(ms: number, pipName: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        queuePipError({
          code: QUEUE_PIP_ERROR_CODES.startupTimeout,
          message: `[queue] runtime "${pipName}" startup timed out after ${String(ms)}ms.`,
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
 * Build a DOT pip that owns queue worker lifecycle while the app keeps
 * ownership of concrete runtime assembly.
 */
export function queueRuntime<TNeeds extends NeedsShape & NoReservedKeys>(
  options: QueueRuntimeOptions<TNeeds>,
): Pip<WireNeeds<TNeeds>, EmptyShape> {
  const pipName = options.name ?? 'queue-runtime';
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const blocking = options.blocking ?? false;

  let started = false;
  let handle: QueueRuntimeHandle | undefined;
  let startup: Promise<QueueRuntimeHandle | undefined> | undefined;

  const runStartup = async (ctx: CtxOf<TNeeds>): Promise<QueueRuntimeHandle> => {
    const runtime = await Promise.race([options.start(ctx), timeoutAfter(startupTimeoutMs, pipName)]);
    handle = runtime;
    return runtime;
  };

  const inner = pip<TNeeds, EmptyShape>({
    name: pipName,
    version: QUEUE_RUNTIME_PIP_VERSION,
    needs: options.needs,
    actions: [...queueConsumerActions(options.registry), ...queueProducerActions(options.registry)],
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
        throw queuePipError({
          code: QUEUE_PIP_ERROR_CODES.doubleStart,
          message: `[queue] runtime "${pipName}" was started twice.`,
          remediation: 'Call app.start() once, or call app.stop() before starting the queue runtime again.',
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
        debugWorker('[%s] Queue runtime startup failed: %s', pipName, error instanceof Error ? error.message : String(error));
        started = false;
        handle = undefined;
        return undefined;
      });
    },
    async stop() {
      if (!started && startup === undefined && handle === undefined) {
        throw queuePipError({
          code: QUEUE_PIP_ERROR_CODES.stopBeforeStart,
          message: `[queue] runtime "${pipName}" was stopped before it started.`,
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

  return inner as unknown as Pip<WireNeeds<TNeeds>, EmptyShape>;
}
