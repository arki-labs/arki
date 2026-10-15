/**
 * SQL shape and state machine of the Postgres stores, without Docker.
 *
 * A scripted fake database records every statement and answers as we tell it
 * to. The PGlite leg at the end runs the same SQL on a real (embedded) engine.
 * PGlite has ONE connection and its advisory locks are process-local, so it
 * proves the SQL is valid and the transaction life cycle works, never that two
 * replicas exclude each other. Cross-connection behaviour is tested against a
 * real Postgres in `index.pg.test.ts`.
 */
import type { SQL } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { LockableDb, PgExecutor } from './index.js';
import { LockError } from '../errors.js';
import { createKey, toPgPair } from '../key.js';
import { createLocks } from '../locks.js';
import { HOLD_BEAT_SECONDS, HOLD_BEAT_TIMEOUT_MS, HOLD_FIRST_BEAT_SECONDS, pgSession, pgTransaction } from './index.js';

type Statement = { readonly sql: string; readonly params: readonly unknown[] };

const dialect = new PgDialect();
const key = createKey('app', 'digest');

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/** A database that records statements and answers through `respond`. `commitFails` simulates a dead connection at COMMIT. */
function fakeDb(respond: (statement: Statement) => unknown, options: { commitFails?: boolean } = {}) {
  const statements: Statement[] = [];
  const marks: string[] = [];
  const tx: PgExecutor = {
    async execute(query: SQL): Promise<unknown> {
      const { sql: text, params } = dialect.sqlToQuery(query);
      const statement = { sql: text, params };
      statements.push(statement);
      return respond(statement);
    },
  };
  const db: LockableDb = {
    async transaction<T>(run: (handle: PgExecutor) => Promise<T>): Promise<T> {
      marks.push('begin');
      try {
        const result = await run(tx);
        if (options.commitFails === true) throw new Error('connection terminated at commit');
        marks.push('commit');
        return result;
      } catch (error) {
        marks.push('rollback');
        throw error;
      }
    },
  };
  return { db, tx, statements, marks };
}

const acquired = (value: boolean) => ({ rows: [{ acquired: value }] });
const timeoutError = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
const texts = (statements: readonly Statement[]): string[] => statements.map(statement => statement.sql);

/** Beats take a few ms so the hold loop does not spin. */
async function answerHolding(statement: Statement): Promise<unknown> {
  if (statement.sql.includes('pg_sleep')) {
    await delay(5);
    return { rows: [] };
  }
  return acquired(true);
}

describe('key spaces', () => {
  it('locks the two-int4 pair of the canonical key, so a rename of the format cannot go unnoticed', async () => {
    const { db, statements } = fakeDb(() => acquired(true));
    const store = pgSession(db);
    const grant = await store.acquire(key, { token: 't1' });
    const attempt = statements.find(statement => statement.sql.includes('pg_try_advisory_xact_lock'));
    const { hi, lo } = toPgPair(key);
    expect(attempt?.sql).toContain('pg_try_advisory_xact_lock($1::int4, $2::int4)');
    expect(attempt?.params).toEqual([hi, lo]);
    expect(await store.release(grant ?? { key, token: 't1' })).toBe('released');
  });

  it('legacyKeys locks hashtext of "<namespace>:<name>", the key @arki/db locks today, so old and new replicas still exclude', async () => {
    const { db, statements } = fakeDb(() => acquired(true));
    const store = pgSession(db, { legacyKeys: true });
    const grant = await store.acquire(key, { token: 't1' });
    const attempt = statements.find(statement => statement.sql.includes('pg_try_advisory_xact_lock'));
    expect(attempt?.sql).toContain('pg_try_advisory_xact_lock(hashtext($1))');
    expect(attempt?.params).toEqual(['app:digest']);
    await store.release(grant ?? { key, token: 't1' });
  });

  it('pgTransaction honours legacyKeys the same way', async () => {
    const { tx, statements } = fakeDb(() => acquired(true));
    await pgTransaction(tx, { legacyKeys: true }).acquire(key, { token: 't1' });
    expect(statements[0]?.sql).toContain('hashtext($1)');
    expect(statements[0]?.params).toEqual(['app:digest']);
  });

  it('reads the answer from a { rows } result and from a bare array (node-postgres, PGlite, postgres.js)', async () => {
    for (const shape of [acquired(true), [{ acquired: true }]]) {
      const { tx } = fakeDb(() => shape);
      expect(await pgTransaction(tx).acquire(key, { token: 't' })).toBeDefined();
    }
    for (const shape of [acquired(false), [{ acquired: false }], [], undefined]) {
      const { tx } = fakeDb(() => shape);
      expect(await pgTransaction(tx).acquire(key, { token: 't' })).toBeUndefined();
    }
  });
});

describe('pgSession life cycle', () => {
  it('turns off the idle, statement and transaction timeouts first, or the server would end the pinned transaction and drop the lock', async () => {
    const { db, statements } = fakeDb(answerHolding);
    const store = pgSession(db);
    const grant = await store.acquire(key, { token: 't1' });
    const first = statements[0]?.sql ?? '';
    expect(first).toContain("set_config(name, '0', true)");
    for (const timeout of ['idle_in_transaction_session_timeout', 'statement_timeout', 'transaction_timeout']) {
      expect(first).toContain(`'${timeout}'`);
    }
    await store.release(grant ?? { key, token: 't1' });
  });

  it('a held key gives undefined and ends the empty transaction, so no pool slot stays pinned', async () => {
    const { db, marks } = fakeDb(() => acquired(false));
    expect(await pgSession(db).acquire(key, { token: 't1' })).toBeUndefined();
    expect(marks).toEqual(['begin', 'commit']);
  });

  it('keeps the transaction open while held, and release commits it exactly once', async () => {
    const { db, marks } = fakeDb(answerHolding);
    const store = pgSession(db);
    const grant = await store.acquire(key, { token: 't1' });
    expect(marks).toEqual(['begin']);
    expect(await store.release(grant ?? { key, token: 't1' })).toBe('released');
    expect(marks).toEqual(['begin', 'commit']);
    expect(await store.release({ key, token: 't1' })).toBe('not-owner');
  });

  it('another owner token cannot release the lock; it stays held', async () => {
    const { db, marks } = fakeDb(answerHolding);
    const store = pgSession(db);
    const grant = await store.acquire(key, { token: 't1' });
    expect(await store.release({ key, token: 'someone-else' })).toBe('not-owner');
    expect(marks).toEqual(['begin']);
    await store.release(grant ?? { key, token: 't1' });
  });

  it('keeps a query running on the pinned connection while held, so a dead connection fails a query instead of an idle client', async () => {
    const { db, statements } = fakeDb(answerHolding);
    const store = pgSession(db);
    const grant = await store.acquire(key, { token: 't1' });
    const countBeats = (): number => statements.filter(statement => statement.sql.includes('pg_sleep')).length;
    // Polled, not a fixed sleep: a busy machine (a container booting next door) slows the beats down.
    for (let tries = 0; tries < 200 && countBeats() <= 2; tries++) await delay(10);
    await store.release(grant ?? { key, token: 't1' });
    const beats = statements.filter(statement => statement.sql.includes('pg_sleep'));
    expect(beats.length).toBeGreaterThan(2);
    // Release waits out the beat in flight, so a young hold beats short and long holds settle at the cap.
    expect(beats[0]?.params).toEqual([HOLD_FIRST_BEAT_SECONDS]);
    const lengths = beats.map(beat => Number(beat.params[0]));
    expect(Math.max(...lengths)).toBeLessThanOrEqual(HOLD_BEAT_SECONDS);
    expect(lengths[2]).toBeGreaterThan(lengths[0] ?? 0);
  });

  it('a dropped connection resolves grant.lost with detectedBy "connection" and later release says not-owner', async () => {
    let dead = false;
    const { db } = fakeDb(async statement => {
      if (statement.sql.includes('pg_sleep')) {
        await delay(5);
        if (dead) throw new Error('terminating connection due to administrator command');
        return { rows: [] };
      }
      return acquired(true);
    });
    const store = pgSession(db);
    const grant = await store.acquire(key, { token: 't1' });
    if (grant?.lost === undefined) throw new Error('the grant carries no lost promise');
    dead = true;
    const lost = await grant.lost;
    expect(lost).toBeInstanceOf(LockError);
    expect(lost).toMatchObject({ code: 'lost', detectedBy: 'connection' });
    expect(await store.release(grant ?? { key, token: 't1' })).toBe('not-owner');
  });

  it('a release whose COMMIT fails reports "unknown" instead of throwing, so it can never mask the callback\'s own error', async () => {
    const { db } = fakeDb(answerHolding, { commitFails: true });
    const store = pgSession(db);
    const grant = await store.acquire(key, { token: 't1' });
    await expect(store.release(grant ?? { key, token: 't1' })).resolves.toBe('unknown');
  });

  it('an error while taking the lock is a "store" error that says the lock was not taken', async () => {
    const { db } = fakeDb(statement => {
      if (statement.sql.includes('pg_try_advisory')) throw new Error('connection refused');
      return { rows: [] };
    });
    const error = await pgSession(db)
      .acquire(key, { token: 't1' })
      .catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(LockError);
    expect(error).toMatchObject({ code: 'store', outcome: 'not-acquired', method: 'acquire' });
  });

  it('a beat that goes unanswered (silent network) is reported lost, and if the connection answers later the transaction still ends, so no lock is left behind', async () => {
    vi.useFakeTimers();
    try {
      let answerBeat: (() => void) | undefined;
      const { db, marks } = fakeDb(statement =>
        statement.sql.includes('pg_sleep')
          ? new Promise(resolve => {
              answerBeat = () => {
                resolve({ rows: [] });
              };
            })
          : acquired(true),
      );
      const store = pgSession(db);
      const grant = await store.acquire(key, { token: 't1' });
      await vi.advanceTimersByTimeAsync(HOLD_BEAT_TIMEOUT_MS + 10);
      expect(await grant?.lost).toMatchObject({ code: 'lost', detectedBy: 'connection' });
      expect(marks).toEqual(['begin']);
      expect(await store.release(grant ?? { key, token: 't1' })).toBe('not-owner');
      answerBeat?.();
      await vi.advanceTimersByTimeAsync(10);
      expect(marks).toEqual(['begin', 'commit']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keepAlive: false sends no beats and gives no grant.lost, and release still commits the pinned transaction', async () => {
    const { db, statements, marks } = fakeDb(answerHolding);
    const store = pgSession(db, { keepAlive: false });
    const grant = await store.acquire(key, { token: 't1' });
    expect(grant).toBeDefined();
    expect(grant?.lost).toBeUndefined();
    await delay(30);
    expect(statements.some(statement => statement.sql.includes('pg_sleep'))).toBe(false);
    expect(await store.release(grant ?? { key, token: 't1' })).toBe('released');
    expect(marks).toEqual(['begin', 'commit']);
  });

  it('dispose releases every held lock', async () => {
    const { db, marks } = fakeDb(answerHolding);
    const store = pgSession(db);
    await store.acquire(key, { token: 't1' });
    await store.acquire(createKey('app', 'other'), { token: 't2' });
    await store.dispose?.();
    expect(marks.filter(mark => mark === 'commit')).toHaveLength(2);
  });

  it('an already aborted signal never opens a transaction', async () => {
    const { db, marks } = fakeDb(() => acquired(true));
    expect(await pgSession(db).acquire(key, { token: 't1', signal: AbortSignal.abort() })).toBeUndefined();
    expect(marks).toEqual([]);
  });
});

describe('bounded waits', () => {
  it('waits in slices inside a savepoint: a timed-out slice is rolled back and retried, never poisoning the transaction', async () => {
    let blocking = 0;
    const { tx, statements } = fakeDb(statement => {
      if (statement.sql.includes('pg_advisory_xact_lock(')) {
        blocking += 1;
        if (blocking <= 2) throw timeoutError();
      }
      if (statement.sql.includes('current_setting'))
        return { rows: [{ lock_timeout: '5s', statement_timeout: '300ms' }] };
      return { rows: [] };
    });
    const grant = await pgTransaction(tx).acquire(key, { token: 't1', waitMs: 5000 });
    expect(grant).toBeDefined();
    const text = texts(statements);
    expect(text.filter(line => line === 'savepoint arki_lock_wait')).toHaveLength(3);
    expect(text.filter(line => line === 'rollback to savepoint arki_lock_wait')).toHaveLength(2);
    expect(text.at(-1)).toBe('release savepoint arki_lock_wait');
    const sliceSettings = statements.filter(statement => statement.sql.includes("set_config('lock_timeout'"));
    expect(sliceSettings[0]?.params).toEqual(['1000ms']);
    // lock_timeout bounds the slice; a shorter statement_timeout would cancel it, so it is lifted for the slice.
    expect(sliceSettings[0]?.sql).toContain("set_config('statement_timeout', '0', true)");
    // After success the caller's own timeouts are put back.
    expect(sliceSettings.at(-1)?.params).toEqual(['5s', '300ms']);
  });

  it('a slice is never longer than the time left', async () => {
    const { tx, statements } = fakeDb(statement => {
      if (statement.sql.includes('pg_advisory_xact_lock(')) throw timeoutError();
      return { rows: [] };
    });
    expect(await pgTransaction(tx).acquire(key, { token: 't1', waitMs: 30 })).toBeUndefined();
    const slices = statements
      .filter(statement => statement.sql.includes("set_config('lock_timeout'"))
      .map(statement => Number.parseInt(String(statement.params[0]), 10));
    expect(slices.length).toBeGreaterThan(0);
    expect(Math.max(...slices)).toBeLessThanOrEqual(30);
  });

  it('a caller signal is honoured between slices', async () => {
    const controller = new AbortController();
    const { tx, statements } = fakeDb(statement => {
      if (statement.sql.includes('pg_advisory_xact_lock(')) {
        controller.abort();
        throw timeoutError();
      }
      return { rows: [] };
    });
    expect(
      await pgTransaction(tx).acquire(key, { token: 't1', waitMs: 60_000, signal: controller.signal }),
    ).toBeUndefined();
    expect(statements.filter(statement => statement.sql.includes('pg_advisory_xact_lock('))).toHaveLength(1);
  });

  it('an error that is not a lock timeout is not retried', async () => {
    const { tx } = fakeDb(statement => {
      if (statement.sql.includes('pg_advisory_xact_lock(')) throw new Error('connection reset');
      return { rows: [] };
    });
    await expect(pgTransaction(tx).acquire(key, { token: 't1', waitMs: 5000 })).rejects.toMatchObject({
      code: 'store',
      outcome: 'not-acquired',
    });
  });

  it('finds the lock-timeout code on a wrapped cause, as Drizzle wraps driver errors', async () => {
    let blocking = 0;
    const { tx } = fakeDb(statement => {
      if (statement.sql.includes('pg_advisory_xact_lock(')) {
        blocking += 1;
        if (blocking === 1) throw new Error('Failed query', { cause: timeoutError() });
      }
      return { rows: [] };
    });
    expect(await pgTransaction(tx).acquire(key, { token: 't1', waitMs: 5000 })).toBeDefined();
  });
});

describe('pgTransaction', () => {
  it('opens no transaction and sets no timeouts: the caller owns the transaction', async () => {
    const { tx, statements } = fakeDb(() => acquired(true));
    await pgTransaction(tx).acquire(key, { token: 't1' });
    expect(texts(statements)).toHaveLength(1);
    expect(statements[0]?.sql).toContain('pg_try_advisory_xact_lock');
  });

  it('release only forgets the grant: it reports released once and issues no SQL, because the transaction ends the lock', async () => {
    const { tx, statements } = fakeDb(() => acquired(true));
    const store = pgTransaction(tx);
    const grant = await store.acquire(key, { token: 't1' });
    const before = statements.length;
    expect(await store.release({ key, token: 'other' })).toBe('not-owner');
    expect(await store.release(grant ?? { key, token: 't1' })).toBe('released');
    expect(await store.release(grant ?? { key, token: 't1' })).toBe('not-owner');
    expect(statements).toHaveLength(before);
  });
});

describe('guarantees', () => {
  it('claim what Postgres advisory locks give: cluster scope, native wait, crash-safe, no fence, no clock', () => {
    const { db, tx } = fakeDb(() => acquired(true));
    for (const store of [pgSession(db), pgTransaction(tx)]) {
      expect(store.guarantees).toMatchObject({
        kind: 'hold',
        scope: 'cluster',
        wait: 'native',
        shared: true,
        permits: false,
        fence: false,
        releasedOnCrash: 'immediate',
        clock: 'none',
        runtimes: ['node', 'bun', 'deno'],
      });
    }
  });
});

// ---------------------------------------------------------------------------
// PGlite leg: SQL shape only. PGlite advisory locks are process-local (one
// connection), so nothing here shows exclusion between replicas.
// ---------------------------------------------------------------------------

describe('PGlite: the SQL is valid on a real engine', () => {
  const pglite = new PGlite();
  const db = drizzle({ client: pglite });
  afterAll(async () => {
    await pglite.close();
  });

  it('pgSession runs a callback under the lock, with both key spaces', async () => {
    for (const legacyKeys of [false, true]) {
      const locks = createLocks({ store: pgSession(db, { legacyKeys }), namespace: 'pglite' });
      const result = await locks.mutex(`job-${legacyKeys}`).tryRun(() => 'ran');
      expect(result).toEqual({ ran: true, value: 'ran' });
    }
  });

  it('a bounded wait with slices and savepoints is valid SQL', async () => {
    const locks = createLocks({ store: pgSession(db), namespace: 'pglite' });
    expect(await locks.mutex('waiting').run(() => 'ran', { wait: '2s' })).toBe('ran');
  });

  it("a job that awaits timers finishes: the hold loop yields a turn, or PGlite's synchronous answers would starve the event loop forever", async () => {
    const locks = createLocks({ store: pgSession(db), namespace: 'pglite' });
    const result = await locks.mutex('timers').tryRun(async () => {
      await delay(10);
      await delay(10);
      return 'ran';
    });
    expect(result).toEqual({ ran: true, value: 'ran' });
  });

  it('keepAlive: false keeps a PGlite job fast: no beat blocks the thread for 200 ms between its awaits', async () => {
    const locks = createLocks({ store: pgSession(db, { keepAlive: false }), namespace: 'pglite' });
    const startedAt = performance.now();
    const result = await locks.mutex('no-beats').tryRun(async () => {
      for (let step = 0; step < 5; step++) await delay(5);
      return 'ran';
    });
    expect(result).toEqual({ ran: true, value: 'ran' });
    // With beats, each await can wait out a 200 ms synchronous pg_sleep.
    expect(performance.now() - startedAt).toBeLessThan(150);
  });

  it('keepAlive: false grants carry no lost promise on PGlite: there is no connection to lose', async () => {
    const store = pgSession(db, { keepAlive: false });
    const grant = await store.acquire(createKey('pglite', 'no-lost'), { token: 'p1' });
    expect(grant).toBeDefined();
    expect(grant?.lost).toBeUndefined();
    expect(await store.release(grant ?? { key, token: 'p1' })).toBe('released');
  });

  it('read and write holds use the shared and the exclusive advisory call, and read/write keys differ from mutex keys of the same name', async () => {
    const seen: string[] = [];
    const { db } = fakeDb(statement => {
      seen.push(statement.sql);
      return acquired(true);
    });
    const store = pgSession(db, { keepAlive: false, legacyKeys: true });
    const readKey = createKey('app', 'same', 'readWrite');
    const mutexKey = createKey('app', 'same');
    const read = await store.shared.acquire(readKey, { token: 'r', mode: 'read' });
    const write = await store.shared.acquire(readKey, { token: 'w', mode: 'write' });
    await store.acquire(mutexKey, { token: 'm' });
    for (const grant of [read, write]) if (grant !== undefined) await store.release(grant);
    expect(seen.some(text => text.includes('pg_try_advisory_xact_lock_shared'))).toBe(true);
    // legacyKeys applies to the mutex only: exactly one hashtext call (the mutex), none for read/write.
    expect(seen.filter(text => text.includes('hashtext'))).toHaveLength(1);
    expect(toPgPair(readKey)).not.toEqual(toPgPair(mutexKey));
    await store.dispose?.();
  });

  it('pgTransaction takes read then write of one key in one transaction: Postgres lets one session hold both, so there is no upgrade check', async () => {
    const result = await db.transaction(async tx => {
      const store = pgTransaction(tx);
      const k = createKey('pglite', 'upgrade', 'readWrite');
      const read = await store.shared.acquire(k, { token: 'r', mode: 'read' });
      const write = await store.shared.acquire(k, { token: 'w', mode: 'write' });
      return [read !== undefined, write !== undefined];
    });
    expect(result).toEqual([true, true]);
  });

  it('pgTransaction takes an advisory lock that exists in pg_locks until the transaction ends', async () => {
    const seen = await db.transaction(async tx => {
      const locks = createLocks({ store: pgTransaction(tx), namespace: 'pglite' });
      await locks.mutex('in-tx').tryRun(() => 0);
      const result = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_locks where locktype = 'advisory'`,
      );
      return result.rows[0]?.n;
    });
    expect(seen).toBe(1);
    const after = await pglite.query<{ n: number }>(
      `select count(*)::int as n from pg_locks where locktype = 'advisory'`,
    );
    expect(after.rows[0]?.n).toBe(0);
  });
});
