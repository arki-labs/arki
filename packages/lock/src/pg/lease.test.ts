import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import type { ListenClient } from './lease.js';
import { LockError } from '../errors.js';
import { createKey } from '../key.js';
import { createLocks } from '../locks.js';
import { ensureLockTable, LEASE_TABLE_SQL, leaseTableSql, pgLease } from './lease.js';

const dialect = new PgDialect();
const key = createKey('app', 'job');

/**
 * A db that records the SQL it is given and answers with canned rows. The
 * autocommit probe is counted apart and answered like autocommit does: each
 * statement is its own transaction, so each gets a new `transaction_timestamp()`.
 * `probe` overrides that answer.
 */
function recordingDb(rows: readonly unknown[] = [], probe?: () => Promise<unknown>) {
  const statements: { text: string; params: unknown[] }[] = [];
  const counts = { probes: 0 };
  return {
    statements,
    counts,
    db: {
      execute(query: SQL): PromiseLike<unknown> {
        const { sql: text, params } = dialect.sqlToQuery(query);
        if (text.includes('transaction_timestamp()')) {
          counts.probes += 1;
          return probe === undefined ? Promise.resolve({ rows: [{ ts: `t${counts.probes}` }] }) : probe();
        }
        statements.push({ text, params });
        return Promise.resolve({ rows });
      },
    },
  };
}

const noListen = (): Promise<ListenClient> => Promise.reject(new Error('not used'));

/** A LISTEN connection factory that counts what it opens and what gets released. */
function countingListen(open: () => Promise<void> = () => Promise.resolve()) {
  const state = { connects: 0, released: 0 };
  const connect = async (): Promise<ListenClient> => {
    state.connects += 1;
    await open();
    return {
      query: () => Promise.resolve(),
      on: () => {
        // Events are not simulated here.
      },
      release: () => {
        state.released += 1;
      },
    };
  };
  return { state, connect };
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('pgLease SQL shape', () => {
  it('acquire is one INSERT ... ON CONFLICT ... RETURNING on the database clock, so two replicas cannot both win', async () => {
    const { db, statements } = recordingDb([{ generation: '3', expires_ms: '1000' }]);
    const grant = await pgLease(db, { ttl: '5s' }).acquire(key, { token: 't1' });
    expect(statements).toHaveLength(1);
    const text = statements[0]?.text ?? '';
    expect(text).toMatch(/INSERT INTO "arki_lock" AS lease/);
    expect(text).toMatch(/ON CONFLICT \(key\) DO UPDATE/);
    expect(text).toMatch(/generation = lease\.generation \+ 1/);
    expect(text).toMatch(/WHERE lease\.token IS NULL OR lease\.expires_at <= clock_timestamp\(\)/);
    expect(text).toMatch(/RETURNING/);
    expect(grant).toMatchObject({ token: 't1', fence: 3n, expiresAt: 1000 });
  });

  it('never uses now() and never DELETE: now() is the caller transaction start, DELETE would restart the fence', async () => {
    const { db, statements } = recordingDb([{ generation: '1', expires_ms: '1' }]);
    const store = pgLease(db, { ttl: '5s' });
    const grant = await store.acquire(key, { token: 't1' });
    if (grant === undefined) throw new Error('expected a grant');
    await store.extend?.(grant, 5000);
    await store.release(grant);
    expect(statements).toHaveLength(3);
    for (const { text } of statements) {
      expect(text).not.toMatch(/\bnow\s*\(/i);
      expect(text).not.toMatch(/\bDELETE\b/i);
      expect(text).toMatch(/clock_timestamp\(\)/);
    }
  });

  it('release keeps the row and clears the token, so the generation survives', async () => {
    const { db, statements } = recordingDb([{ pg_notify: '' }]);
    const store = pgLease(db, { ttl: '5s' });
    const outcome = await store.release({ key, token: 't1' });
    expect(outcome).toBe('released');
    expect(statements[0]?.text).toMatch(/SET token = NULL, expires_at = clock_timestamp\(\)/);
    expect(statements[0]?.text).toMatch(/pg_notify/);
  });

  it('a release that matches no row reports not-owner, so a stale holder cannot free a new holder', async () => {
    const { db } = recordingDb([]);
    expect(await pgLease(db, { ttl: '5s' }).release({ key, token: 'stale' })).toBe('not-owner');
  });

  it('extend checks owner and not-expired, so an expired lease is never revived', async () => {
    const { db, statements } = recordingDb([]);
    const ok = await pgLease(db, { ttl: '5s' }).extend?.({ key, token: 't1' }, 5000);
    expect(ok).toBe(false);
    expect(statements[0]?.text).toMatch(/WHERE key = \$\d+ AND token = \$\d+ AND expires_at > clock_timestamp\(\)/);
  });

  it('a custom or schema-qualified table is quoted into the SQL', async () => {
    const { db, statements } = recordingDb([]);
    await pgLease(db, { ttl: '5s', table: 'app.locks' }).acquire(key, { token: 't' });
    expect(statements[0]?.text).toMatch(/INSERT INTO "app"\."locks" AS lease/);
  });
});

describe('pgLease autocommit probe', () => {
  it('concurrent first acquires probe once (two statements), so a busy boot does not multiply the check', async () => {
    const { db, counts } = recordingDb([{ generation: '1', expires_ms: '1' }]);
    const store = pgLease(db, { ttl: '5s' });
    await Promise.all([
      store.acquire(key, { token: 'a' }),
      store.acquire(key, { token: 'b' }),
      store.acquire(key, { token: 'c' }),
    ]);
    await store.acquire(key, { token: 'd' });
    expect(counts.probes).toBe(2);
  });

  it('equal transaction timestamps mean one transaction: refused with config, before any lock SQL runs', async () => {
    const { db, statements } = recordingDb([{ generation: '1', expires_ms: '1' }], () =>
      Promise.resolve({ rows: [{ ts: 'same' }] }),
    );
    const store = pgLease(db, { ttl: '5s' });
    await expect(store.acquire(key, { token: 'a' })).rejects.toMatchObject({ code: 'config' });
    await expect(store.acquire(key, { token: 'b' })).rejects.toMatchObject({ code: 'config' });
    expect(statements).toEqual([]);
  });

  it('a probe that fails on the network is not cached, so the store works once the database is back', async () => {
    let down = true;
    let tick = 0;
    const { db, counts } = recordingDb([{ generation: '1', expires_ms: '1' }], () => {
      tick += 1;
      return down ? Promise.reject(new Error('connection refused')) : Promise.resolve({ rows: [{ ts: `t${tick}` }] });
    });
    const store = pgLease(db, { ttl: '5s' });
    await expect(store.acquire(key, { token: 'a' })).rejects.toThrow('connection refused');
    down = false;
    expect(await store.acquire(key, { token: 'b' })).toMatchObject({ fence: 1n });
    expect(counts.probes).toBe(3);
  });
});

describe('pgLease configuration', () => {
  it('a table name with SQL in it is refused, so a config value cannot inject SQL', () => {
    const { db } = recordingDb();
    expect(() => pgLease(db, { ttl: '5s', table: 'locks; DROP TABLE users' })).toThrow(LockError);
    expect(() => leaseTableSql('a"b')).toThrow(LockError);
  });

  it('a ttl below the renewal floor is a config error, because renewals at ttl/3 could not be trusted', () => {
    const { db } = recordingDb();
    for (const ttl of ['500ms', 0, '999ms'] as const) {
      expect(() => pgLease(db, { ttl })).toThrow(expect.objectContaining({ code: 'config' }));
    }
    expect(() => createLocks({ store: pgLease(db, { ttl: '1s' }), namespace: 'x' })).not.toThrow();
  });

  it('exposes ttlMs for the manager, which reads the lease length from the store', () => {
    const { db } = recordingDb();
    expect(pgLease(db, { ttl: '90s' }).ttlMs).toBe(90_000);
  });
});

describe('pgLease guarantees', () => {
  it('claims a durable fence, a store clock and expiry after ttl, nothing more', () => {
    const { db } = recordingDb();
    expect(pgLease(db, { ttl: '5s' }).guarantees).toMatchObject({
      kind: 'lease',
      scope: 'cluster',
      fence: 'durable',
      releasedOnCrash: 'after-ttl',
      clock: 'store',
      shared: false,
      permits: true,
    });
  });

  it('reports poll without a LISTEN connection and wake with one, so callers know how waits are done', () => {
    const { db } = recordingDb();
    const polling = pgLease(db, { ttl: '5s' });
    const waking = pgLease(db, { ttl: '5s', listen: noListen });
    expect(polling.guarantees.wait).toBe('poll');
    expect('waitFor' in polling).toBe(false);
    expect(waking.guarantees.wait).toBe('wake');
    expect('waitFor' in waking).toBe(true);
  });
});

describe('pgLease LISTEN connection', () => {
  it('every wait shares one LISTEN connection, so waiters can never drain the pool', async () => {
    const { db } = recordingDb([{ free: false }]);
    const listen = countingListen();
    const store = pgLease(db, { ttl: '5s', listen: listen.connect });
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const waits = controllers.map((controller, index) =>
      store.waitFor?.(createKey('app', `k${index}`), controller.signal),
    );
    await tick();
    const later = new AbortController();
    const another = store.waitFor?.(key, later.signal);
    await tick();
    expect(listen.state.connects).toBe(1);
    for (const controller of [...controllers, later]) controller.abort();
    await Promise.all([...waits, another]);
    await store.dispose?.();
    expect(listen.state.released).toBe(1);
  });

  it('a failed connect is not kept, so the next wait connects again once the database is back', async () => {
    const { db } = recordingDb([{ free: false }]);
    let fail = true;
    const listen = countingListen(() => (fail ? Promise.reject(new Error('down')) : Promise.resolve()));
    const store = pgLease(db, { ttl: '5s', listen: listen.connect });
    const controller = new AbortController();
    await expect(store.waitFor?.(key, controller.signal)).rejects.toThrow('down');
    fail = false;
    const waiting = store.waitFor?.(key, controller.signal);
    await tick();
    expect(listen.state.connects).toBe(2);
    controller.abort();
    await waiting;
    await store.dispose?.();
  });

  it('an abort settles the wait even while the LISTEN connection is still opening, so a cancelled caller never hangs', async () => {
    const { db } = recordingDb([{ free: false }]);
    const listen = countingListen(
      () =>
        new Promise<void>(() => {
          // A connect that never completes.
        }),
    );
    const store = pgLease(db, { ttl: '5s', listen: listen.connect });
    const controller = new AbortController();
    const waiting = store.waitFor?.(key, controller.signal);
    await tick();
    controller.abort();
    const settled = await Promise.race([
      waiting?.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 200)),
    ]);
    expect(settled).toBe(true);
  });
});

describe('lease table DDL', () => {
  it('has the fence column, the clock default and the semaphore columns', () => {
    expect(LEASE_TABLE_SQL).toMatch(/key\s+text\s+PRIMARY KEY/);
    expect(LEASE_TABLE_SQL).toMatch(/generation\s+bigint\s+NOT NULL DEFAULT 0/);
    expect(LEASE_TABLE_SQL).toMatch(/expires_at\s+timestamptz/);
    expect(LEASE_TABLE_SQL).toMatch(/permits_limit\s+integer/);
    expect(LEASE_TABLE_SQL).toMatch(/holders\s+jsonb\s+NOT NULL/);
    expect(LEASE_TABLE_SQL).toMatch(/IF NOT EXISTS/);
  });

  it('ensureLockTable runs the DDL for the chosen table', async () => {
    const { db, statements } = recordingDb();
    await ensureLockTable(db, 'my_locks');
    expect(statements[0]?.text).toContain('"my_locks"');
  });
});
