import { orThrow } from '@arki/failure';
import { lockTokenSchema } from './../identity-schemas.js';
/**
 * `sqliteLease` on real libSQL files.
 *
 * Why: SQLite has one writer per file and no server, so the lease must hold across every
 * client of one file. A second client on the same file stands in for a second process: it has
 * its own connection, and its write lock reaches the store as SQLITE_BUSY. Tests build the
 * Drizzle handle straight from `drizzle-orm/libsql` (the type `createLibsqlDb` returns):
 * `@arki/lock` is a kernel package and may not depend on `@arki/db`, even in tests.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@libsql/client';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { afterAll, describe, expect, it } from 'vitest';

import type { CaseStore } from '../testing/index.js';
import type { ManualScheduler } from '../testing/manual-scheduler.js';
import { LockError, LockHeld } from '../errors.js';
import { createKey } from '../key.js';
import { createLocks } from '../locks.js';
import { describeStoreContract } from '../testing/index.js';
import { manualScheduler } from '../testing/manual-scheduler.js';
import { parseDuration } from '../wait.js';
import { ensureLockTable, LEASE_TABLE_SQL, leaseTableSql, sqliteLease, sqliteLeaseGuarantees } from './index.js';

const TTL = '2s';
const dir = mkdtempSync(path.join(tmpdir(), 'arki-lock-sqlite-'));
const clients: Client[] = [];

afterAll(() => {
  for (const client of clients) client.close();
  rmSync(dir, { recursive: true, force: true });
});

let fileCounter = 0;
/** A fresh database file. */
function newFile(): string {
  fileCounter += 1;
  return `file:${path.join(dir, `case-${fileCounter}.db`)}`;
}

/** One client on `url`: its own connection, as a separate process would have. */
function open(url: string): LibSQLDatabase {
  const client = createClient({ url });
  clients.push(client);
  return drizzle({ client });
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Make every lease in `db` `ms` older, as if SQLite's clock had moved forward. */
async function shift(db: LibSQLDatabase, ms: number): Promise<void> {
  await db.run(sql`
    UPDATE arki_lock SET
      expires_at = expires_at - ${ms},
      holders = (SELECT json_group_array(json_set(h.value, '$.e', (h.value ->> 'e') - ${ms})) FROM json_each(holders) AS h)
  `);
}

/** One manual clock for the manager's timers; each advance also ages the leases in the database. */
function dbBackedScheduler(db: LibSQLDatabase): ManualScheduler {
  const inner = manualScheduler();
  return {
    now: () => inner.now(),
    setTimeout: (cb, ms, opts) => inner.setTimeout(cb, ms, opts),
    clearTimeout: handle => {
      inner.clearTimeout(handle);
    },
    get pendingTimers() {
      return inner.pendingTimers;
    },
    async advance(duration) {
      // Small steps: each ages the leases, then lets the manager's renewals (which reset them) run.
      let left = parseDuration(duration);
      while (left > 0) {
        const step = Math.min(left, 300);
        await shift(db, step);
        await inner.advance(step);
        left -= step;
      }
    },
  };
}

// --- contract: the same cases every store passes ---------------------------

/** A fresh database file and a manual clock per case, so no case can age another's leases. */
async function freshCase(): Promise<CaseStore> {
  const db = open(newFile());
  orThrow(await ensureLockTable(db));
  const clock = dbBackedScheduler(db);
  return { store: sqliteLease(db, { ttl: TTL }), advanceTime: ms => clock.advance(ms), scheduler: clock };
}

describeStoreContract('sqliteLease', freshCase);

// --- what only this store does ---------------------------------------------

describe('sqliteLease', () => {
  it('hands out fences that grow across holders and survive release: the row is never deleted', async () => {
    const db = open(newFile());
    orThrow(await ensureLockTable(db));
    const store = sqliteLease(db, { ttl: TTL });
    const key = createKey('fences', 'job');
    const fences: bigint[] = [];
    for (const token of ['a', 'b', 'c']) {
      const grant = orThrow(await store.acquire(key, { token: lockTokenSchema.parse(token) }));
      if (grant === undefined) throw new Error(`holder ${token} should get the free key`);
      fences.push(grant.fence ?? 0n);
      expect(await store.release(grant)).toBe('released');
    }
    expect(fences).toEqual([1n, 2n, 3n]);
    const rows = await db.all(sql`SELECT key, token FROM arki_lock`);
    expect(rows).toEqual([{ key: key.full, token: null }]);
  });

  it('keeps two clients on one file apart: one holds, the other acquires only after release', async () => {
    const url = newFile();
    const first = open(url);
    const second = open(url);
    orThrow(await ensureLockTable(first));
    const a = createLocks({ store: sqliteLease(first, { ttl: TTL }), namespace: 'shared' });
    const b = createLocks({ store: sqliteLease(second, { ttl: TTL }), namespace: 'shared' });

    let inside = 0;
    let most = 0;
    const order: string[] = [];
    const work = (name: string) => async () => {
      inside += 1;
      most = Math.max(most, inside);
      order.push(name);
      await sleep(50);
      inside -= 1;
    };
    const held = orThrow(await a.mutex('job').tryAcquire());
    if (LockHeld.is(held)) throw new Error('the first client should get the free key');
    expect(LockHeld.is(await b.mutex('job').tryAcquire())).toBe(true);
    const waiting = b.mutex('job').run(work('b'), { wait: '5s' });
    await sleep(100);
    expect(order).toEqual([]);
    orThrow(await held.release());
    expect(LockHeld.is(await waiting)).toBe(false);
    expect(order).toEqual(['b']);

    const results = await Promise.all([
      a.mutex('race').run(work('a'), { wait: '5s' }),
      b.mutex('race').run(work('b'), { wait: '5s' }),
      a.mutex('race').run(work('a'), { wait: '5s' }),
      b.mutex('race').run(work('b'), { wait: '5s' }),
    ]);
    expect(results.filter(result => LockHeld.is(result))).toEqual([]);
    expect(most).toBe(1);
  });

  it('frees a key after its ttl when the holder never renews (a crashed process)', async () => {
    const url = newFile();
    const first = open(url);
    const second = open(url);
    orThrow(await ensureLockTable(first));
    const key = createKey('crash', 'job');
    const crashed = orThrow(await sqliteLease(first, { ttl: '1s' }).acquire(key, { token: lockTokenSchema.parse('gone') }));
    const survivor = sqliteLease(second, { ttl: '1s' });
    expect(crashed).toBeDefined();
    expect(await survivor.acquire(key, { token: lockTokenSchema.parse('next') })).toBeUndefined();
    await sleep(1100);
    const taken = orThrow(await survivor.acquire(key, { token: lockTokenSchema.parse('next') }));
    expect(taken?.fence).toBe(2n);
  });

  it('reads SQLITE_BUSY from another process as "not acquired now", not as an error', async () => {
    const url = newFile();
    const db = open(url);
    orThrow(await ensureLockTable(db));
    const store = sqliteLease(db, { ttl: TTL });
    const key = createKey('busy', 'job');
    const other = createClient({ url });
    clients.push(other);
    const writing = await other.transaction('write');
    try {
      expect(await store.acquire(key, { token: lockTokenSchema.parse('t') })).toBeUndefined();
      expect(await store.permits.acquire(key, { token: lockTokenSchema.parse('t'), limit: 2, weight: 1 })).toBeUndefined();
    } finally {
      await writing.commit();
    }
    const after = orThrow(await store.acquire(key, { token: lockTokenSchema.parse('t') }));
    expect(after?.fence).toBe(1n);
  });

  it('returns a store failure that is not SQLITE_BUSY: a missing table is a real fault', async () => {
    const store = sqliteLease(open(newFile()), { ttl: TTL });
    await expect(store.acquire(createKey('x', 'y'), { token: lockTokenSchema.parse('t') })).resolves.toMatchObject({
      code: 'lock.store',
      cause: { cause: { code: 'SQLITE_ERROR', message: expect.stringContaining('no such table') } },
    });
  });

  it('refuses a semaphore acquire under a different limit while the key is held', async () => {
    const db = open(newFile());
    orThrow(await ensureLockTable(db));
    const store = sqliteLease(db, { ttl: TTL });
    const key = createKey('sem', 'job');
    expect(await store.permits.acquire(key, { token: lockTokenSchema.parse('a'), limit: 2, weight: 1 })).toBeDefined();
    await expect(store.permits.acquire(key, { token: lockTokenSchema.parse('b'), limit: 3, weight: 1 })).rejects.toThrow(LockError);
  });

  it('uses a named table, and refuses a name that is not a plain identifier', async () => {
    const db = open(newFile());
    orThrow(await ensureLockTable(db, 'app_locks'));
    orThrow(await sqliteLease(db, { ttl: TTL, table: 'app_locks' }).acquire(createKey('t', 'k'), { token: lockTokenSchema.parse('t') }));
    expect(await db.all(sql`SELECT token FROM app_locks`)).toEqual([{ token: lockTokenSchema.parse('t') }]);
    expect(() => sqliteLease(db, { ttl: TTL, table: 'locks; DROP TABLE users' })).toThrow(LockError);
  });

  it('refuses a ttl under the renewal floor', () => {
    expect(() => sqliteLease(open(newFile()), { ttl: '500ms' })).toThrow(LockError);
  });

  it('declares a fenced, polling lease with the ttl it was given', () => {
    const store = sqliteLease(open(newFile()), { ttl: '90s' });
    expect(store.ttlMs).toBe(90_000);
    expect(store.guarantees).toBe(sqliteLeaseGuarantees);
    expect(store.guarantees).toMatchObject({ kind: 'lease', fence: 'durable', wait: 'poll', permits: true });
  });

  it('ships its DDL as text for migrations', () => {
    expect(LEASE_TABLE_SQL).toContain('CREATE TABLE IF NOT EXISTS "arki_lock"');
    expect(leaseTableSql('main.locks')).toContain('"main"."locks"');
  });
});
