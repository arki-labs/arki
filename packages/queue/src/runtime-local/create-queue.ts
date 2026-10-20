/**
 * pg-boss QueueInstance for the runtime-local stack.
 *
 * Implements the same `{ register, start, stop }` interface as @arki/queue's
 * BullMQ-backed createQueueInstance, but drives pg-boss on PGlite instead.
 *
 * Differences from BullMQ:
 * - No flow/DAG support (pg-boss has no FlowProducer).
 * - Workers wake on poll tick (~500ms) not LISTEN/NOTIFY: pg-boss sends SQL `LISTEN`
 *   through the adapter, and PGlite does not deliver that. (PGlite's own JS
 *   `client.listen()` does deliver in-process; the journal worker uses it.)
 * - ctx.job is a `JobLike` { id, name, data, attemptsMade } — not a full BullMQ Job instance.
 * - ctx.updateProgress and ctx.log are no-ops (pg-boss has no progress reporting API).
 * - Interval schedules are not supported; use cron patterns.
 */
import type { PGlite } from '@electric-sql/pglite';
import { getConstructionPlans, PgBoss } from 'pg-boss';
import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { parseAsync } from '@arki/schema';

import type { InternalScheduleDefinition } from '../schedule-builder.ts';
import type { JobTriggerResult } from '../trigger.ts';
import type { QueueInstance, RegisterOptions, ScheduleDefinition } from '../types/builder.ts';
import type { JobDefinition, JobLike } from '../types/job.ts';
import { debugJob, debugRegister, debugSchedule, debugWorker, observeQueue } from '../debug.ts';
import { withEnqueueSpan } from '../enqueue-span.ts';
import { duplicateScheduleError } from '../errors.ts';
import { executeJob } from '../job-outcome.ts';
import { defaultJobRetry, jobFailureEnvelope } from '../job-retry.ts';
import { captureJobTrace } from '../job-trace.ts';
import { QueueUnavailable, triggerValidated } from '../trigger.ts';
import { buildPgBossAdapter } from './adapter.ts';
import { pgBossJobId } from './identity.ts';
import { settlePgBossFailure } from './settle.ts';

const POLL_INTERVAL_SECONDS = 0.5;
const DEFAULT_SCHEMA = 'infra_pg_boss';
// A versioned object envelope lets pg-boss transport every JSON schema output, including primitives.
const storedMessage = z.object({
  version: z.literal(1),
  input: z.unknown(),
  trace: z.string().optional(),
  key: z.string().optional(),
});

type Registry = {
  [key: string]: JobDefinition<unknown, unknown, unknown> | ScheduleDefinition | Registry;
};

export type RuntimeLocalQueueInstanceOptions<TContext> = {
  pglite: PGlite;
  schema?: string;
  createContext: () => TContext | Promise<TContext>;
  /** How often pg-boss recovers abandoned claims. Default 60 seconds. */
  superviseIntervalSeconds?: number;
  /** Queue expiry/retention maintenance cadence. Default 60 seconds. */
  maintenanceIntervalSeconds?: number;
  /** Native expiry/heartbeat monitoring claim cadence. Default 60 seconds. */
  monitorIntervalSeconds?: number;
};

/** Minimal job shim satisfying what middleware accesses at runtime (job.id, job.name). */
function makeJobShim(id: string, name: string, data: unknown, attemptsMade = 0): JobLike {
  return {
    id,
    name,
    data,
    attemptsMade,
    updateProgress: async () => {},
    log: async msg => {
      observeQueue(() => debugJob.info('[{job}] {message}', { job: name, message: msg }));
    },
  };
}

export function createRuntimeLocalQueueInstance<TContext>(
  options: RuntimeLocalQueueInstanceOptions<TContext>,
): QueueInstance {
  const { pglite, schema = DEFAULT_SCHEMA, createContext } = options;
  if (!/^[a-z_]\w*$/i.test(schema)) throw new Error(`Invalid pg-boss schema name: ${schema}`);

  let boss: PgBoss | null = null;

  // Job definitions keyed by name — populated at register() time
  const jobDefs = new Map<string, JobDefinition<unknown, unknown, unknown>>();
  // The services of the feature that registered each job (`RegisterOptions.services`), by job name
  const jobServices = new Map<string, object>();
  // Schedule definitions — populated at register() time
  const scheduleDefs = new Map<string, InternalScheduleDefinition>();

  // ── Registry traversal ─────────────────────────────────────────────────

  function registerJobDef(def: JobDefinition<unknown, unknown, unknown>, services: object | undefined): void {
    const name = def._internal.name;
    if (jobDefs.has(name)) return;
    if (services !== undefined) jobServices.set(name, services);

    def._internal._trigger = (data, opts): Promise<JobTriggerResult> => {
      const activeBoss = boss;
      if (activeBoss === null) return withEnqueueSpan(() => QueueUnavailable(), name);
      return triggerValidated(
        def._internal.inputSchema,
        data,
        opts?.jobId,
        async key => {
          const acknowledged = await activeBoss.send(
            name,
            { version: 1, input: data, trace: captureJobTrace(), key },
            {
              ...(opts?.priority === undefined ? {} : { priority: opts.priority }),
              startAfter: opts?.delay ? new Date(Date.now() + opts.delay) : undefined,
              // Explicit ids provide durable duplicate suppression; singleton keys expire with retention.
              id: pgBossJobId(name, key),
            },
          );
          if (acknowledged === null && !(await activeBoss.getJobById(name, pgBossJobId(name, key)))) return;
          return key;
        },
        name,
      );
    };

    jobDefs.set(name, def);
    observeQueue(() => debugRegister.debug('[runtime-local] registered job: {job}', { job: name }));
  }

  function registerScheduleDef(def: ScheduleDefinition, services: object | undefined): void {
    const internal = def._internal as InternalScheduleDefinition;
    if (scheduleDefs.has(internal.name)) throw duplicateScheduleError(internal.name);

    if (internal.type === 'interval') {
      observeQueue(() =>
        debugSchedule.warn(
          '[runtime-local] schedule {schedule} uses interval type — not supported on pg-boss. ' +
            'Convert to a cron pattern or handle it manually.',
          { schedule: internal.name },
        ),
      );
      return;
    }

    if (internal.type === 'timeout') {
      observeQueue(() =>
        debugSchedule.warn(
          '[runtime-local] schedule {schedule} uses timeout type — not natively supported on pg-boss. ' +
            'Use boss.sendAfter() directly or send a delayed job via trigger().',
          { schedule: internal.name },
        ),
      );
      return;
    }

    // A schedule sends to its job's own queue (an inline schedule's job is
    // anonymous, named after the schedule); ensure that job has a worker.
    registerJobDef(internal.job, services);

    scheduleDefs.set(internal.name, internal);
    observeQueue(() =>
      debugSchedule.debug('[runtime-local] registered schedule: {schedule} ({internalValue})', {
        schedule: internal.name,
        internalValue: internal.value,
      }),
    );
  }

  async function traverseRegistry(registry: Registry, services: object | undefined): Promise<void> {
    for (const value of Object.values(registry)) {
      if (typeof value === 'object' && value !== null) {
        if ('_type' in value) {
          if ((value as { _type: string })._type === 'job') {
            registerJobDef(value as JobDefinition<unknown, unknown, unknown>, services);
          } else if ((value as { _type: string })._type === 'schedule') {
            registerScheduleDef(value as ScheduleDefinition, services);
          } else if ((value as { _type: string })._type === 'flow') {
            observeQueue(() => debugRegister.warn('[runtime-local] flow definitions are not supported — skipping'));
          }
        } else if (!Array.isArray(value)) {
          await traverseRegistry(value as Registry, services);
        }
      }
    }
  }

  // ── Public QueueInstance ───────────────────────────────────────────────

  async function register(registry: Registry, options?: RegisterOptions): Promise<void> {
    observeQueue(() => debugRegister.debug('[runtime-local] traversing registry'));
    // Each top-level branch runs with its own services (a feature's, keyed by its name), if any
    for (const [key, value] of Object.entries(registry)) {
      await traverseRegistry({ [key]: value }, options?.services?.[key]);
    }
  }

  async function start(): Promise<void> {
    observeQueue(() => debugWorker.debug('[runtime-local] bootstrapping pg-boss schema: {schema}', { schema }));

    // Pre-run the schema DDL via the multi-statement runner before PgBoss is constructed.
    // This is required because PgBoss's bootstrap is a multi-statement block that only
    // the Simple Query Protocol can execute (see adapter.ts for full explanation).
    // Only on a fresh database: the plan is not idempotent ("type job_state
    // already exists"), so a restart on a persisted PGlite would fail here.
    const installed = await pglite.query<{ name: string | null }>('select to_regclass($1)::text as name', [
      `${schema}.version`,
    ]);
    if (!installed.rows[0]?.name) {
      await pglite.exec(getConstructionPlans(schema));
    }

    boss = new PgBoss({
      db: buildPgBossAdapter(pglite),
      schema,
      createSchema: false, // schema already bootstrapped above
      migrate: false, // same
      superviseIntervalSeconds: options.superviseIntervalSeconds ?? 60,
      maintenanceIntervalSeconds: options.maintenanceIntervalSeconds ?? 60,
      monitorIntervalSeconds: options.monitorIntervalSeconds ?? 60,
    });
    await boss.start();
    observeQueue(() => debugWorker.debug('[runtime-local] pg-boss started'));

    // Register a boss.work() handler for every job.
    for (const [name, def] of jobDefs.entries()) {
      const retry = def._internal.options?.retry ?? defaultJobRetry;
      // Native supervision handles provider failures and abandoned claims. Handler outcomes
      // are settled exactly once by settlePgBossFailure, with their own Backoff decision.
      await boss.createQueue(name, {
        retryLimit: Number.isFinite(retry.maxRetries) ? retry.maxRetries : 2_147_483_647,
        ...def._internal.options?.runtimeLocalOptions,
      });
      const activeBoss = boss;
      await activeBoss.work<unknown>(
        name,
        { pollingIntervalSeconds: POLL_INTERVAL_SECONDS, batchSize: 1 },
        async ([pgBossJob]) => {
          if (!pgBossJob) return;
          const message = await parseAsync(storedMessage, pgBossJob.data);
          const outcome = isFailure(message)
            ? message
            : await executeJob(
                def._internal,
                makeJobShim(message.key ?? pgBossJob.id, name, message.input, pgBossJob.retryCount),
                createContext,
                jobServices.get(name),
                pgBossJob.signal,
                message.trace,
              );
          if (isFailure(outcome)) {
            await settlePgBossFailure(
              pglite,
              activeBoss,
              schema,
              name,
              pgBossJob,
              jobFailureEnvelope(outcome),
              retry.delay(pgBossJob.retryCount + 1, outcome),
            );
            return;
          }
          return outcome;
        },
      );
      observeQueue(() => debugWorker.debug('[runtime-local] worker started for: {for}', { for: name }));
    }

    // Register cron schedules. A schedule is a trigger: boss.schedule sends its
    // data to the job's own queue, keyed by the schedule name so several
    // schedules can target one job; the job's boss.work() above runs it.
    for (const [name, internal] of scheduleDefs.entries()) {
      const pattern = internal.value as string;
      const jobName = internal.job._internal.name;

      await boss.schedule(
        jobName,
        pattern,
        { version: 1, input: internal.data },
        {
          tz: internal.options?.timezone,
          key: name,
        },
      );

      observeQueue(() =>
        debugSchedule.debug('[runtime-local] schedule registered: {registered} -> {jobName} (cron: {cron})', {
          registered: name,
          jobName,
          cron: pattern,
        }),
      );
    }

    // Drop schedules no longer in code. Each schedule is keyed by its name on
    // its job's queue, so a renamed or deleted one leaves a keyed entry the
    // job's worker would keep running. Unkeyed entries are not ours: leave them.
    const liveKeys = new Map<string, Set<string>>();
    for (const [name, internal] of scheduleDefs.entries()) {
      const jobName = internal.job._internal.name;
      liveKeys.set(jobName, (liveKeys.get(jobName) ?? new Set<string>()).add(name));
    }
    for (const jobName of jobDefs.keys()) {
      for (const stale of await boss.getSchedules(jobName)) {
        if (stale.key !== '' && !liveKeys.get(jobName)?.has(stale.key)) {
          observeQueue(() =>
            debugSchedule.debug(
              '[runtime-local] removing schedule no longer registered: {registered} (key {staleKey})',
              {
                registered: jobName,
                staleKey: stale.key,
              },
            ),
          );
          await boss.unschedule(jobName, stale.key);
        }
      }
    }

    observeQueue(() =>
      debugRegister.debug('queue infrastructure started (runtime-local): {jobs} jobs, {schedules} schedules', {
        jobs: jobDefs.size,
        schedules: scheduleDefs.size,
      }),
    );
  }

  async function stop(): Promise<void> {
    observeQueue(() => debugWorker.debug('[runtime-local] shutting down'));
    if (boss) {
      await boss.stop({ graceful: true });
      boss = null;
    }
  }

  return { register, start, stop };
}
