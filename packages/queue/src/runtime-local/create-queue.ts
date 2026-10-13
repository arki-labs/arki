/**
 * pg-boss QueueInstance for the runtime-local stack.
 *
 * Implements the same `{ register, start, stop }` interface as @arki/queue's
 * BullMQ-backed createQueueInstance, but drives pg-boss on PGlite instead.
 *
 * Differences from BullMQ:
 * - No flow/DAG support (pg-boss has no FlowProducer).
 * - Workers wake on poll tick (~500ms) not LISTEN/NOTIFY (PGlite swallows LISTEN
 *   but does not deliver notifications; this is expected per Round 2 spike results).
 * - ctx.job is { id, name, attemptsMade } — not a full BullMQ Job instance.
 * - ctx.updateProgress and ctx.log are no-ops (pg-boss has no progress reporting API).
 * - Interval schedules are not supported; use cron patterns.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { Job as BullMQJob } from 'bullmq';
import { getConstructionPlans, PgBoss } from 'pg-boss';

import type { InternalScheduleDefinition } from '../schedule-builder.ts';
import type { QueueInstance, ScheduleDefinition } from '../types/builder.ts';
import type { JobContext, JobDefinition } from '../types/job.ts';
import { debugJob, debugRegister, debugSchedule, debugWorker } from '../debug.ts';
import { duplicateScheduleError } from '../errors.ts';
import { executeMiddlewareChain } from '../middleware.ts';
import { buildPgBossAdapter } from './adapter.ts';

const POLL_INTERVAL_SECONDS = 0.5;
const DEFAULT_SCHEMA = 'infra_pg_boss';

type Registry = {
  [key: string]: JobDefinition<unknown, unknown, unknown> | ScheduleDefinition | Registry;
};

export type RuntimeLocalQueueInstanceOptions<TContext> = {
  pglite: PGlite;
  schema?: string;
  createContext: () => TContext | Promise<TContext>;
};

/** Minimal job shim satisfying what middleware accesses at runtime (job.id, job.name). */
type RLJobShim = {
  id: string;
  name: string;
  attemptsMade: number;
  data: unknown;
  updateProgress: (progress: number) => Promise<void>;
  log: (message: string) => Promise<void>;
};

function makeJobShim(id: string, name: string, data: unknown, attemptsMade = 0): RLJobShim {
  return {
    id,
    name,
    data,
    attemptsMade,
    updateProgress: async () => {},
    log: async msg => console.log(`[${name}] ${msg}`),
  };
}

export function createRuntimeLocalQueueInstance<TContext>(
  options: RuntimeLocalQueueInstanceOptions<TContext>,
): QueueInstance {
  const { pglite, schema = DEFAULT_SCHEMA, createContext } = options;

  let boss: PgBoss | null = null;

  // Job definitions keyed by name — populated at register() time
  const jobDefs = new Map<string, JobDefinition<unknown, unknown, unknown>>();
  // Schedule definitions — populated at register() time
  const scheduleDefs = new Map<string, InternalScheduleDefinition>();

  // ── Queue shim wired into job.trigger() ────────────────────────────────
  // trigger() in job-builder.ts calls `definition._internal._queue.add(...)`.
  // We install a duck-typed shim that routes that call to boss.send().
  function makeQueueShim(jobName: string) {
    return {
      add: async (_name: string, data: unknown, opts?: { priority?: number; delay?: number; jobId?: string }) => {
        if (!boss) throw new Error(`Queue not started — call queue.start() first`);
        const id = await boss.send(jobName, data as object, {
          // pg-boss rejects `priority: undefined` ("priority must be an integer").
          ...(opts?.priority === undefined ? {} : { priority: opts.priority }),
          startAfter: opts?.delay ? new Date(Date.now() + opts.delay) : undefined,
          singletonKey: opts?.jobId,
        });
        return { id: id ?? undefined };
      },
    };
  }

  // ── Registry traversal ─────────────────────────────────────────────────

  function registerJobDef(def: JobDefinition<unknown, unknown, unknown>): void {
    const name = def._internal.name;
    if (jobDefs.has(name)) return;

    // Wire the shim so trigger() routes through pg-boss.
    // Cast matches what trigger() needs: a Queue with an .add() method.
    (def._internal as { _queue?: unknown })._queue = makeQueueShim(name);

    jobDefs.set(name, def);
    debugRegister.debug('[runtime-local] registered job: {job}', { job: name });
    console.log(`✓ Registered job: ${name} (runtime-local)`);
  }

  function registerScheduleDef(def: ScheduleDefinition): void {
    const internal = def._internal as InternalScheduleDefinition;
    if (scheduleDefs.has(internal.name)) throw duplicateScheduleError(internal.name);

    if (internal.type === 'interval') {
      console.warn(
        `[runtime-local] schedule "${internal.name}" uses interval type — not supported on pg-boss. ` +
          `Convert to a cron pattern or handle it manually.`,
      );
      return;
    }

    if (internal.type === 'timeout') {
      console.warn(
        `[runtime-local] schedule "${internal.name}" uses timeout type — not natively supported on pg-boss. ` +
          `Use boss.sendAfter() directly or send a delayed job via trigger().`,
      );
      return;
    }

    // A schedule sends to its job's own queue (an inline schedule's job is
    // anonymous, named after the schedule); ensure that job has a worker.
    registerJobDef(internal.job);

    scheduleDefs.set(internal.name, internal);
    debugSchedule.debug('[runtime-local] registered schedule: {schedule} ({internalValue})', {
      schedule: internal.name,
      internalValue: internal.value,
    });
    console.log(`✓ Registered schedule: ${internal.name} (runtime-local, cron: ${internal.value})`);
  }

  async function traverseRegistry(registry: Registry): Promise<void> {
    for (const value of Object.values(registry)) {
      if (typeof value === 'object' && value !== null) {
        if ('_type' in value) {
          if ((value as { _type: string })._type === 'job') {
            registerJobDef(value as JobDefinition<unknown, unknown, unknown>);
          } else if ((value as { _type: string })._type === 'schedule') {
            registerScheduleDef(value as ScheduleDefinition);
          } else if ((value as { _type: string })._type === 'flow') {
            console.warn('[runtime-local] flow definitions are not supported — skipping.');
          }
        } else if (!Array.isArray(value)) {
          await traverseRegistry(value as Registry);
        }
      }
    }
  }

  // ── Handler execution (mirrors BullMQ path in create-queue.ts) ────────

  async function runJobHandler(
    def: JobDefinition<unknown, unknown, unknown>,
    pgBossJob: { id: string; name: string; data: unknown; retrycount?: number },
  ): Promise<void> {
    const internal = def._internal;
    const validatedData = internal.inputSchema.parse(pgBossJob.data);
    const baseContext = await createContext();

    const shim = makeJobShim(pgBossJob.id, pgBossJob.name, pgBossJob.data, pgBossJob.retrycount ?? 0);

    // Build the initial job context that mirrors what createJobContext() produces
    // in the BullMQ path. Cast the shim to satisfy the BullMQ type signature
    // used by executeMiddlewareChain (it only reads shim.id and shim.name at runtime).
    const jobContext = {
      ...(baseContext as object),
      updateProgress: shim.updateProgress,
      log: shim.log,
      job: shim,
    };

    debugJob.debug('[runtime-local] [{internalName}] executing handler (job {shimId})', {
      internalName: internal.name,
      shimId: shim.id,
    });

    // Same onion as the BullMQ path: the handler runs inside every middleware's next().
    // The handler signature in @arki/queue's type system expects JobContext<TDeps>
    // (BullMQ-shaped). The runtime-local context is structurally equivalent for
    // everything handlers actually access (ctx.job.id, ctx.job.name, updateProgress,
    // log, plus the user's createContext() deps), so the chain hands it over as one.
    await executeMiddlewareChain<typeof jobContext, JobContext<unknown>, unknown>(
      internal.middlewares,
      jobContext,
      validatedData,
      shim as unknown as BullMQJob,
      {},
      ctx => internal.handler(validatedData, ctx),
    );
  }

  // ── Public QueueInstance ───────────────────────────────────────────────

  async function register(registry: Registry): Promise<void> {
    debugRegister.debug('[runtime-local] traversing registry');
    await traverseRegistry(registry);
    console.log('✓ Registration complete (runtime-local)');
  }

  async function start(): Promise<void> {
    debugWorker.debug('[runtime-local] bootstrapping pg-boss schema: {schema}', { schema });

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
      superviseIntervalSeconds: 60,
      maintenanceIntervalSeconds: 60,
    });
    await boss.start();
    debugWorker.debug('[runtime-local] pg-boss started');

    // Register a boss.work() handler for every job.
    for (const [name, def] of jobDefs.entries()) {
      await boss.createQueue(name);
      await boss.work<unknown>(
        name,
        { pollingIntervalSeconds: POLL_INTERVAL_SECONDS, batchSize: 1 },
        async ([pgBossJob]) => {
          if (!pgBossJob) return;
          try {
            await runJobHandler(def, pgBossJob);
          } catch (err) {
            console.error(`[runtime-local] Job ${name} failed:`, err);
            throw err; // let pg-boss mark the job as failed for retry
          }
        },
      );
      debugWorker.debug('[runtime-local] worker started for: {for}', { for: name });
    }

    // Register cron schedules. A schedule is a trigger: boss.schedule sends its
    // data to the job's own queue, keyed by the schedule name so several
    // schedules can target one job; the job's boss.work() above runs it.
    for (const [name, internal] of scheduleDefs.entries()) {
      const pattern = internal.value as string;
      const jobName = internal.job._internal.name;

      await boss.schedule(jobName, pattern, internal.data as object, {
        tz: internal.options?.timezone,
        key: name,
      });

      debugSchedule.debug('[runtime-local] schedule registered: {registered} -> {jobName} (cron: {cron})', {
        registered: name,
        jobName,
        cron: pattern,
      });
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
          debugSchedule.debug('[runtime-local] removing schedule no longer registered: {registered} (key {staleKey})', {
            registered: jobName,
            staleKey: stale.key,
          });
          await boss.unschedule(jobName, stale.key);
        }
      }
    }

    console.log('✓ Queue infrastructure started (runtime-local)');
    console.log(`  - ${jobDefs.size} job(s) registered`);
    console.log(`  - ${scheduleDefs.size} schedule(s) registered`);
  }

  async function stop(): Promise<void> {
    debugWorker.debug('[runtime-local] shutting down');
    if (boss) {
      await boss.stop({ graceful: true });
      boss = null;
    }
    console.log('✓ Queue infrastructure shut down (runtime-local)');
  }

  return { register, start, stop };
}
