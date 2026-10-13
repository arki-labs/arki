/**
 * The async lane: job claims under a lease, the retry policy, `drain` (one batch),
 * the worker loop around it, waking sleeping workers, and counting jobs no
 * effect of this journal can claim.
 * May import `fold`, `history`, `storage` and leaf files.
 * Must not import `journal`, `api`, `write` or `command`.
 */
import type { z } from 'zod';
import { and, asc, desc, eq, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';

import type { History } from './history.js';
import type { HookPointInternal } from './hooks.js';
import type { JournalTables } from './pg.js';
import type { DbHandle, Effect, EffectHookContext, JournalWorker, RootDb, StrandedJobs } from './types.js';
import { debugDrain, debugWorker } from './debug.js';
import { findEventDefinition } from './fold.js';
import { leaseToken } from './id.js';
import { assertRootDb } from './storage.js';

const DEFAULT_LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 300_000;
const DEFAULT_POLL_MS = 1000;

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Seconds to wait before the next attempt: doubling with jitter, capped at 5 minutes. */
function backoffSeconds(attempts: number): number {
  const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  const jitter = base * (Math.random() * 0.5 - 0.25);
  return Math.round(Math.min(BACKOFF_CAP_MS, base + jitter)) / 1000;
}

/** Database time plus `seconds`. The worker's clock never decides a lease or a retry. */
const dbNowPlus = (seconds: number) => sql`now() + make_interval(secs => ${seconds})`;

type JobRow = JournalTables['jobs']['$inferSelect'];

/** What `drain` needs from the journal. `Run` is the type of an effect's `ctx.run`. */
export type DrainDeps<Meta extends z.ZodObject, AppDb extends RootDb, Run> = {
  readonly tables: JournalTables;
  /** The effect hooks. Frozen by the first drain. */
  readonly hooks: HookPointInternal<EffectHookContext<z.output<Meta>>>;
  readonly effects: readonly Effect<z.output<Meta>, AppDb, Run>[];
  readonly history: Pick<History<Meta>, 'decodeStoredEvent'>;
  /** Makes an effect's `ctx.run`: the journal's `run`, bound to the root database this drain was given and to the event the job is for. */
  readonly runOn: (db: AppDb & RootDb, cause: { readonly seq: number; readonly correlationId: string | null }) => Run;
};

export function createDrain<Meta extends z.ZodObject, AppDb extends RootDb, Run>(deps: DrainDeps<Meta, AppDb, Run>) {
  const { events: eventsTable, jobs: jobsTable } = deps.tables;
  const { decodeStoredEvent } = deps.history;
  const effectsByName = new Map(deps.effects.map(effect => [effect.name, effect]));

  const known = [...effectsByName.keys()];

  // Every time here is database time, so a worker with a skewed clock
  // cannot take a live lease or push a retry into the far future.
  const claimOne = (db: AppDb & RootDb, leaseSeconds: number): Promise<JobRow | undefined> =>
    db.transaction(async (tx): Promise<JobRow | undefined> => {
      const due = await tx
        .select({ id: jobsTable.id })
        .from(jobsTable)
        .where(
          and(
            isNull(jobsTable.deadAt),
            lte(jobsTable.availableAt, sql`now()`),
            or(isNull(jobsTable.leaseUntil), lte(jobsTable.leaseUntil, sql`now()`)),
            inArray(jobsTable.effect, known),
          ),
        )
        .orderBy(desc(jobsTable.priority), asc(jobsTable.availableAt))
        .limit(1)
        .for('update', { skipLocked: true });
      const first = due[0];
      if (first === undefined) return;
      const [claimed] = await tx
        .update(jobsTable)
        .set({
          leaseToken: leaseToken(),
          leaseUntil: dbNowPlus(leaseSeconds),
          attempts: sql`${jobsTable.attempts} + 1`,
        })
        .where(eq(jobsTable.id, first.id))
        .returning();
      return claimed;
    });

  /**
   * Keeps the lease alive while the effect runs: every half lease, push `lease_until`
   * out by a full lease, under this worker's token. Zero rows means the lease was
   * lost (the worker stalled past the lease and another one reclaimed the job):
   * the effect's signal aborts so it can stop, and its ack will find nothing to
   * acknowledge. The timer never keeps the process alive.
   */
  const renewWhile = (db: AppDb & RootDb, job: JobRow, leaseSeconds: number, lost: AbortController) => {
    const token = job.leaseToken ?? '';
    let inFlight = false;
    let finished = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void db
        .update(jobsTable)
        .set({ leaseUntil: dbNowPlus(leaseSeconds) })
        .where(and(eq(jobsTable.id, job.id), eq(jobsTable.leaseToken, token)))
        .returning({ id: jobsTable.id })
        .then(rows => {
          if (rows.length === 0 && !finished) {
            clearInterval(timer);
            lost.abort(new Error(`journal: the lease on job ${job.id} was lost; another worker holds it now`));
          }
        })
        .catch((error: unknown) => debugDrain('%s %s: lease renewal failed: %s', job.effect, job.id, errorText(error)))
        .finally(() => {
          inFlight = false;
        });
    }, leaseSeconds * 500);
    // Node and Bun return a handle with unref(); browsers and Deno return a number.
    const handle: unknown = timer;
    if (typeof handle === 'object' && handle !== null && 'unref' in handle && typeof handle.unref === 'function') {
      handle.unref();
    }
    return () => {
      finished = true;
      clearInterval(timer);
    };
  };

  const runJob = async (db: AppDb & RootDb, job: JobRow, signal: AbortSignal, leaseSeconds: number): Promise<void> => {
    const effect = effectsByName.get(job.effect);
    const lost = new AbortController();
    const stopRenewing = renewWhile(db, job, leaseSeconds, lost);
    try {
      if (effect === undefined) throw new Error(`effect "${job.effect}" is not registered`);
      const [eventRow] = await db.select().from(eventsTable).where(eq(eventsTable.seq, job.eventSeq));
      if (eventRow === undefined) throw new Error(`event seq ${job.eventSeq} not found`);
      const event = decodeStoredEvent(
        eventRow,
        findEventDefinition(effect.entities, eventRow.kind, eventRow.type),
        eventRow.entityId,
      );
      // Inside the lease: a hook that throws fails the job like a handler failure.
      const ownSignal = AbortSignal.any([signal, lost.signal]);
      await deps.hooks.run({ name: job.effect, event, jobId: job.id, attempt: job.attempts }, () =>
        effect.run(event, { jobId: job.id, signal: ownSignal, db, run: deps.runOn(db, event) }),
      );
      await db.delete(jobsTable).where(and(eq(jobsTable.id, job.id), eq(jobsTable.leaseToken, job.leaseToken ?? '')));
      debugDrain('%s %s: done', job.effect, job.id);
    } catch (error) {
      const dead = job.attempts >= MAX_ATTEMPTS;
      await db
        .update(jobsTable)
        .set({
          lastError: errorText(error),
          leaseToken: null,
          leaseUntil: null,
          ...(dead ? { deadAt: sql`now()` } : { availableAt: dbNowPlus(backoffSeconds(job.attempts)) }),
        })
        .where(and(eq(jobsTable.id, job.id), eq(jobsTable.leaseToken, job.leaseToken ?? '')));
      debugDrain(
        '%s %s: attempt %d failed%s: %s',
        job.effect,
        job.id,
        job.attempts,
        dead ? ', dead' : '',
        errorText(error),
      );
    } finally {
      stopRenewing();
    }
  };

  return async (
    db: AppDb & RootDb,
    opts?: { readonly batchSize?: number; readonly signal?: AbortSignal; readonly leaseSeconds?: number },
  ): Promise<number> => {
    assertRootDb(db, 'drain');
    deps.hooks.freeze();
    const batchSize = opts?.batchSize ?? 20;
    const leaseSeconds = opts?.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    const signal = opts?.signal ?? new AbortController().signal;
    if (known.length === 0) return 0;

    // One job is claimed at a time, right before it runs, so its lease starts
    // when its work starts. Claiming the whole batch up front would start every
    // lease at once: while the first jobs ran, the leases of the last ones
    // could run out, and another worker would take them and run them twice.
    // An aborted signal stops the claiming; the job already running finishes.
    let claimed = 0;
    while (claimed < batchSize && !signal.aborted) {
      const job = await claimOne(db, leaseSeconds);
      if (job === undefined) break;
      claimed += 1;
      await runJob(db, job, signal, leaseSeconds);
    }
    return claimed;
  };
}

/**
 * Counts pending jobs whose effect this journal does not have. `drain` never
 * claims them, on purpose: during a rolling deploy an older worker may still
 * have that effect. But once every worker runs the new code, a renamed or
 * removed effect leaves its jobs here for good, so they must be visible.
 */
export function createStrandedJobs(deps: { readonly tables: JournalTables; readonly effectNames: readonly string[] }) {
  const { jobs: jobsTable } = deps.tables;
  return async (db: DbHandle): Promise<readonly StrandedJobs[]> =>
    db
      .select({ effect: jobsTable.effect, jobs: sql<number>`count(*)::int` })
      .from(jobsTable)
      .where(
        and(
          isNull(jobsTable.deadAt),
          deps.effectNames.length > 0 ? notInArray(jobsTable.effect, [...deps.effectNames]) : undefined,
        ),
      )
      .groupBy(jobsTable.effect)
      .orderBy(asc(jobsTable.effect));
}

/** What the worker loop needs from the journal. */
export type WorkerDeps<AppDb extends RootDb> = {
  /** Runs one batch. The journal passes its own `drain` method, looked up on each call. */
  readonly drain: (
    db: AppDb & RootDb,
    opts?: { readonly batchSize?: number; readonly signal?: AbortSignal; readonly leaseSeconds?: number },
  ) => Promise<number>;
};

export function createWorkers<AppDb extends RootDb>(deps: WorkerDeps<AppDb>) {
  /** One wake function per running worker this journal started. */
  const wakers = new Set<() => void>();

  const worker = (
    db: AppDb & RootDb,
    opts?: { readonly pollMs?: number; readonly batchSize?: number; readonly leaseSeconds?: number },
  ): JournalWorker => {
    assertRootDb(db, 'worker');
    const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
    let running = false;
    let loop: Promise<void> = Promise.resolve();
    // Aborted by `stop()`. It reaches the running effect as `ctx.signal`, and
    // `drain` claims no further job once it is aborted.
    let stopping = new AbortController();
    let endSleep: (() => void) | undefined;
    // A wake that arrived during a pass. That pass may have looked before the
    // commit that caused the wake, so one more pass follows it.
    let woken = false;
    const sleep = () =>
      new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          endSleep = undefined;
          resolve();
        }, pollMs);
        endSleep = () => {
          clearTimeout(timer);
          endSleep = undefined;
          resolve();
        };
      });
    // `stop()` and `wake()` flip these from another call while `run` is awaiting.
    const isRunning = () => running;
    const isWoken = () => woken;
    const run = async () => {
      while (isRunning()) {
        woken = false;
        let processed = 0;
        try {
          processed = await deps.drain(db, {
            batchSize: opts?.batchSize,
            signal: stopping.signal,
            leaseSeconds: opts?.leaseSeconds,
          });
        } catch (error) {
          debugWorker('drain failed: %s', errorText(error));
        }
        if (isRunning() && processed === 0 && !isWoken()) await sleep();
      }
    };
    const wake = () => {
      if (!running) return;
      woken = true;
      endSleep?.();
    };
    return {
      start() {
        if (running) return Promise.resolve();
        running = true;
        stopping = new AbortController();
        wakers.add(wake);
        debugWorker('start (poll %dms)', pollMs);
        loop = run();
        return Promise.resolve();
      },
      async stop() {
        running = false;
        stopping.abort();
        // eslint-disable-next-line drizzle/enforce-delete-with-where -- Set#delete, not a Drizzle query
        wakers.delete(wake);
        endSleep?.();
        await loop;
        debugWorker('stopped');
      },
      wake,
    };
  };

  const wakeAll = (): void => {
    for (const wake of wakers) wake();
  };

  return { worker, wakeAll };
}
