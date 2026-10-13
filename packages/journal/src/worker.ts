/**
 * The async lane: job claims under a lease, the retry policy, `drain` (one batch),
 * the worker loop around it, waking sleeping workers, and counting jobs no
 * effect of this journal can claim.
 * May import `fold`, `history`, `storage` and leaf files.
 * Must not import `journal`, `api`, `write` or `command`.
 */
import type { z } from 'zod';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, max, notInArray, or, sql } from 'drizzle-orm';

import type { History } from './history.js';
import type { HookPointInternal } from './hooks.js';
import type { JournalTables } from './pg.js';
import type {
  DbHandle,
  Effect,
  EffectHookContext,
  JournalWorker,
  Projection,
  RootDb,
  StrandedJobs,
  Tap,
  TransactionSource,
  Unlisten,
  WakeListener,
} from './types.js';
import { debugDrain, debugWorker } from './debug.js';
import { JournalError } from './errors.js';
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

export type JobRow = JournalTables['jobs']['$inferSelect'];

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
        .catch((error: unknown) =>
          debugDrain.debug('{effect} {jobId}: lease renewal failed: {failed}', {
            effect: job.effect,
            jobId: job.id,
            failed: errorText(error),
          }),
        )
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
      debugDrain.debug('{effect} {jobId}: done', { effect: job.effect, jobId: job.id });
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
      debugDrain.debug('{effect} {jobId}: attempt {attempts} failed{value4}: {value5}', {
        effect: job.effect,
        jobId: job.id,
        attempts: job.attempts,
        value4: dead ? ', dead' : '',
        value5: errorText(error),
      });
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

/** The job verbs an operator uses: list, retry a dead job, discard a dead job. */
export function createAdmin(deps: { readonly tables: JournalTables; readonly wake: () => void }) {
  const { jobs: jobsTable } = deps.tables;

  const jobs = (
    db: DbHandle,
    opts?: { readonly status?: 'pending' | 'dead' | 'all'; readonly effect?: string; readonly limit?: number },
  ): Promise<JobRow[]> => {
    const status = opts?.status ?? 'pending';
    return db
      .select()
      .from(jobsTable)
      .where(
        and(
          status === 'pending' ? isNull(jobsTable.deadAt) : status === 'dead' ? isNotNull(jobsTable.deadAt) : undefined,
          opts?.effect === undefined ? undefined : eq(jobsTable.effect, opts.effect),
        ),
      )
      .orderBy(asc(jobsTable.availableAt))
      .limit(opts?.limit ?? 100);
  };

  /** Dead to pending, in one statement: attempts and lease cleared, due now. Wakes the workers. */
  const retry = async (db: DbHandle, jobId: string): Promise<void> => {
    const rows = await db
      .update(jobsTable)
      .set({ deadAt: null, attempts: 0, lastError: null, leaseToken: null, leaseUntil: null, availableAt: sql`now()` })
      .where(and(eq(jobsTable.id, jobId), isNotNull(jobsTable.deadAt)))
      .returning({ id: jobsTable.id });
    if (rows.length === 0)
      throw new Error(`journal: job ${JSON.stringify(jobId)} is not a dead job; only a dead job is retried`);
    deps.wake();
  };

  /** Delete a dead job. A live one is never deleted here: that would not stop its work, only lose the record of it. */
  const discard = async (db: DbHandle, jobId: string): Promise<void> => {
    const rows = await db
      .delete(jobsTable)
      .where(and(eq(jobsTable.id, jobId), isNotNull(jobsTable.deadAt)))
      .returning({ id: jobsTable.id });
    if (rows.length === 0)
      throw new Error(`journal: job ${JSON.stringify(jobId)} is not a dead job; only a dead job is discarded`);
  };

  return { jobs, retry, discard };
}

/** What the worker loop needs from the journal. */
export type WorkerDeps<AppDb extends RootDb> = {
  /** Runs one batch. The journal passes its own `drain` method, looked up on each call. */
  readonly drain: (
    db: AppDb & RootDb,
    opts?: { readonly batchSize?: number; readonly signal?: AbortSignal; readonly leaseSeconds?: number },
  ) => Promise<number>;
  /** One batch per async projection. Returns how many events were scanned. */
  readonly catchUp: (
    db: AppDb & RootDb,
    opts?: { readonly batchSize?: number },
  ) => Promise<{ readonly scanned: number }>;
  /** Fire the taps for one wake payload. */
  readonly dispatch: (db: AppDb & RootDb, payload: string) => Promise<void>;
  readonly tapNames: readonly string[];
};

/** What the async lane of projections needs from the journal. */
export type CatchUpDeps<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>> = {
  readonly tables: JournalTables;
  readonly projections: readonly Projection<z.output<Meta>, Tx>[];
  readonly history: Pick<History<Meta>, 'decodeStoredEvent'>;
};

const DEFAULT_CATCH_UP_BATCH = 100;

export function createCatchUp<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>>(deps: CatchUpDeps<Meta, Tx>) {
  const { events: eventsTable, cursors: cursorsTable } = deps.tables;
  const { decodeStoredEvent } = deps.history;
  const byName = new Map(deps.projections.map(projection => [projection.name, projection]));

  /** The cursor row, created at 0 if missing, locked for this transaction. */
  const lockCursor = async (tx: DbHandle, name: string): Promise<number> => {
    await tx.insert(cursorsTable).values({ name, seq: 0 }).onConflictDoNothing();
    const [row] = await tx
      .select({ seq: cursorsTable.seq })
      .from(cursorsTable)
      .where(eq(cursorsTable.name, name))
      .for('update');
    if (row === undefined) throw new Error(`journal: cursor "${name}" vanished while locked`);
    return row.seq;
  };

  /**
   * One batch for one projection: lock its cursor, scan the next events in seq order,
   * apply the matching ones, move the cursor to the last event scanned, commit. The
   * cursor is global scan progress, so lag reaches zero and two workers cannot apply
   * one batch twice: the second waits on the row lock and starts after the first moved it.
   */
  const batchFor = async (db: TransactionSource<Tx>, projection: Projection<z.output<Meta>, Tx>, batchSize: number) =>
    db.transaction(async tx => {
      const from = await lockCursor(tx, projection.name);
      const rows = await tx
        .select()
        .from(eventsTable)
        .where(gt(eventsTable.seq, from))
        .orderBy(asc(eventsTable.seq))
        .limit(batchSize);
      const last = rows.at(-1);
      if (last === undefined) return 0;
      const kinds = new Set(projection.entities.map(entity => entity.kind));
      for (const row of rows) {
        if (!kinds.has(row.kind) || !projection.types.has(row.type)) continue;
        await projection.run(
          tx,
          decodeStoredEvent(row, findEventDefinition(projection.entities, row.kind, row.type), row.entityId),
        );
      }
      await tx
        .update(cursorsTable)
        .set({ seq: last.seq, updatedAt: sql`now()` })
        .where(eq(cursorsTable.name, projection.name));
      return rows.length;
    });

  const catchUp = async (
    db: RootDb & TransactionSource<Tx>,
    opts?: { readonly batchSize?: number },
  ): Promise<{ readonly scanned: number }> => {
    assertRootDb(db, 'catchUp');
    const batchSize = opts?.batchSize ?? DEFAULT_CATCH_UP_BATCH;
    let scanned = 0;
    for (const projection of deps.projections) {
      // One projection's failure leaves the others running; its batch rolled back and runs again next pass.
      try {
        scanned += await batchFor(db, projection, batchSize);
      } catch (error) {
        debugDrain.debug('projection {projectionName}: batch failed: {failed}', {
          projectionName: projection.name,
          failed: errorText(error),
        });
      }
    }
    return { scanned };
  };

  const reset = async (
    db: RootDb & TransactionSource<Tx>,
    projection: Projection<z.output<Meta>, Tx>,
    clear?: (tx: Tx) => Promise<void>,
  ): Promise<void> => {
    assertRootDb(db, 'reset');
    if (!byName.has(projection.name))
      throw new JournalError(
        'BAD_DEFINITION',
        'projection',
        projection.name,
        `journal: "${projection.name}" is not an async projection of this journal`,
      );
    await db.transaction(async (tx: Tx) => {
      // The lock first, so no batch lands between the clearing and the rewind.
      await lockCursor(tx, projection.name);
      await clear?.(tx);
      await tx
        .update(cursorsTable)
        .set({ seq: 0, updatedAt: sql`now()` })
        .where(eq(cursorsTable.name, projection.name));
    });
  };

  const cursors = async (
    db: DbHandle,
  ): Promise<readonly { readonly name: string; readonly seq: number; readonly lag: number }[]> => {
    const [top] = await db.select({ seq: max(eventsTable.seq) }).from(eventsTable);
    const latest = top?.seq ?? 0;
    const rows = await db.select().from(cursorsTable);
    const stored = new Map(rows.map(row => [row.name, row.seq]));
    return deps.projections.map(projection => {
      const seq = stored.get(projection.name) ?? 0;
      return { name: projection.name, seq, lag: Math.max(0, latest - seq) };
    });
  };

  return { catchUp, reset, cursors };
}

/** What tap dispatch needs from the journal. */
export type TapDispatchDeps<Meta extends z.ZodObject, AppDb extends RootDb> = {
  readonly tables: Pick<JournalTables, 'events'>;
  readonly taps: readonly Tap<z.output<Meta>, AppDb>[];
  readonly history: Pick<History<Meta>, 'decodeStoredEvent'>;
};

/** A wake payload: the seq range one commit recorded. Anything else is ignored. */
const parseRange = (payload: string): { readonly from: number; readonly to: number } | undefined => {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null || !('from' in parsed) || !('to' in parsed)) return undefined;
    const { from, to } = parsed;
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isInteger(from) || !Number.isInteger(to))
      return undefined;
    return from <= to ? { from, to } : undefined;
  } catch {
    return undefined;
  }
};

export function createTapDispatch<Meta extends z.ZodObject, AppDb extends RootDb>(deps: TapDispatchDeps<Meta, AppDb>) {
  const eventsTable = deps.tables.events;
  const kinds = [...new Set(deps.taps.flatMap(tap => tap.entities.map(entity => entity.kind)))];
  const types = [...new Set(deps.taps.flatMap(tap => [...tap.types]))];

  /** Load the committed events in the range that some tap wants, and run each matching tap. Errors are logged, never thrown. */
  const dispatch = async (db: AppDb & RootDb, payload: string): Promise<void> => {
    if (deps.taps.length === 0) return;
    const range = parseRange(payload);
    if (range === undefined) return;
    const rows = await db
      .select()
      .from(eventsTable)
      .where(
        and(
          gte(eventsTable.seq, range.from),
          lte(eventsTable.seq, range.to),
          inArray(eventsTable.kind, kinds),
          inArray(eventsTable.type, types),
        ),
      )
      .orderBy(asc(eventsTable.seq));
    for (const row of rows) {
      for (const tap of deps.taps) {
        if (!tap.types.has(row.type) || !tap.entities.some(entity => entity.kind === row.kind)) continue;
        try {
          const event = deps.history.decodeStoredEvent(
            row,
            findEventDefinition(tap.entities, row.kind, row.type),
            row.entityId,
          );
          await tap.run(event, { db });
        } catch (error) {
          debugDrain.debug('tap {tapName}: {rowType} {entityId} failed: {failed}', {
            tapName: tap.name,
            rowType: row.type,
            entityId: row.entityId,
            failed: errorText(error),
          });
        }
      }
    }
  };
  return dispatch;
}

const quiet = (): void => {
  /* a dispatch failure was logged where it happened */
};

export function createWorkers<AppDb extends RootDb>(deps: WorkerDeps<AppDb>) {
  /** One wake function per running worker this journal started. */
  const wakers = new Set<() => void>();

  const worker = (
    db: AppDb & RootDb,
    opts?: {
      readonly pollMs?: number;
      readonly batchSize?: number;
      readonly leaseSeconds?: number;
      readonly listen?: WakeListener;
      readonly taps?: boolean;
    },
  ): JournalWorker => {
    assertRootDb(db, 'worker');
    if (deps.tapNames.length > 0 && opts?.listen === undefined && opts?.taps !== false)
      throw new Error(
        `journal: this journal has taps (${deps.tapNames.join(', ')}) but the worker has no \`listen\`; taps fire only from the wake channel. Wire LISTEN on journal.wakeChannel, or pass { taps: false } for a worker that runs jobs only`,
      );
    const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
    let unlisten: Unlisten | undefined;
    // Wake payloads dispatch one after another, in the order they arrived.
    let dispatching: Promise<void> = Promise.resolve();
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
          if (isRunning()) {
            const caught = await deps.catchUp(db);
            processed += caught.scanned;
          }
        } catch (error) {
          debugWorker.debug('drain failed: {failed}', { failed: errorText(error) });
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
      async start() {
        if (running) return;
        running = true;
        stopping = new AbortController();
        wakers.add(wake);
        if (opts?.listen !== undefined) {
          unlisten = await opts.listen(payload => {
            wake();
            if (opts.taps === false) return;
            dispatching = dispatching.then(() => deps.dispatch(db, payload)).catch(quiet);
          });
        }
        debugWorker.debug('start (poll {pollMs}ms{value2})', {
          pollMs,
          value2: unlisten === undefined ? '' : ', listening',
        });
        loop = run();
      },
      async stop() {
        running = false;
        stopping.abort();
        wakers.delete(wake);
        endSleep?.();
        await unlisten?.();
        unlisten = undefined;
        await dispatching;
        await loop;
        debugWorker.debug('stopped');
      },
      wake,
    };
  };

  const wakeAll = (): void => {
    for (const wake of wakers) wake();
  };

  return { worker, wakeAll };
}
