/**
 * Postgres advisory locks as a hold store: `pgSession(db)` owns a pinned
 * transaction for the whole life of a lock; `pgTransaction(tx)` takes the lock
 * inside a transaction the caller already has, and the caller's COMMIT or
 * ROLLBACK ends it.
 *
 * Why a transaction, even for "session" locks: a pool hands each query to
 * whichever connection is free, so a session-level lock and its unlock could
 * land on different connections and the lock would leak. Here acquire, work
 * and release always happen inside ONE `db.transaction(cb)`, which pins one
 * connection. The lock is a transaction-level advisory lock, so ending the
 * transaction (commit, rollback, or a dead connection) is what frees it: there
 * is no unlock statement that can fail and leave the lock behind.
 *
 * While a lock is held, the pinned connection runs a short `pg_sleep` in a
 * loop. That does two jobs. A dropped connection fails the running query, so
 * the holder learns the lock is lost within a beat (`Grant.lost`). And a
 * connection that always has a query in flight reports its death to that
 * query, not as an unhandled `error` event on an idle client. A beat that does
 * not come back within `HOLD_BEAT_TIMEOUT_MS` (a silent network: no FIN, no
 * RST) also counts as lost: the server may already have freed the lock.
 *
 * Key spaces: by default a key is the two-int4 pair from `toPgPair`.
 * `legacyKeys: true` uses `hashtext('<namespace>:<name>')` as one bigint key,
 * which is what `@arki/db`'s `withAdvisoryLock` locks today. The two spaces do
 * NOT exclude each other: during a rolling deploy, every replica must use the
 * same setting.
 *
 * Read/write locks (`shared: true`): a read hold is `pg_advisory_xact_lock_shared`, a write
 * hold the exclusive lock, on the same pair space (read/write keys differ from mutex keys
 * by their `1rw:` prefix). Same pinned transaction, beat, wait slices and `lost` as the
 * mutex. `legacyKeys` applies to mutexes only. Postgres has no writer preference, so
 * `SharedOps.waiter` is not implemented and a steady stream of readers can starve a writer.
 *
 * PGlite note: advisory locks there are process-local (one connection), so it
 * can only check the SQL shape of this store, never cross-replica exclusion.
 */
import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import { getLogger } from '@arki/log';

import type {
  AcquireRequest,
  Grant,
  Guarantees,
  Key,
  ReleaseOutcome,
  SharedOps,
  SharedRequest,
  Store,
} from '../types.js';
import { LockError } from '../errors.js';
import { legacyPgText, toPgPair } from '../key.js';

const log = getLogger('arki:lock');

/** The least a transaction handle must offer: run raw SQL (node-postgres, PGlite, postgres.js through Drizzle). */
export type PgExecutor = { execute(query: SQL): PromiseLike<unknown> };

/** The least a database must offer: a transaction whose handle runs raw SQL. */
export type LockableDb = {
  transaction<T>(run: (tx: PgExecutor) => Promise<T>): Promise<T>;
};

export type PgLockOptions = {
  /**
   * Lock `hashtext('<namespace>:<name>')` (one bigint key) like `@arki/db`'s old
   * `withAdvisoryLock` did. Replicas on the legacy and the default key space do
   * not exclude each other, so a rolling deploy must switch every replica together.
   */
  readonly legacyKeys?: boolean;
};

export type PgSessionOptions = PgLockOptions & {
  /**
   * Beat on the pinned connection while held, so a dead or silent connection
   * resolves `Grant.lost`. Default `true`. Turn it off for in-process databases
   * such as PGlite, where there is no connection to lose and each beat would
   * block the thread; grants then carry no `lost`.
   */
  readonly keepAlive?: boolean;
};

const hold = {
  kind: 'hold',
  scope: 'cluster',
  wait: 'native',
  shared: true,
  permits: false,
  fence: false,
  releasedOnCrash: 'immediate',
  clock: 'none',
  poolerSafe: true,
  runtimes: ['node', 'bun', 'deno'],
} as const satisfies Guarantees;

export type PgSessionGuarantees = typeof hold;
const heldByTransaction = { ...hold, releasedBy: 'transaction' } as const satisfies Guarantees;
export type PgTransactionGuarantees = typeof heldByTransaction;

/** Longest single `lock_timeout` slice of a wait; a caller's signal is honoured between slices. */
export const WAIT_SLICE_MS = 1000;
/** Length of one beat of the pinned connection while a lock is held. */
export const HOLD_BEAT_SECONDS = 0.2;
/** A beat still unanswered after this long means a silent connection; the hold is reported lost. */
export const HOLD_BEAT_TIMEOUT_MS = 5000;

const LOCK_TIMEOUT_CODE = '55P03';
const SAVEPOINT = 'arki_lock_wait';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `{ rows: [...] }` (node-postgres, PGlite) or a bare array (postgres.js): the first row, if any. */
function firstRow(result: unknown): Record<string, unknown> | undefined {
  const rows: unknown = Array.isArray(result) ? result : isRecord(result) ? result['rows'] : undefined;
  const first: unknown = Array.isArray(rows) ? rows[0] : undefined;
  return isRecord(first) ? first : undefined;
}

function wasAcquired(result: unknown): boolean {
  return firstRow(result)?.['acquired'] === true;
}

/** Drizzle wraps driver errors; the Postgres code sits on the error or one of its causes. */
function hasPgCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && isRecord(current); depth++) {
    if (current['code'] === code) return true;
    current = current['cause'];
  }
  return false;
}

/** A mutex and a write hold take the exclusive lock; a read hold takes the shared one. */
type LockMode = 'exclusive' | 'shared';

/**
 * What one attempt locks. `legacy` (the old `hashtext` key space) exists for mutexes
 * only: read/write locks never had a legacy key, so they always use the pair.
 */
type Target = { readonly key: Key; readonly legacy: boolean; readonly mode: LockMode };

const modeOf = (request: SharedRequest): LockMode => (request.mode === 'read' ? 'shared' : 'exclusive');

function tryLockSql({ key, legacy, mode }: Target): SQL {
  if (legacy) return sql`select pg_try_advisory_xact_lock(hashtext(${legacyPgText(key)})) as acquired`;
  const { hi, lo } = toPgPair(key);
  return mode === 'shared'
    ? sql`select pg_try_advisory_xact_lock_shared(${hi}::int4, ${lo}::int4) as acquired`
    : sql`select pg_try_advisory_xact_lock(${hi}::int4, ${lo}::int4) as acquired`;
}

function blockingLockSql({ key, legacy, mode }: Target): SQL {
  if (legacy) return sql`select pg_advisory_xact_lock(hashtext(${legacyPgText(key)}))`;
  const { hi, lo } = toPgPair(key);
  return mode === 'shared'
    ? sql`select pg_advisory_xact_lock_shared(${hi}::int4, ${lo}::int4)`
    : sql`select pg_advisory_xact_lock(${hi}::int4, ${lo}::int4)`;
}

const settingOr = (value: unknown): string => (typeof value === 'string' ? value : '0');

/**
 * One slice of a wait: block on the lock for at most `sliceMs`. A timeout is an
 * error that would poison the transaction, so the slice runs in a savepoint and
 * a timeout rolls back to it. `lock_timeout` bounds the slice, so a shorter
 * `statement_timeout` is lifted for it (or it would cancel every slice); both
 * are put back as they were.
 */
async function waitSlice(tx: PgExecutor, target: Target, sliceMs: number): Promise<boolean> {
  const previous = firstRow(
    await tx.execute(
      sql`select current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout`,
    ),
  );
  await tx.execute(sql.raw(`savepoint ${SAVEPOINT}`));
  try {
    await tx.execute(
      sql`select set_config('lock_timeout', ${`${sliceMs}ms`}, true), set_config('statement_timeout', '0', true)`,
    );
    await tx.execute(blockingLockSql(target));
  } catch (error) {
    if (!hasPgCode(error, LOCK_TIMEOUT_CODE)) throw error;
    await tx.execute(sql.raw(`rollback to savepoint ${SAVEPOINT}`));
    return false;
  }
  await tx.execute(
    sql`select set_config('lock_timeout', ${settingOr(previous?.['lock_timeout'])}, true), set_config('statement_timeout', ${settingOr(previous?.['statement_timeout'])}, true)`,
  );
  await tx.execute(sql.raw(`release savepoint ${SAVEPOINT}`));
  return true;
}

/** When a wait of `waitMs` asked for now ends; `undefined` = one attempt. */
function waitDeadline(waitMs: number | undefined): number | undefined {
  return waitMs === undefined || waitMs <= 0 ? undefined : performance.now() + waitMs;
}

/**
 * One attempt, or (with a `deadline`) attempts in bounded slices until the lock
 * comes, the deadline passes, or `signal` aborts. A deadline already gone (the
 * wait was spent queueing for a connection) still gets one instant attempt.
 */
async function takeLock(
  tx: PgExecutor,
  target: Target,
  deadline: number | undefined,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (deadline === undefined || deadline <= performance.now()) {
    return wasAcquired(await tx.execute(tryLockSql(target)));
  }
  for (;;) {
    if (signal?.aborted === true) return false;
    const left = deadline - performance.now();
    if (left <= 0) return false;
    if (await waitSlice(tx, target, Math.max(1, Math.min(Math.floor(left), WAIT_SLICE_MS)))) return true;
  }
}

function notAcquired(cause: unknown): LockError {
  return new LockError({
    code: 'store',
    message: 'the Postgres advisory lock attempt failed',
    remediation: 'Check the database connection. The lock was not taken.',
    cause,
    outcome: 'not-acquired',
    method: 'acquire',
  });
}

/**
 * Advisory locks inside a transaction you already have. The lock lives until
 * that transaction ends; `release` only forgets the grant. Given a savepoint
 * handle (a nested `tx.transaction`), a ROLLBACK of that savepoint frees the
 * lock at once, while the outer transaction goes on. Postgres advisory
 * locks are re-entrant within one session, so a second acquire of the same key
 * on the same transaction succeeds: exclusion is between transactions. That holds for
 * read/write too: a read followed by a write of the same key in ONE transaction is
 * granted (Postgres lets one session take both), so there is no upgrade check here.
 */
export function pgTransaction(
  tx: PgExecutor,
  options: PgLockOptions = {},
): Store<PgTransactionGuarantees> & { readonly shared: SharedOps } {
  const legacy = options.legacyKeys === true;
  const granted = new Set<string>();
  async function take(target: Target, req: AcquireRequest): Promise<Grant | undefined> {
    let got: boolean;
    try {
      got = await takeLock(tx, target, waitDeadline(req.waitMs), req.signal);
    } catch (error) {
      throw notAcquired(error);
    }
    if (!got) return undefined;
    granted.add(req.token);
    return { key: target.key, token: req.token };
  }
  const release = (grant: Grant): Promise<ReleaseOutcome> =>
    // The transaction owns the lock; there is nothing to give back here.
    Promise.resolve(granted.delete(grant.token) ? 'released' : 'not-owner');
  return {
    name: 'pg-transaction',
    guarantees: heldByTransaction,
    acquire: (key: Key, req: AcquireRequest) => take({ key, legacy, mode: 'exclusive' }, req),
    release,
    // Read/write keys never have a legacy key space, so `legacyKeys` is ignored here.
    shared: {
      acquire: (key: Key, req: SharedRequest) => take({ key, legacy: false, mode: modeOf(req) }, req),
      release,
    },
  };
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};

/** `Promise.withResolvers`, which older lib targets and Hermes lack. */
function deferred<T>(): Deferred<T> {
  const settlers: { resolve?: (value: T) => void; reject?: (reason: unknown) => void } = {};
  const promise = new Promise<T>((resolve, reject) => {
    settlers.resolve = resolve;
    settlers.reject = reject;
  });
  return {
    promise,
    resolve: value => settlers.resolve?.(value),
    reject: reason => settlers.reject?.(reason),
  };
}

/** `lost`: a beat went unanswered; the store stops beating and lets the transaction end if the connection ever answers. */
type Phase = 'acquiring' | 'held' | 'releasing' | 'lost' | 'ended';

/** Server timeouts that would end the pinned transaction, and the lock with it, while the job is healthy. Absent ones (pre-17 has no `transaction_timeout`) are skipped. */
const EXEMPT_TIMEOUTS = sql`select set_config(name, '0', true) from pg_settings where name in ('idle_in_transaction_session_timeout', 'statement_timeout', 'transaction_timeout')`;

/**
 * `true` once `query` has gone `ms` unanswered. A timer that fires late because
 * the thread was busy gets one more turn first, so a reply already waiting on
 * the socket is read before the connection is called silent.
 */
function unanswered(query: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    let timer = setTimeout(() => {
      timer = setTimeout(() => {
        resolve(true);
      }, 0);
    }, ms);
    const answered = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    query.then(answered, answered);
  });
}

/** One macrotask turn. A driver that answers synchronously (PGlite) would otherwise make the hold loop starve every timer and I/O callback, the job's included. */
const nextTurn = (): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, 0);
  });

/**
 * Advisory locks that own their connection: each acquire opens a transaction
 * on `db`, takes the lock, and keeps the transaction open until release. One
 * pool slot is used per held lock, so the pool needs a second connection for
 * the job itself.
 */
export function pgSession(
  db: LockableDb,
  options: PgSessionOptions = {},
): Store<PgSessionGuarantees> & { readonly shared: SharedOps } {
  const legacy = options.legacyKeys === true;
  const keepAlive = options.keepAlive !== false;
  const ends = new Map<string, () => Promise<ReleaseOutcome>>();
  const release = (grant: Grant): Promise<ReleaseOutcome> => {
    const end = ends.get(grant.token);
    return end === undefined ? Promise.resolve('not-owner') : end();
  };
  // Postgres grants shared and exclusive advisory locks with no writer preference, so a stream
  // of readers can starve a writer. `SharedOps.waiter` is therefore left out on purpose: the
  // manager's wait loop retries, and the contract's writer-preference case skips.
  const shared: SharedOps = {
    async acquire(key: Key, req: SharedRequest): Promise<Grant | undefined> {
      // `legacyKeys` is for mutexes only: read/write keys never had a legacy key.
      return (await open({ key, legacy: false, mode: modeOf(req) }, req)) ?? undefined;
    },
    release,
  };

  return {
    name: 'pg-session',
    guarantees: hold,
    async acquire(key: Key, req: AcquireRequest): Promise<Grant | undefined> {
      return (await open({ key, legacy, mode: 'exclusive' }, req)) ?? undefined;
    },
    release,
    shared,
    async dispose(): Promise<void> {
      await Promise.all([...ends.values()].map(end => end()));
    },
  };

  /** One attempt on a fresh pinned transaction; `null` = not granted. */
  function open(target: Target, req: AcquireRequest): Promise<Grant | null> {
    const { key } = target;
    if (req.signal?.aborted === true) return Promise.resolve(null);
    // Taken now, so time spent queueing for a pool connection counts against the wait.
    const deadline = waitDeadline(req.waitMs);
    const answer = deferred<Grant | null>();
    const lost = deferred<LockError>();
    const released = deferred<ReleaseOutcome>();
    const releaseAsked = deferred<void>();
    let phase: Phase = 'acquiring';

    // A function, so the loop below re-reads `phase`, which `end` changes from another call.
    const isHeld = (): boolean => phase === 'held';

    const end = (): Promise<ReleaseOutcome> => {
      if (phase === 'held') {
        phase = 'releasing';
        releaseAsked.resolve();
      }
      return phase === 'releasing' ? released.promise : Promise.resolve('not-owner');
    };

    const loseSilently = (): void => {
      phase = 'lost';
      ends.delete(req.token);
      log.error('pg session lock lost: the pinned connection stopped answering');
      lost.resolve(
        new LockError({
          code: 'lost',
          message: 'the pinned Postgres connection stopped answering while the lock was held',
          remediation: 'Stop the work. The callback may have had side effects; nothing retries it.',
          detectedBy: 'connection',
        }),
      );
    };

    const run = db.transaction(async tx => {
      // The pinned transaction only runs this store's bounded statements, so no server timeout may end it while held.
      await tx.execute(EXEMPT_TIMEOUTS);
      const got = await takeLock(tx, target, deadline, req.signal);
      if (!got) return;
      phase = 'held';
      ends.set(req.token, end);
      log.debug('pg session lock acquired');
      if (!keepAlive) {
        answer.resolve({ key, token: req.token });
        await releaseAsked.promise;
        return;
      }
      answer.resolve({ key, token: req.token, lost: lost.promise });
      while (isHeld()) {
        // Promise.resolve: Drizzle's query is a thenable that runs again on every `then`.
        const beat = Promise.resolve(tx.execute(sql`select pg_sleep(${HOLD_BEAT_SECONDS})`));
        if ((await unanswered(beat, HOLD_BEAT_TIMEOUT_MS)) && isHeld()) loseSilently();
        await beat;
        await nextTurn();
      }
    });

    run.then(
      () => {
        const was: Phase = phase;
        phase = 'ended';
        ends.delete(req.token);
        if (was === 'acquiring') answer.resolve(null);
        else released.resolve('released');
        log.debug('pg session transaction ended');
      },
      (error: unknown) => {
        const was: Phase = phase;
        phase = 'ended';
        ends.delete(req.token);
        if (was === 'acquiring') {
          answer.reject(notAcquired(error));
        } else if (was === 'releasing') {
          // The commit did not confirm. The lock goes with the connection, but we cannot say so.
          log.error(error instanceof Error ? error : new Error(String(error)), {
            note: 'pg session release not confirmed',
          });
          released.resolve('unknown');
        } else {
          const lostError = new LockError({
            code: 'lost',
            message: 'the pinned Postgres connection ended while the lock was held',
            remediation: 'Stop the work. The callback may have had side effects; nothing retries it.',
            cause: error,
            detectedBy: 'connection',
          });
          log.error('pg session lock lost: the pinned connection ended');
          lost.resolve(lostError);
        }
      },
    );

    return answer.promise;
  }
}
