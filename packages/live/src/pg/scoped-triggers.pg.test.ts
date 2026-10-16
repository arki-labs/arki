/**
 * The scoped triggers on PGlite (Postgres 17 in WASM) and on real Postgres 16
 * and 18 (testcontainers): plan § 7, tests T1–T5.
 *
 * Why these tests exist: a scoped hint is only as good as the keys the
 * trigger names. A missed key leaves a client stale; a repeated one costs a
 * refetch; an unbounded statement must not abort the commit (an 8000-byte
 * payload error) nor turn into a table-wide hint that tells every tenant a
 * bulk write happened. Each case is one way a write could change keys
 * without the right NOTIFYs: a scope move, several statements and a
 * rolled-back savepoint in one transaction, too many keys, a TRUNCATE under
 * row-level security, a write naming a partition. The behaviour rests on
 * Postgres details (transition tables, NOTIFY folding, partition trigger
 * firing) that must hold on every version the package supports.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { SQL } from 'drizzle-orm';
import { PGlite } from '@electric-sql/pglite';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle as nodePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as pglite } from 'drizzle-orm/pglite';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LiveFeed, LiveHub, LiveScopes, TableTag } from '../index.js';
import { createLiveHub } from '../index.js';
import { CHANNEL } from '../tests/fixtures.js';
import { liveMigration, pgSource, touch, verifyLiveTriggers } from './index.js';
import { parseHint } from './source.js';

type Executor = { execute(query: SQL): Promise<unknown> };

/** One database: run SQL, hear the app's channel, run a Drizzle transaction. */
type Backend = {
  readonly exec: (text: string) => Promise<void>;
  readonly db: Executor;
  readonly transaction: (work: (tx: Executor) => Promise<void>) => Promise<void>;
  readonly heard: string[];
  readonly close: () => Promise<void>;
  /** A `pg` pool for `pgSource`, on a real server only. */
  readonly listenPool?: pg.Pool;
};

const tag = (table: string): TableTag => ({ schema: 'public', table });
const DOCS = tag('docs');
const RLS_DOCS = tag('rls_docs');
const RLS_NOTES = tag('rls_notes');
const EVENTS = tag('events');

const scopes: LiveScopes<'org'> = {
  dimensions: ['org'],
  tables: [DOCS, RLS_DOCS, RLS_NOTES, EVENTS].map(each => ({
    tag: each,
    dimension: 'org',
    column: 'org',
    kind: 'text',
  })),
};
const leaves = ['events_eu', 'events_eu_1', 'events_us'].map(leaf => ({ leaf: tag(leaf), root: EVENTS }));
const migration = liveMigration({ app: 'blog', tables: [DOCS, RLS_DOCS, RLS_NOTES, EVENTS], leaves, scopes });

const SCHEMA_SQL = `
CREATE TABLE docs (id int PRIMARY KEY, org text NOT NULL);
CREATE TABLE rls_docs (id int PRIMARY KEY, org text NOT NULL);
CREATE TABLE rls_notes (id int PRIMARY KEY, doc_id int NOT NULL REFERENCES rls_docs (id), org text NOT NULL);
ALTER TABLE rls_docs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rls_docs FORCE ROW LEVEL SECURITY;
CREATE POLICY only_a ON rls_docs USING (org = 'A');
CREATE ROLE app_user NOLOGIN;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON rls_docs, rls_notes TO app_user;
CREATE TABLE events (id int NOT NULL, org text NOT NULL, region text NOT NULL, sub int NOT NULL) PARTITION BY LIST (region);
CREATE TABLE events_eu PARTITION OF events FOR VALUES IN ('eu') PARTITION BY LIST (sub);
CREATE TABLE events_eu_1 PARTITION OF events_eu FOR VALUES IN (1);
CREATE TABLE events_us PARTITION OF events FOR VALUES IN ('us');
`;

async function onPglite(): Promise<Backend> {
  const client = new PGlite();
  const heard: string[] = [];
  await client.exec(SCHEMA_SQL);
  // Drizzle's migrator sends each statement alone on PGlite; exec takes the whole text.
  await client.exec(migration.up);
  await client.listen(CHANNEL, payload => {
    heard.push(payload);
  });
  const db = pglite({ client });
  return {
    exec: async text => {
      await client.exec(text);
    },
    db,
    transaction: work => db.transaction(work),
    heard,
    close: () => client.close(),
  };
}

async function onPostgres(container: StartedPostgreSqlContainer): Promise<Backend> {
  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
  const listener = new pg.Client({ connectionString: container.getConnectionUri() });
  const listenPool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 1 });
  listenPool.on('error', () => null);
  const heard: string[] = [];
  await pool.query(SCHEMA_SQL);
  await pool.query(migration.up);
  await listener.connect();
  listener.on('notification', message => {
    if (message.payload !== undefined) heard.push(message.payload);
  });
  await listener.query(`LISTEN ${CHANNEL}`);
  const db = nodePostgres({ client: pool });
  return {
    exec: async text => {
      await pool.query(text);
    },
    db,
    transaction: work => db.transaction(work),
    heard,
    listenPool,
    close: async () => {
      await listener.end();
      await Promise.all([pool.end(), listenPool.end()]);
    },
  };
}

/** A hint as `table:key`, `table:OVERFLOW`, or `table:*` for a keyless one. */
function label(payload: string): string {
  const hint = parseHint(payload);
  if (!hint) throw new Error(`not a live hint: ${payload}`);
  if ('overflow' in hint) return `${hint.tag.table}:OVERFLOW`;
  return `${hint.tag.table}:${hint.key ?? '*'}`;
}

/** The stream of `view` on `hub`, as an iterator. */
async function streamOf(hub: LiveHub, options: Parameters<LiveHub['open']>[0]): Promise<AsyncIterator<LiveFeed>> {
  const feed = await hub.open(options);
  return feed[Symbol.asyncIterator]();
}

async function first(stream: AsyncIterator<LiveFeed>): Promise<LiveFeed | undefined> {
  const next = await stream.next();
  return next.done ? undefined : next.value;
}

describe.each([
  ['PGlite', 'pglite'],
  ['postgres:16', 'postgres:16-alpine'],
  ['postgres:18', 'postgres:18-alpine'],
])('scoped triggers on %s', (_name, image) => {
  let container: StartedPostgreSqlContainer | undefined;
  let backend: Backend;
  let sentinels = 0;

  /** Every hint since the last call, in arrival order. A sentinel published last marks the end: NOTIFY keeps commit order. */
  async function settle(): Promise<readonly string[]> {
    sentinels += 1;
    const sentinel = `sentinel_${sentinels}`;
    await touch(backend.db, 'blog', { schema: 'test', table: sentinel });
    await expect.poll(() => backend.heard.some(payload => payload.includes(sentinel)), { timeout: 15_000 }).toBe(true);
    const since = backend.heard.splice(0).map(payload => label(payload));
    return since.filter(each => !each.startsWith('sentinel_'));
  }

  /** `settle()` in sorted order: keys of one statement arrive in no fixed order. */
  async function settleSorted(): Promise<readonly string[]> {
    const hints = await settle();
    return hints.toSorted();
  }

  async function settleLengths(): Promise<readonly number[]> {
    const hints = await settle();
    return hints.map(each => each.length);
  }

  beforeAll(async () => {
    if (image === 'pglite') {
      backend = await onPglite();
      return;
    }
    container = await new PostgreSqlContainer(image).start();
    backend = await onPostgres(container);
  });

  beforeEach(async () => {
    await settle();
  });

  afterAll(async () => {
    await backend.close();
    await container?.stop();
  });

  it('T1: one NOTIFY per distinct key: insert A, A, B; a scope move names both keys; a delete names its key', async () => {
    await backend.exec(`INSERT INTO docs VALUES (1, 'A'), (2, 'A'), (3, 'B')`);
    expect(await settleSorted()).toEqual(['docs:A', 'docs:B']);
    await backend.exec(`UPDATE docs SET org = 'C' WHERE id = 1`);
    expect(await settleSorted()).toEqual(['docs:A', 'docs:C']);
    await backend.exec(`DELETE FROM docs WHERE id = 3`);
    expect(await settle()).toEqual(['docs:B']);
    // A statement that changes no row names no key.
    await backend.exec(`UPDATE docs SET org = org WHERE false`);
    expect(await settle()).toEqual([]);
    await backend.exec(`DELETE FROM docs`);
    await settle();
  });

  it('T2: one transaction hints each (table, key) once across statements with different key sets; a rolled-back savepoint hints nothing; touch folds in', async () => {
    await backend.exec(`
      BEGIN;
      INSERT INTO docs VALUES (10, 'A'), (11, 'B');
      INSERT INTO docs VALUES (12, 'B');
      UPDATE docs SET org = 'A' WHERE id = 10;
      SAVEPOINT s;
      INSERT INTO docs VALUES (13, 'D');
      ROLLBACK TO SAVEPOINT s;
      COMMIT;
    `);
    expect(await settleSorted()).toEqual(['docs:A', 'docs:B']);
    await backend.transaction(async tx => {
      await tx.execute(sql`INSERT INTO docs VALUES (14, 'A')`);
      await touch(tx, { app: 'blog', scopes }, { ...DOCS, keys: ['A'] });
    });
    expect(await settle()).toEqual(['docs:A']);
    await backend.exec(`DELETE FROM docs`);
    await settle();
  });

  it('T3: past 65 536 keys, or a key past 512 bytes, a statement sends one overflow and still commits', async () => {
    await backend.exec(`INSERT INTO docs SELECT g, 'k' || g FROM generate_series(1, 65537) AS g`);
    expect(await settle()).toEqual(['docs:OVERFLOW']);
    await backend.exec(`DELETE FROM docs WHERE id = 65537`);
    await settle();
    await backend.exec(`UPDATE docs SET org = org`);
    const exact = await settle();
    expect(exact).toHaveLength(65_536);
    expect(new Set(exact).size).toBe(65_536);
    await backend.exec(`DELETE FROM docs`);
    await settle();
    await backend.exec(`INSERT INTO docs VALUES (1, repeat('k', 513))`);
    expect(await settle()).toEqual(['docs:OVERFLOW']);
    await backend.exec(`INSERT INTO docs VALUES (2, repeat('k', 512))`);
    expect(await settleLengths()).toEqual(['docs:'.length + 512]);
    await backend.exec(`DELETE FROM docs`);
    await settle();
  });

  it('T4: TRUNCATE (and TRUNCATE … CASCADE) names the removed keys, also those row-level security hides from the truncating role', async () => {
    await backend.exec(`
      INSERT INTO rls_docs VALUES (1, 'A'), (2, 'B');
      INSERT INTO rls_notes VALUES (1, 1, 'A'), (2, 2, 'N');
    `);
    await settle();
    await backend.exec(`BEGIN; SET LOCAL ROLE app_user; TRUNCATE rls_docs CASCADE; COMMIT;`);
    expect(await settleSorted()).toEqual(['rls_docs:A', 'rls_docs:B', 'rls_notes:A', 'rls_notes:N']);
    await backend.exec(`INSERT INTO rls_docs VALUES (3, 'C');`);
    await settle();
    await backend.exec(`TRUNCATE rls_notes, rls_docs`);
    expect(await settle()).toEqual(['rls_docs:C']);
  });

  it('T5: a write via the root, a sub-partition or a leaf publishes the root with its keys; a cross-partition move names both', async () => {
    await backend.exec(`INSERT INTO events VALUES (1, 'A', 'eu', 1), (2, 'B', 'us', 0)`);
    expect(await settleSorted()).toEqual(['events:A', 'events:B']);
    await backend.exec(`INSERT INTO events_eu VALUES (3, 'C', 'eu', 1)`);
    expect(await settle()).toEqual(['events:C']);
    await backend.exec(`INSERT INTO events_eu_1 VALUES (4, 'D', 'eu', 1)`);
    expect(await settle()).toEqual(['events:D']);
    await backend.exec(`UPDATE events SET region = 'us', sub = 0, org = 'E' WHERE id = 1`);
    expect(await settleSorted()).toEqual(['events:A', 'events:E']);
    await backend.exec(`DELETE FROM events`);
    await settle();
  });

  it('T5: verifyLiveTriggers passes the migrated tables and names an uncovered partition, a nullable or missing key column', async () => {
    const options = { app: 'blog', tables: [DOCS, RLS_DOCS, RLS_NOTES, EVENTS], scopes };
    expect(await verifyLiveTriggers(backend.db, options)).toEqual([]);
    await backend.exec(`CREATE TABLE events_eu_2 PARTITION OF events_eu FOR VALUES IN (2)`);
    expect(await verifyLiveTriggers(backend.db, options)).toEqual([
      { tag: tag('events_eu_2'), problem: 'partition-leaf-uncovered' },
    ]);
    await backend.exec(`DROP TABLE events_eu_2`);
    await backend.exec(`ALTER TABLE docs ALTER COLUMN org DROP NOT NULL`);
    expect(await verifyLiveTriggers(backend.db, options)).toEqual([{ tag: DOCS, problem: 'nullable-column' }]);
    await backend.exec(`ALTER TABLE docs ALTER COLUMN org SET NOT NULL`);
    const tenant: LiveScopes = {
      dimensions: ['org'],
      tables: [{ tag: DOCS, dimension: 'org', column: 'tenant', kind: 'text' }],
    };
    const problems = await verifyLiveTriggers(backend.db, { app: 'blog', tables: [DOCS], scopes: tenant });
    expect(problems).toEqual([
      { tag: DOCS, problem: 'missing-column' },
      { tag: DOCS, problem: 'wrong-args' },
    ]);
    // The migration itself refuses a scoped table without its NOT NULL key column.
    await backend.exec(`CREATE TABLE loose (id int, org text)`);
    const loose = liveMigration({
      app: 'blog',
      tables: [tag('loose')],
      scopes: { dimensions: ['org'], tables: [{ tag: tag('loose'), dimension: 'org', column: 'org', kind: 'text' }] },
    });
    await expect(backend.exec(loose.up)).rejects.toThrow(/must exist and be NOT NULL/);
  });

  it('T3 end to end: an overflow ends every stream with gap, and the hub comes back in a new epoch', async ({
    skip,
  }) => {
    if (backend.listenPool === undefined) {
      skip('pgSource needs a pg pool: real Postgres only');
      return;
    }
    const hub: LiveHub = createLiveHub({
      source: pgSource({ pool: backend.listenPool, app: 'blog', retryMs: 50 }),
      limits: { batchMs: 5 },
    });
    await hub.start();
    await expect.poll(() => hub.status(), { timeout: 10_000 }).toBe('ready');
    const feed = await streamOf(hub, {
      view: { scopes: [{ tag: DOCS, name: 'org', keys: 'all' }] },
      signal: AbortSignal.timeout(20_000),
    });
    const begin = await first(feed);
    await backend.exec(`INSERT INTO docs SELECT g, 'k' || g FROM generate_series(1, 65537) AS g`);
    const items: LiveFeed[] = [];
    for (let next = await feed.next(); !next.done; next = await feed.next()) items.push(next.value);
    expect(items).toEqual([{ kind: 'gap' }]);
    await expect.poll(() => hub.status(), { timeout: 10_000 }).toBe('ready');
    const cursor = begin?.kind === 'begin' ? begin.cursor : undefined;
    const again = await streamOf(hub, {
      ...(cursor === undefined ? {} : { cursor }),
      signal: AbortSignal.timeout(5000),
    });
    expect(await first(again)).toMatchObject({ kind: 'begin', mode: 'reset' });
    await again.return?.();
    await hub.stop();
    await backend.exec(`DELETE FROM docs`);
    await settle();
  });
});
