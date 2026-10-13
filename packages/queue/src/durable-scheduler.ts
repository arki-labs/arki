/**
 * BullMQ backend for `@arki/schedule` durable schedules.
 *
 * `@arki/schedule` declares the port (`DurableScheduler`) and must not
 * depend on BullMQ, so this module restates the port's shape structurally.
 * The app builder checks the two shapes against each other where
 * `durableScheduler()` provides the service and `schedule({ durable })`
 * needs it.
 */

import type { Job } from 'bullmq';
import { Queue, Worker } from 'bullmq';

import { createLogger } from '@arki/log';

import type { QueueConnection } from './redis-connection.ts';
import { debugSchedule } from './debug.ts';
import { parseRedisConnection } from './redis-connection.ts';

const log = createLogger('arki:queue:durable-scheduler');

/** What one durable tick reports back (`@arki/schedule`'s `ScheduleRunResult`). */
export type DurableRunResult = {
  readonly name: string;
  readonly status: string;
};

/** One durable schedule as `@arki/schedule` hands it over. */
export type DurableScheduleRegistration =
  | {
      readonly name: string;
      readonly cron: string;
      readonly timezone?: string;
      readonly run: () => Promise<DurableRunResult>;
    }
  | {
      readonly name: string;
      readonly everyMs: number;
      readonly run: () => Promise<DurableRunResult>;
    };

export type DurableScheduler = {
  readonly start: (schedules: readonly DurableScheduleRegistration[]) => Promise<void>;
  readonly stop: () => Promise<void>;
};

export type DurableSchedulerOptions = {
  readonly connection: QueueConnection;
  /** BullMQ key prefix. Default `'queue:'`, the same default as `createQueue`. */
  readonly keyPrefix?: string;
};

// Completed and failed tick jobs kept for inspection; older ones are trimmed
// so a frequent cron does not grow Redis without bound.
const KEEP_FINISHED_JOBS = 100;

function queueNameFor(scheduleName: string): string {
  return `schedule.${scheduleName}`;
}

type RepeatSpec = { readonly pattern: string; readonly tz?: string } | { readonly every: number };

function repeatFor(schedule: DurableScheduleRegistration): RepeatSpec {
  if ('cron' in schedule) {
    return schedule.timezone === undefined
      ? { pattern: schedule.cron }
      : { pattern: schedule.cron, tz: schedule.timezone };
  }
  return { every: schedule.everyMs };
}

/**
 * Register the job scheduler unless Redis already holds the same one.
 * Upserting an unchanged scheduler would delete its pending job, and with it
 * the tick that fell due while no worker ran; leaving it keeps that tick.
 */
async function ensureScheduler(queue: Queue, schedule: DurableScheduleRegistration): Promise<void> {
  const repeat = repeatFor(schedule);
  const existing = await queue.getJobScheduler(schedule.name);
  const unchanged =
    existing !== undefined &&
    ('pattern' in repeat
      ? existing.pattern === repeat.pattern && existing.tz === repeat.tz
      : existing.every === repeat.every);
  if (unchanged) {
    debugSchedule('[%s] Durable scheduler unchanged, keeping its pending tick', schedule.name);
    return;
  }
  debugSchedule('[%s] Upserting durable scheduler', schedule.name);
  await queue.upsertJobScheduler(schedule.name, repeat, {
    name: schedule.name,
    data: {},
    opts: { removeOnComplete: KEEP_FINISHED_JOBS, removeOnFail: KEEP_FINISHED_JOBS },
  });
}

/**
 * Create the BullMQ-backed durable scheduler. Inert until `start`: no Redis
 * connection is opened when it is created.
 *
 * Each schedule gets its own BullMQ queue (`schedule.<name>`) holding one job
 * scheduler, and one worker with concurrency 1 in this process. BullMQ hands
 * each tick's job to exactly one worker, so a tick runs once across replicas.
 */
export function createDurableScheduler(options: DurableSchedulerOptions): DurableScheduler {
  const prefix = options.keyPrefix ?? 'queue:';
  let queues: Queue[] = [];
  let workers: Worker[] = [];

  async function startOne(schedule: DurableScheduleRegistration): Promise<void> {
    const connection = parseRedisConnection(options.connection);
    const name = queueNameFor(schedule.name);
    const queue = new Queue(name, { connection, prefix });
    queues.push(queue);
    const worker = new Worker(
      name,
      async (job: Job) => {
        debugSchedule('[%s] Durable tick %s started', schedule.name, job.id);
        const result = await schedule.run();
        if (result.status === 'handler-failed') {
          // Fail the BullMQ job so the failure shows in the board and events.
          throw new Error(`[schedule] durable schedule "${schedule.name}" handler failed.`);
        }
        return result.status;
      },
      { connection, prefix, autorun: false, concurrency: 1 },
    );
    workers.push(worker);

    await ensureScheduler(queue, schedule);
    void worker.run().catch((error: unknown) => {
      log.error('durable schedule worker stopped unexpectedly', {
        schedule: schedule.name,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await worker.waitUntilReady();
  }

  return {
    async start(schedules) {
      for (const schedule of schedules) {
        await startOne(schedule);
      }
    },
    async stop() {
      const closingWorkers = workers;
      const closingQueues = queues;
      workers = [];
      queues = [];
      // Workers first: close() waits for an active tick to finish.
      await Promise.all(closingWorkers.map(worker => worker.close()));
      await Promise.all(closingQueues.map(queue => queue.close()));
    },
  };
}
