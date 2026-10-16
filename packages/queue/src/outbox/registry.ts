/**
 * The registry walk: a nested record of job, schedule and flow definitions, flattened the way
 * `queue.register()` and `jobs(...)` read it. `dot.ts` and the outbox runner share it.
 */
import type { FlowDefinition, ScheduleDefinition } from '../types/builder.ts';
import type { JobDefinition } from '../types/job.ts';
import { outboxError, OUTBOX_ERROR_CODES } from './errors.ts';

/** A nested record of definitions, as `queue.register()` and `jobs(...)` take it. */
export type QueueRegistry = Record<string, unknown>;

export function isJobDefinition(value: unknown): value is JobDefinition<unknown, unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_type' in value &&
    (value as { _type?: unknown })._type === 'job' &&
    '_internal' in value &&
    typeof (value as { _internal?: { name?: unknown } })._internal?.name === 'string'
  );
}

export function isScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_type' in value &&
    (value as { _type?: unknown })._type === 'schedule'
  );
}

export function isFlowDefinition(value: unknown): value is FlowDefinition {
  return (
    typeof value === 'object' && value !== null && '_type' in value && (value as { _type?: unknown })._type === 'flow'
  );
}

export type QueueDefinition = JobDefinition<unknown, unknown, unknown> | ScheduleDefinition | FlowDefinition;

export function collectQueueDefinitions(
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

/**
 * The registry's jobs by persisted name. Two definitions under one name throw `OUTBOX_E007`:
 * a stored row finds its job by name alone. The same definition listed twice is one job.
 */
export function jobsByName(registry: QueueRegistry): ReadonlyMap<string, JobDefinition<unknown, unknown, unknown>> {
  const byName = new Map<string, JobDefinition<unknown, unknown, unknown>>();
  for (const definition of collectQueueDefinitions(registry)) {
    if (!isJobDefinition(definition)) continue;
    const name = definition._internal.name;
    const known = byName.get(name);
    if (known !== undefined && known !== definition)
      throw outboxError(OUTBOX_ERROR_CODES.duplicateName, `outbox: two jobs in the registry are named "${name}"`);
    byName.set(name, definition);
  }
  return byName;
}
