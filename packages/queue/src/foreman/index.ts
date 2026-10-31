/**
 * The Foreman admin module for queues.
 *
 * The Foreman control-plane module for queues: a paged `failedJobs` read and a `retryJob` action.
 * Requires the optional peer `@arki/admin`. The normal `@arki/queue` entry never imports it.
 */
import { z } from 'zod';

import { defineAction, defineModule, defineRead, moduleError, redactSecrets } from '@arki/admin/module';
import { getLogger } from '@arki/log';

import type { FailedJobRecord, FailedJobSource } from './source.ts';
import { observeQueue } from '../debug.ts';
import { QUEUE_FOREMAN_ERROR_CODES } from './errors.ts';

export { QUEUE_FOREMAN_ERROR_CODES, type QueueForemanErrorCode } from './errors.ts';
export { bullmqFailedJobSource, type BullMQFailedJobSourceOptions } from './bullmq-source.ts';
export { pgBossFailedJobSource, type PgBossFailedJobSourceOptions } from './pg-boss-source.ts';

export type { FailedJobRecord, FailedJobSource } from './source.ts';

const log = getLogger('arki:queue');

const MAX_PAGE = 200;
/** Each source reads up to `offset + limit` rows when several queues are merged, so the offset is bounded too. */
const MAX_OFFSET = 10_000;

export const failedJobSchema = z
  .object({
    id: z.string(),
    /** The key the queue was registered under in `queueForemanModule`. */
    queue: z.string(),
    /** The job name. */
    name: z.string(),
    key: z.string().optional(),
    attempts: z.number().int(),
    /** Last error message, with secrets removed. */
    error: z.string().nullable(),
    failedAt: z.iso.datetime(),
  })
  .strict();

export type QueueForemanOptions = {
  /** The queues Foreman may see, by a stable key. Each key is one queue instance's failed-job source. */
  queues: Readonly<Record<string, FailedJobSource>>;
};

function toFailedJob(queue: string, record: FailedJobRecord): z.input<typeof failedJobSchema> {
  return {
    id: record.id,
    queue,
    name: record.name,
    ...(record.key === undefined ? {} : { key: record.key }),
    attempts: record.attempts,
    error: record.error === null ? null : redactSecrets(record.error),
    failedAt: record.failedAt.toISOString(),
  };
}

export function queueForemanModule(options: QueueForemanOptions) {
  const entries = Object.entries(options.queues);

  function sourceFor(queue: string): FailedJobSource {
    const source = options.queues[queue];
    if (!source) {
      throw moduleError(
        QUEUE_FOREMAN_ERROR_CODES.unknownQueue,
        404,
        `No queue is registered under "${queue}".`,
        `Use one of: ${entries.map(([key]) => key).join(', ') || '(none registered)'}.`,
      );
    }
    return source;
  }

  async function requireFailed(queue: string, jobId: string): Promise<FailedJobRecord> {
    const record = await sourceFor(queue).getFailed(jobId);
    if (!record) {
      throw moduleError(
        QUEUE_FOREMAN_ERROR_CODES.notFailed,
        409,
        `Job ${jobId} is not failed any more. It was already re-queued, or it is gone.`,
        'Reload the failed jobs list.',
      );
    }
    return record;
  }

  const failedJobs = defineRead({
    id: 'queue.failedJobs',
    summary: 'Failed jobs, newest first',
    permission: 'queue:read',
    input: z
      .object({
        queue: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_PAGE).default(50),
        offset: z.number().int().min(0).max(MAX_OFFSET).default(0),
      })
      .strict(),
    output: z
      .object({ jobs: z.array(failedJobSchema), total: z.number().int(), nextOffset: z.number().int().nullable() })
      .strict(),
    load: async ({ queue, limit, offset }, _ctx: Record<string, never>) => {
      const scope = queue === undefined ? entries : [[queue, sourceFor(queue)] as const];
      // One source pages natively. Several are merged by time, so each is read up to offset + limit.
      const pages = await Promise.all(
        scope.map(async ([key, source]) => {
          const page = await source.listFailed(
            scope.length === 1 ? { limit, offset } : { limit: offset + limit, offset: 0 },
          );
          return { total: page.total, jobs: page.jobs.map(record => ({ key, record })) };
        }),
      );
      const total = pages.reduce((sum, page) => sum + page.total, 0);
      const merged = pages
        .flatMap(page => page.jobs)
        .toSorted((a, b) => b.record.failedAt.getTime() - a.record.failedAt.getTime());
      const jobs = (scope.length === 1 ? merged : merged.slice(offset, offset + limit)).map(({ key, record }) =>
        toFailedJob(key, record),
      );
      return { jobs, total, nextOffset: offset + jobs.length < total ? offset + jobs.length : null };
    },
  });

  const retryJob = defineAction({
    id: 'queue.retryJob',
    summary: 'Retry one failed job',
    permission: 'queue:write',
    // A retry re-runs the job's side effects once. It never deletes or changes data itself.
    risk: 'low',
    input: z.object({ queue: z.string(), jobId: z.string().min(1) }).strict(),
    previewOutput: z
      .object({
        revision: z.string(),
        queue: z.string(),
        jobId: z.string(),
        name: z.string(),
        key: z.string().optional(),
        attempts: z.number().int(),
        consequence: z.string(),
      })
      .strict(),
    output: z.object({ requeued: z.literal(true), jobId: z.string() }).strict(),
    preview: async ({ queue, jobId }, _ctx: Record<string, never>) => {
      const record = await requireFailed(queue, jobId);
      return {
        revision: record.revision,
        queue,
        jobId,
        name: record.name,
        ...(record.key === undefined ? {} : { key: record.key }),
        attempts: record.attempts,
        consequence: `Job "${record.name}" goes back to the queue and runs again once. If it ran side effects before it failed, they may repeat. A second retry of this failure is blocked.`,
      };
    },
    execute: async ({ queue, jobId }, _ctx: Record<string, never>, permit) => {
      const current = await requireFailed(queue, jobId);
      if (current.revision !== permit.expectedRevision) {
        throw moduleError(
          QUEUE_FOREMAN_ERROR_CODES.staleRevision,
          409,
          `Job ${jobId} changed since the preview (it failed again).`,
          'Preview the retry again and approve the new revision.',
        );
      }
      // The source re-checks the revision inside its write, so two racing retries cannot both win.
      const requeued = await sourceFor(queue).retryFailed(jobId, permit.expectedRevision);
      if (!requeued) {
        throw moduleError(
          QUEUE_FOREMAN_ERROR_CODES.notFailed,
          409,
          `Job ${jobId} was already re-queued since the preview.`,
          'Reload the failed jobs list.',
        );
      }
      observeQueue(() =>
        log.debug('retry accepted for {jobId} on {queue} (execution {executionId})', {
          jobId,
          queue,
          executionId: permit.executionId,
        }),
      );
      return { requeued: true as const, jobId };
    },
  });

  return defineModule({
    id: '@arki/queue',
    version: '1.0.0',
    reads: { failedJobs },
    actions: { retryJob },
    panels: [{ id: 'failed-jobs', renderer: 'arki.queue.failed-jobs', read: 'failedJobs', actions: ['retryJob'] }],
  });
}

export {redactSecrets} from '@arki/admin/module';