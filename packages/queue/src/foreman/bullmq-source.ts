import { createHash } from 'node:crypto';
import type { Job, Queue } from 'bullmq';

import { getLogger } from '@arki/log';

import type { FailedJobRecord, FailedJobSource } from './source.ts';

const log = getLogger('arki:queue');

export type BullMQFailedJobSourceOptions = {
  /**
   * The BullMQ queue to read. Pass a function when the queue is created lazily
   * (for example `() => instance.queues().get('story-generation')`).
   */
  queue: Queue | (() => Queue | Promise<Queue>);
};

/**
 * Changes whenever the job fails again. `finishedOn` and the attempt counters all move on a new failure,
 * and the id ties the revision to this one job.
 */
function revisionOf(job: Job): string {
  return createHash('sha256')
    .update(`${job.id ?? ''}:${job.attemptsMade}:${job.attemptsStarted}:${job.finishedOn ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}

function toRecord(queueName: string, job: Job): FailedJobRecord {
  return {
    id: job.id ?? '',
    name: queueName,
    attempts: job.attemptsMade,
    error: job.failedReason || null,
    failedAt: new Date(job.finishedOn ?? 0),
    revision: revisionOf(job),
  };
}

/**
 * The job, only if BullMQ says it is in the failed state. The id is first looked up as a member of the
 * queue's state sets (`getJobState`), so a hostile id such as "meta" or "failed" is never used as a Redis key
 * name: it is simply not a member of the failed set.
 */
async function loadFailed(queue: Queue, id: string): Promise<Job | undefined> {
  if ((await queue.getJobState(id)) !== 'failed') return undefined;
  return queue.getJob(id);
}

/**
 * Failed jobs of a BullMQ queue.
 *
 * Retry uses BullMQ's own `job.retry('failed')`. That runs one Lua script inside Redis which moves the job
 * out of the `failed` set only if it is still in it. So a duplicate retry is blocked atomically: the second
 * caller finds the job no longer failed and gets `false`.
 *
 * The revision check is NOT part of that script (BullMQ has no conditional-update API and a custom script
 * would copy BullMQ internals). It runs just before the retry, so the race window is the gap between the
 * `getJob` read and the script call (a few Redis round trips). A write slips through that gap only if the
 * job is retried by someone else, runs, and fails again inside it. The job is then in `failed` with a newer
 * revision, and the older approval retries that newer failure once. The effect is one extra run of an
 * already-failed job, never a double run of a job that is queued or active.
 */
export function bullmqFailedJobSource(options: BullMQFailedJobSourceOptions): FailedJobSource {
  async function resolveQueue(): Promise<Queue> {
    return typeof options.queue === 'function' ? options.queue() : options.queue;
  }

  return {
    async listFailed({ limit, offset }) {
      const queue = await resolveQueue();
      const [jobs, total] = await Promise.all([
        queue.getJobs(['failed'], offset, offset + limit - 1, false),
        queue.getFailedCount(),
      ]);
      return { jobs: jobs.map(job => toRecord(queue.name, job)), total };
    },

    async getFailed(id) {
      const queue = await resolveQueue();
      const job = await loadFailed(queue, id);
      return job ? toRecord(queue.name, job) : undefined;
    },

    async retryFailed(id, expectedRevision) {
      const queue = await resolveQueue();
      const job = await loadFailed(queue, id);
      if (!job || revisionOf(job) !== expectedRevision) return false;
      try {
        await job.retry('failed');
        return true;
      } catch (error) {
        // BullMQ throws when the job is no longer in the failed set: another retry won.
        log.debug('retry of {jobId} on {queue} was not applied: {error}', {
          jobId: id,
          queue: queue.name,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
  };
}
