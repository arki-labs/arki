/**
 * The async lane: job claims under a lease, the retry policy, `drain` (one batch),
 * the worker loop around it, and waking sleeping workers.
 * May import `fold`, `history`, `storage` and leaf files.
 * Must not import `journal`, `api`, `write` or `command`.
 */
import type { z } from 'zod';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import type { History } from './history.js';
import type { JournalTables } from './pg.js';
import type { Effect, JournalWorker, RootDb } from './types.js';
import { debugDrain, debugWorker } from './debug.js';
import { findEventDefinition } from './fold.js';
import { leaseToken } from './id.js';
import { assertRootDb } from './storage.js';

const LEASE_SECONDS = 60;
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

/** What `drain` needs from the journal. `Run` is the type of an effect's `ctx.run`. */
export type DrainDeps<Meta extends z.ZodObject, AppDb extends RootDb, Run> = {
  readonly tables: JournalTables;
  readonly effects: readonly Effect<z.output<Meta>, AppDb, Run>[];
  readonly history: Pick<History<Meta>, 'decodeStoredEvent'>;
  /** Makes an effect's `ctx.run`: the journal's `run`, bound to the root database this drain was given. */
  readonly runOn: (db: AppDb & RootDb) => Run;
};

export function createDrain<Meta extends z.ZodObject, AppDb extends RootDb, Run>(deps: DrainDeps<Meta, AppDb, Run>) {
  const { events: eventsTable, jobs: jobsTable } = deps.tables;
  const { decodeStoredEvent } = deps.history;
  const effectsByName = new Map(deps.effects.map(effect => [effect.name, effect]));

  return async (
    db: AppDb & RootDb,
    opts?: { readonly batchSize?: number; readonly signal?: AbortSignal },
  ): Promise<number> => {
    assertRootDb(db, 'drain');
    const batchSize = opts?.batchSize ?? 20;
    const signal = opts?.signal ?? new AbortController().signal;
    const known = [...effectsByName.keys()];
    if (known.length === 0) return 0;

    // Every time here is database time, so a worker with a skewed clock
    // cannot take a live lease or push a retry into the far future.
    const claimed = await db.transaction(async tx => {
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
        .orderBy(asc(jobsTable.availableAt))
        .limit(batchSize)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      const token = leaseToken();
      return tx
        .update(jobsTable)
        .set({
          leaseToken: token,
          leaseUntil: dbNowPlus(LEASE_SECONDS),
          attempts: sql`${jobsTable.attempts} + 1`,
        })
        .where(
          inArray(
            jobsTable.id,
            due.map(job => job.id),
          ),
        )
        .returning();
    });
    if (claimed.length === 0) return 0;

    const eventRows = await db
      .select()
      .from(eventsTable)
      .where(
        inArray(
          eventsTable.seq,
          claimed.map(job => job.eventSeq),
        ),
      );
    const eventBySeq = new Map(eventRows.map(row => [row.seq, row]));

    for (const job of claimed) {
      const effect = effectsByName.get(job.effect);
      const eventRow = eventBySeq.get(job.eventSeq);
      try {
        if (effect === undefined) throw new Error(`effect "${job.effect}" is not registered`);
        if (eventRow === undefined) throw new Error(`event seq ${job.eventSeq} not found`);
        const event = decodeStoredEvent(
          eventRow,
          findEventDefinition(effect.entities, eventRow.kind, eventRow.type),
          eventRow.entityId,
        );
        await effect.run(event, { jobId: job.id, signal, db, run: deps.runOn(db) });
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
      }
    }
    return claimed.length;
  };
}

/** What the worker loop needs from the journal. */
export type WorkerDeps<AppDb extends RootDb> = {
  /** Runs one batch. The journal passes its own `drain` method, looked up on each call. */
  readonly drain: (db: AppDb & RootDb, opts?: { readonly batchSize?: number }) => Promise<number>;
};

export function createWorkers<AppDb extends RootDb>(deps: WorkerDeps<AppDb>) {
  /** One wake function per running worker this journal started. */
  const wakers = new Set<() => void>();

  const worker = (
    db: AppDb & RootDb,
    opts?: { readonly pollMs?: number; readonly batchSize?: number },
  ): JournalWorker => {
    assertRootDb(db, 'worker');
    const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
    let running = false;
    let loop: Promise<void> = Promise.resolve();
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
          processed = await deps.drain(db, { batchSize: opts?.batchSize });
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
        wakers.add(wake);
        debugWorker('start (poll %dms)', pollMs);
        loop = run();
        return Promise.resolve();
      },
      async stop() {
        running = false;
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
