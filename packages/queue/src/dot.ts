/**
 * DOT topology helpers for @arki/queue.
 *
 * These helpers are structural: they return objects with the same shape DOT's
 * `actions:` declaration accepts, without importing @arki/dot.
 */

import type { JobDefinition, JobOptions } from './types/job.ts';

export const QUEUE_ACTION_META_SCHEMA = '@arki/queue/action-meta@1';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type QueueDotAction = {
  readonly id: string;
  readonly binding: 'queue';
  readonly direction: 'in' | 'out';
  readonly address: string;
  readonly summary?: string;
  readonly metaSchema: typeof QUEUE_ACTION_META_SCHEMA;
  readonly meta: JsonObject;
};

type QueueRegistry = Record<string, unknown>;

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
