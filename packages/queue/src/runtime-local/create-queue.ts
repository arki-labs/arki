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
import { PgBoss, getConstructionPlans } from 'pg-boss';

import type { InternalScheduleDefinition } from '../schedule-builder.ts';
import type { QueueInstance } from '../types/builder.ts';
import type { JobDefinition } from '../types/job.ts';
import type { ScheduleDefinition } from '../types/builder.ts';
import type { QueueMeta } from '../types/queue.ts';
import { executeMiddlewareChain } from '../middleware.ts';
import { debugJob, debugRegister, debugSchedule, debugWorker } from '../debug.ts';
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
    log: async (msg) => console.log(`[${name}] ${msg}`),
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
      add: async (
        _name: string,
        data: unknown,
        opts?: { priority?: number; delay?: number; jobId?: string },
      ) => {
        if (!boss) throw new Error(`Queue not started — call queue.start() first`);
        const id = await boss.send(jobName, data as object, {
          priority: opts?.priority,
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
    debugRegister('[runtime-local] registered job: %s', name);
    console.log(`✓ Registered job: ${name} (runtime-local)`);
  }

  function registerScheduleDef(def: ScheduleDefinition): void {
    const internal = def._internal as InternalScheduleDefinition;
    if (scheduleDefs.has(internal.name)) return;

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

    // If the schedule wraps an existing job, ensure the job is registered.
    if (internal.jobVariant.type === 'existing') {
      registerJobDef(internal.jobVariant.job as JobDefinition<unknown, unknown, unknown>);
    }

    scheduleDefs.set(internal.name, internal);
    debugSchedule('[runtime-local] registered schedule: %s (%s)', internal.name, internal.value);
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

    const shim = makeJobShim(
      pgBossJob.id,
      pgBossJob.name,
      pgBossJob.data,
      pgBossJob.retrycount ?? 0,
    );

    // Build the initial job context that mirrors what createJobContext() produces
    // in the BullMQ path. Cast the shim to satisfy the BullMQ type signature
    // used by executeMiddlewareChain (it only reads shim.id and shim.name at runtime).
    const jobContext = {
      ...(baseContext as object),
      updateProgress: shim.updateProgress,
      log: shim.log,
      job: shim,
    };

    debugJob('[runtime-local] [%s] executing handler (job %s)', internal.name, shim.id);

    const finalContext = await executeMiddlewareChain<typeof jobContext, typeof jobContext>(
      internal.middlewares,
      jobContext,
      validatedData,
      shim as unknown as BullMQJob,
      {} as QueueMeta,
    );

    // The handler signature in @arki/queue's type system expects JobContext<TDeps>
    // (BullMQ-shaped). The runtime-local context is structurally equivalent for
    // everything handlers actually access (ctx.job.id, ctx.job.name, updateProgress,
    // log, plus the user's createContext() deps). Cast through unknown to bridge them.
    await (internal.handler as (data: unknown, ctx: unknown) => Promise<unknown>)(
      validatedData,
      finalContext,
    );
  }

  // ── Public QueueInstance ───────────────────────────────────────────────

  async function register(registry: Registry): Promise<void> {
    debugRegister('[runtime-local] traversing registry');
    await traverseRegistry(registry);
    console.log('✓ Registration complete (runtime-local)');
  }

  async function start(): Promise<void> {
    debugWorker('[runtime-local] bootstrapping pg-boss schema: %s', schema);

    // Pre-run the schema DDL via the multi-statement runner before PgBoss is constructed.
    // This is required because PgBoss's bootstrap is a multi-statement block that only
    // the Simple Query Protocol can execute (see adapter.ts for full explanation).
    const constructionPlan = getConstructionPlans(schema);
    const runSql = pglite.exec.bind(pglite) as typeof pglite.exec;
    await runSql(constructionPlan);

    boss = new PgBoss({
      db: buildPgBossAdapter(pglite),
      schema,
      createSchema: false, // schema already bootstrapped above
      migrate: false,      // same
      superviseIntervalSeconds: 60,
      maintenanceIntervalSeconds: 60,
    });
    await boss.start();
    debugWorker('[runtime-local] pg-boss started');

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
      debugWorker('[runtime-local] worker started for: %s', name);
    }

    // Register cron schedules. boss.schedule creates the repeating job entry;
    // boss.work above handles consumption when the schedule fires.
    for (const [name, internal] of scheduleDefs.entries()) {
      const pattern = internal.value as string;
      const scheduleData = internal.jobVariant.type === 'existing' ? internal.jobVariant.data : {};

      // Create the queue and worker for the schedule's handler.
      await boss.createQueue(name);
      await boss.schedule(name, pattern, scheduleData as object, {
        tz: internal.options?.timezone,
      });

      // Determine handler — either the wrapped job's handler or the inline one.
      const scheduleHandler =
        internal.jobVariant.type === 'existing'
          ? (internal.jobVariant.job as JobDefinition<unknown, unknown, unknown>)
          : null;

      await boss.work<unknown>(
        name,
        { pollingIntervalSeconds: POLL_INTERVAL_SECONDS, batchSize: 1 },
        async ([pgBossJob]) => {
          if (!pgBossJob) return;
          if (scheduleHandler) {
            await runJobHandler(scheduleHandler, pgBossJob);
          } else if (internal.jobVariant.type === 'inline') {
            // Inline handler path
            const iv = internal.jobVariant;
            const validatedData = iv.inputSchema.parse(pgBossJob.data);
            const baseContext = await createContext();
            const shim = makeJobShim(pgBossJob.id, pgBossJob.name, pgBossJob.data);
            const jobContext = { ...(baseContext as object), updateProgress: shim.updateProgress, log: shim.log, job: shim };
            await (iv.handler as (data: unknown, ctx: unknown) => Promise<unknown>)(
              validatedData,
              jobContext,
            );
          }
        },
      );

      debugSchedule('[runtime-local] schedule registered: %s (cron: %s)', name, pattern);
    }

    console.log('✓ Queue infrastructure started (runtime-local)');
    console.log(`  - ${jobDefs.size} job(s) registered`);
    console.log(`  - ${scheduleDefs.size} schedule(s) registered`);
  }

  async function stop(): Promise<void> {
    debugWorker('[runtime-local] shutting down');
    if (boss) {
      await boss.stop({ graceful: true });
      boss = null;
    }
    console.log('✓ Queue infrastructure shut down (runtime-local)');
  }

  return { register, start, stop };
}
