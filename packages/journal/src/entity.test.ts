/**
 * The four consumer-driven changes: a named key column, `events` with the
 * transaction, one event with both reducers, and create-set columns in `.on`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgInsertValue, PgTable } from 'drizzle-orm/pg-core';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import {
  char,
  customType,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import type { DbHandle } from './types.js';
import { isJournalError } from './errors.js';
import {
  accountId,
  customerOrderCounts,
  j,
  meta,
  openDb,
  order,
  orderId,
  OrderPlaced,
  profile,
  ProfileClosed,
  ProfileFlagged,
  ProfileMoved,
  ProfileOpened,
  profiles,
  tables,
} from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let journal: ReturnType<typeof j.compose>;
let next = 100;

beforeAll(async () => {
  ({ db, client } = await openDb());
  journal = j.compose({});
});

afterAll(async () => {
  await client.close();
});

const code = (error: unknown) => (isJournalError(error) ? error.code : error);
const eventsFor = (id: string) => db.select().from(tables.events).where(eq(tables.events.entityId, id));

describe('a named key column', () => {
  it('writes, updates, deletes and replays a row under its own key column, so a table needs no `id`', async () => {
    const id = accountId(++next);
    const opened = orThrow(
      await journal.write(db, profile, id, { meta, events: () => [ProfileOpened({ nick: 'ann' })] }),
    );
    expect(opened.row).toEqual({ accountId: id, nick: 'ann', moveCount: 0, version: 1 });

    const moved = orThrow(await journal.write(db, profile, id, { meta, events: () => [ProfileMoved({})] }));
    expect(moved.row).toMatchObject({ accountId: id, moveCount: 1, version: 2 });

    const replayed = orThrow(await journal.replay(db, profile, id));
    expect(replayed.row).toEqual({ accountId: id, nick: 'ann', moveCount: 1, version: 2 });
    expect(await journal.verify(db, profile, id)).toEqual({ ok: true });

    await db.update(profiles).set({ nick: 'drifted' }).where(eq(profiles.accountId, id));
    expect(await journal.verify(db, profile, id)).toMatchObject({ ok: false });
    expect(await journal.repair(db, profile, id)).toMatchObject({ accountId: id, nick: 'ann' });

    const closed = orThrow(await journal.write(db, profile, id, { meta, events: () => [ProfileClosed({})] }));
    expect(closed.row).toBeNull();
    expect(await db.select().from(profiles).where(eq(profiles.accountId, id))).toEqual([]);
  });

  it('stores the key value as the event entity id and stamps it on recorded events', async () => {
    const id = accountId(++next);
    const { events } = orThrow(
      await journal.write(db, profile, id, { meta, events: () => [ProfileOpened({ nick: 'bo' })] }),
    );
    expect(events.map(e => e.entityId)).toEqual([id]);
    const stored = await db.select().from(tables.events).where(eq(tables.events.entityId, id));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'profile', entityId: id, version: 1 });
  });

  it('rejects, at definition time, a key column that is neither primary nor unique, naming the entity and column', () => {
    const loose = pgTable('loose', {
      code: varchar('code', { length: 8 }).notNull(),
      count: integer('count').notNull(),
      version: integer('version').notNull().default(0),
    });
    expect(() => j.entity('loose', loose, { key: 'code' })).toThrow(
      'journal: entity "loose": key column "code" must be the primary key or carry a unique constraint',
    );
    // The type already rejects these; the runtime checks back it up for untyped callers.
    // @ts-expect-error -- `count` is an integer column
    expect(() => j.entity('loose', loose, { key: 'count' })).toThrow(
      'journal: entity "loose": key column "count" must hold a string',
    );
    // @ts-expect-error -- not a column of `loose`
    expect(() => j.entity('loose', loose, { key: 'nope' })).toThrow(
      'journal: entity "loose": table "loose" has no column "nope"',
    );
  });

  it('accepts a key column made unique at table level, by a unique constraint or a unique index on that one column', () => {
    // Why: `column.isUnique` only sees `.unique()` on the column. A table-level constraint is just as good a key.
    const columns = {
      code: varchar('code', { length: 8 }).notNull(),
      other: varchar('other', { length: 8 }).notNull(),
      version: integer('version').notNull().default(0),
    };
    const byConstraint = pgTable('by_constraint', columns, t => [unique().on(t.code)]);
    const byIndex = pgTable('by_index', columns, t => [uniqueIndex('by_index_code').on(t.code)]);
    const byPair = pgTable('by_pair', columns, t => [unique().on(t.code, t.other)]);
    expect(j.entity('by-constraint', byConstraint, { key: 'code' }).key).toBe('code');
    expect(j.entity('by-index', byIndex, { key: 'code' }).key).toBe('code');
    // Two columns together identify a row; one of them alone does not.
    expect(() => j.entity('by-pair', byPair, { key: 'code' })).toThrow(
      'journal: entity "by-pair": key column "code" must be the primary key or carry a unique constraint',
    );
  });

  it('rejects a key column whose unique index has a where clause: it is unique only inside that subset', () => {
    // Why: `unique on (code) where active` lets two inactive rows share a code. One journal
    // write would then lock and update both rows under one id.
    const partial = pgTable(
      'partial',
      {
        code: varchar('code', { length: 8 }).notNull(),
        active: integer('active').notNull().default(1),
        version: integer('version').notNull().default(0),
      },
      t => [
        uniqueIndex('partial_code')
          .on(t.code)
          .where(sql`${t.active} = 1`),
      ],
    );
    expect(() => j.entity('partial', partial, { key: 'code' })).toThrow(
      'journal: entity "partial": key column "code" must be the primary key or carry a unique constraint',
    );
  });

  it('rejects a nullable key column, even a unique one: a NULL key cannot be found by an id', () => {
    const nullable = pgTable('nullable', {
      code: varchar('code', { length: 8 }).unique(),
      version: integer('version').notNull().default(0),
    });
    // @ts-expect-error -- `code` may be null
    expect(() => j.entity('nullable', nullable, { key: 'code' })).toThrow(
      'journal: entity "nullable": key column "code" must be not null',
    );
  });
});

describe('rows that existed before the journal', () => {
  it('a version-0 row with no history starts its history at version 2, and replay, verify and repair refuse it', async () => {
    // Why: ProfileFlagged has both reducers. Write applies `.on` (the row exists) and keeps moveCount 9.
    // A replay from nothing would apply `.create` and build moveCount 0, and repair would save that.
    // Version 1 is reserved for a real create, so a history that starts at 2 is known to be partial.
    const id = accountId(++next);
    await db.insert(profiles).values({ accountId: id, nick: 'old', moveCount: 9 });
    const flagged = orThrow(
      await journal.write(db, profile, id, { meta, events: () => [ProfileFlagged({ nick: 'flagged' })] }),
    );
    expect(flagged.row).toEqual({ accountId: id, nick: 'flagged', moveCount: 9, version: 2 });
    expect(flagged.events.map(e => e.version)).toEqual([2]);
    const moved = orThrow(await journal.write(db, profile, id, { meta, events: () => [ProfileMoved({})] }));
    expect(moved.row).toEqual({ accountId: id, nick: 'flagged', moveCount: 10, version: 3 });
    const stored = await db
      .select({ version: tables.events.version })
      .from(tables.events)
      .where(eq(tables.events.entityId, id))
      .orderBy(tables.events.version);
    expect(stored.map(e => e.version)).toEqual([2, 3]);

    await expect(journal.replay(db, profile, id).catch(code)).resolves.toBe('NO_HISTORY');
    await expect(journal.verify(db, profile, id).catch(code)).resolves.toBe('NO_HISTORY');
    await expect(journal.repair(db, profile, id).catch(code)).resolves.toBe('NO_HISTORY');
    expect(await db.select().from(profiles).where(eq(profiles.accountId, id))).toEqual([
      { accountId: id, nick: 'flagged', moveCount: 10, version: 3 },
    ]);
  });

  it('a row the journal creates still starts at version 1, and a create after a delete continues the sequence', async () => {
    const id = accountId(++next);
    const opened = orThrow(
      await journal.write(db, profile, id, { meta, events: () => [ProfileOpened({ nick: 'one' })] }),
    );
    expect(opened.row?.version).toBe(1);
    orThrow(await journal.write(db, profile, id, { meta, events: () => [ProfileClosed({})] }));
    const again = orThrow(
      await journal.write(db, profile, id, { meta, events: () => [ProfileFlagged({ nick: 'two' })] }),
    );
    expect(again.row).toEqual({ accountId: id, nick: 'two', moveCount: 0, version: 3 });
    expect(await journal.verify(db, profile, id)).toEqual({ ok: true });
  });

  it('a row removed outside the journal is a CONFLICT on the next create, and repair restores it', async () => {
    // Why: write sees no row and would apply `.create` (moveCount 0); replay still has the
    // history and applies `.on` (moveCount 1). The two would disagree, and repair would then
    // overwrite the write. The log is the truth: the row must come back from it first.
    const id = accountId(++next);
    orThrow(await journal.write(db, profile, id, { meta, events: () => [ProfileOpened({ nick: 'one' })] }));
    orThrow(await journal.write(db, profile, id, { meta, events: () => [ProfileMoved({})] }));
    await db.delete(profiles).where(eq(profiles.accountId, id));

    await expect(
      journal.write(db, profile, id, { meta, events: () => [ProfileFlagged({ nick: 'two' })] }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('removed outside the journal') as string,
    });
    expect(await db.select().from(profiles).where(eq(profiles.accountId, id))).toEqual([]);
    const replayed = orThrow(await journal.replay(db, profile, id));
    expect(replayed.events.map(e => e.version)).toEqual([1, 2]);

    expect(await journal.repair(db, profile, id)).toEqual({ accountId: id, nick: 'one', moveCount: 1, version: 2 });
    const flagged = orThrow(
      await journal.write(db, profile, id, { meta, events: () => [ProfileFlagged({ nick: 'two' })] }),
    );
    expect(flagged.row).toEqual({ accountId: id, nick: 'two', moveCount: 1, version: 3 });
    expect(await journal.verify(db, profile, id)).toEqual({ ok: true });
  });
});

describe('the order of .create and .on', () => {
  it('rejects a .create declared after an .on, because the .on was promised every column the creates so far set', () => {
    const sealed = j
      .entity('late', profiles, { key: 'accountId' })
      .create(ProfileOpened, e => ({ nick: e.data.nick, moveCount: 0 }))
      .on(ProfileMoved, row => ({ moveCount: row.moveCount + 1 }));
    expect(() =>
      // @ts-expect-error -- `.create` is gone after the first `.on`
      sealed.create(ProfileFlagged, e => ({ nick: e.data.nick })),
    ).toThrow('journal: entity "late": declare .create(ProfileFlagged) before any .on; .on(ProfileMoved) came first');
  });
});

describe('events receives the write transaction', () => {
  it('lets events read related rows through the same transaction, under the row lock', async () => {
    const id = orderId(++next);
    await db.transaction(async tx => {
      await tx.insert(customerOrderCounts).values({ customerId: 'vip', placed: 3 });
      const { row } = orThrow(
        await journal.write(tx, order, id, {
          meta,
          events: async (_row, ctx) => {
            const [count] = await ctx.tx
              .select()
              .from(customerOrderCounts)
              .where(eq(customerOrderCounts.customerId, 'vip'));
            return [OrderPlaced({ customerId: 'vip', total: (count?.placed ?? 0) * 10 })];
          },
        }),
      );
      expect(row?.total).toBe(30);
    });
  });
});

describe('one event with a create and an on reducer', () => {
  it('creates the row when there is none and patches it when there is one, so no extra "opened" event is needed', async () => {
    const id = accountId(++next);
    const first = orThrow(
      await journal.write(db, profile, id, { meta, events: () => [ProfileFlagged({ nick: 'new' })] }),
    );
    expect(first.row).toEqual({ accountId: id, nick: 'new', moveCount: 0, version: 1 });
    const second = orThrow(
      await journal.write(db, profile, id, { meta, events: () => [ProfileFlagged({ nick: 'renamed' })] }),
    );
    expect(second.row).toEqual({ accountId: id, nick: 'renamed', moveCount: 0, version: 2 });
    expect(await journal.verify(db, profile, id)).toEqual({ ok: true });
  });

  it('keeps the one-mode checks: a create-only event on a row is ROW_EXISTS, an on-only event with no row is NO_ROW', async () => {
    const id = accountId(++next);
    await expect(journal.write(db, profile, id, { meta, events: () => [ProfileMoved({})] }).catch(code)).resolves.toBe(
      'NO_ROW',
    );
    orThrow(await journal.write(db, profile, id, { meta, events: () => [ProfileOpened({ nick: 'cy' })] }));
    await expect(
      journal.write(db, profile, id, { meta, events: () => [ProfileOpened({ nick: 'again' })] }).catch(code),
    ).resolves.toBe('ROW_EXISTS');
  });

  it('rejects a second reducer of the same mode for one event at definition time', () => {
    const base = j.entity('twice', profiles, { key: 'accountId' });
    expect(() =>
      base.create(ProfileOpened, e => ({ nick: e.data.nick })).create(ProfileOpened, e => ({ nick: e.data.nick })),
    ).toThrow('journal: entity "twice" already declares a create reducer for "ProfileOpened"');
    expect(() => base.on(ProfileMoved, () => ({})).on(ProfileMoved, () => ({}))).toThrow(
      'journal: entity "twice" already declares an on reducer for "ProfileMoved"',
    );
  });
});

describe('columns the create reducer sets', () => {
  it('reach the on reducer on write and on replay, so it needs no default fallback', async () => {
    const id = accountId(++next);
    orThrow(await journal.write(db, profile, id, { meta, events: () => [ProfileOpened({ nick: 'dee' })] }));
    orThrow(await journal.write(db, profile, id, { meta, events: () => [ProfileMoved({}), ProfileMoved({})] }));
    const { row } = orThrow(await journal.replay(db, profile, id));
    expect(row?.moveCount).toBe(2);
    expect(await journal.verify(db, profile, id)).toEqual({ ok: true });
  });
});

describe('a uuid key column', () => {
  // Why: Postgres treats the upper and lower case spellings of a uuid as one key, but the log is
  // keyed by the raw string. A second spelling would split one entity's history across two ids,
  // and repair would replay only half of it and overwrite the row. The journal refuses instead.
  const wallets = pgTable('wallets', {
    id: uuid('id').primaryKey(),
    count: integer('count').notNull(),
    version: integer('version').notNull().default(0),
  });
  const Opened = j.event('WalletOpened', z.object({}));
  const Added = j.event('WalletAdded', z.object({}));
  const wallet = j
    .entity('wallet', wallets)
    .create(Opened, () => ({ count: 0 }))
    .on(Added, row => ({ count: row.count + 1 }));
  const open = (id: string) => journal.write(db, wallet, id, { meta, events: () => [Opened({})] });
  const add = (id: string) => journal.write(db, wallet, id, { meta, events: () => [Added({})] });
  const upper = '550E8400-E29B-41D4-A716-446655440000';
  const lower = upper.toLowerCase();
  const rows = () => db.select().from(wallets);

  beforeAll(async () => {
    await client.exec(
      'create table wallets (id uuid primary key, count integer not null, version integer not null default 0)',
    );
  });

  it('a create with the upper-case id is refused and leaves no event or row, because the database would store another spelling', async () => {
    await expect(open(upper).catch(code)).resolves.toBe('ID_MISMATCH');
    expect(await eventsFor(upper)).toEqual([]);
    expect(await eventsFor(lower)).toEqual([]);
    expect(await rows()).toEqual([]);
  });

  it('a write with another spelling of an existing key is refused and writes nothing, so one entity never has two logs', async () => {
    orThrow(await open(lower));
    await expect(add(upper).catch(code)).resolves.toBe('ID_MISMATCH');
    expect(await eventsFor(upper)).toEqual([]);
    const logged = await eventsFor(lower);
    expect(logged.map(e => e.version)).toEqual([1]);
    expect(await rows()).toEqual([{ id: lower, count: 0, version: 1 }]);
  });

  it('repair and verify with another spelling are refused and leave the row untouched, so repair cannot overwrite it', async () => {
    orThrow(await add(lower));
    await expect(journal.repair(db, wallet, upper).catch(code)).resolves.toBe('ID_MISMATCH');
    await expect(journal.verify(db, wallet, upper).catch(code)).resolves.toBe('ID_MISMATCH');
    expect(await rows()).toEqual([{ id: lower, count: 1, version: 2 }]);
  });

  it('the same spelling throughout still writes, replays and verifies', async () => {
    orThrow(await add(lower));
    const replayed = orThrow(await journal.replay(db, wallet, lower));
    expect(replayed.events.map(e => e.version)).toEqual([1, 2, 3]);
    expect(await journal.verify(db, wallet, lower)).toEqual({ ok: true });
    expect(await journal.repair(db, wallet, lower)).toEqual({ id: lower, count: 2, version: 3 });
  });

  const Closed = j.event('WalletClosed', z.object({}));
  const closable = j
    .entity('closable-wallet', wallets)
    .create(Opened, () => ({ count: 0 }))
    .on(Closed, () => null);
  const upperTwo = '6BA7B810-9DAD-11D1-80B4-00C04FD430C8';
  const lowerTwo = upperTwo.toLowerCase();

  it('a create and delete in one write under an upper-case id is refused, because no row survives to show the id is a different spelling', async () => {
    await expect(
      journal.write(db, closable, upperTwo, { meta, events: () => [Opened({}), Closed({})] }).catch(code),
    ).resolves.toBe('ID_MISMATCH');
    expect(await eventsFor(upperTwo)).toEqual([]);
    expect(await eventsFor(lowerTwo)).toEqual([]);
  });

  it('replay, verify and repair with an upper-case id are refused even when no row exists, so they never read or write under a second spelling', async () => {
    await expect(journal.replay(db, closable, upperTwo).catch(code)).resolves.toBe('ID_MISMATCH');
    await expect(journal.verify(db, closable, upperTwo).catch(code)).resolves.toBe('ID_MISMATCH');
    await expect(journal.repair(db, closable, upperTwo).catch(code)).resolves.toBe('ID_MISMATCH');
  });

  it('a lower-case id creates, deletes and creates again with the version continuing, so the log stays one history', async () => {
    orThrow(await journal.write(db, closable, lowerTwo, { meta, events: () => [Opened({})] }));
    orThrow(await journal.write(db, closable, lowerTwo, { meta, events: () => [Closed({})] }));
    const again = orThrow(await journal.write(db, closable, lowerTwo, { meta, events: () => [Opened({})] }));
    expect(again.row).toEqual({ id: lowerTwo, count: 0, version: 3 });
    const replayed = orThrow(await journal.replay(db, closable, lowerTwo));
    expect(replayed.events.map(e => e.version)).toEqual([1, 2, 3]);
    expect(await journal.verify(db, closable, lowerTwo)).toEqual({ ok: true });
  });
});

// Hoisted: it needs nothing from a describe block.
const typed = (sqlType: string) => customType<{ data: string; driverData: string }>({ dataType: () => sqlType });

// Wraps a transaction so the events insert reads back another entity_id than the one stored.
const changing = (tx: DbHandle): DbHandle =>
  new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'transaction') {
        return <T>(run: (sp: DbHandle) => Promise<T>) => target.transaction(sp => run(changing(sp)));
      }
      if (prop === 'insert') {
        return (table: PgTable) => {
          if (table !== tables.events) return target.insert(table);
          return new Proxy(target.insert(tables.events), {
            get(inner, name, innerReceiver) {
              if (name !== 'values') return Reflect.get(inner, name, innerReceiver);
              return (rows: PgInsertValue<typeof tables.events>[]) => {
                const built = inner.values(rows);
                return new Proxy(built, {
                  get(b, method, bReceiver) {
                    if (method !== 'returning') return Reflect.get(b, method, bReceiver);
                    return returningWithBang(built);
                  },
                });
              };
            },
          });
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

const tableWith = (name: string, sqlType: string) =>
  pgTable(name, {
    id: typed(sqlType)('id').primaryKey(),
    version: integer('version').notNull().default(0),
  });

const returningWithBang =
  <R extends { entityId: string }>(query: { returning: () => Promise<R[]> }) =>
  () =>
    query.returning().then(withBang);
const withBang = <R extends { entityId: string }>(stored: R[]): R[] =>
  stored.map(r => ({ ...r, entityId: `${r.entityId}!` }));

describe('the key column type', () => {
  // Why: the journal compares keys as exact strings. A column type that treats two different
  // strings as one key (citext, a padded char) would split or merge histories without any error.

  it('refuses a citext key and names the entity, column and type', () => {
    expect(() => j.entity('folded', tableWith('folded', 'citext'))).toThrow(
      'journal: entity "folded": key column "id" has SQL type "citext"; the key must be text, varchar or uuid, because other types can treat two different strings as the same key',
    );
  });

  it('refuses a char(36) key, because blank padding makes different strings equal', () => {
    const padded = pgTable('padded', {
      id: char('id', { length: 36 }).primaryKey(),
      version: integer('version').notNull(),
    });
    expect(() => j.entity('padded', padded)).toThrow(/entity "padded": key column "id" has SQL type "char\(36\)"/);
  });

  it('accepts text, varchar, varchar(n) and a branded varchar(256), because these are native string columns', () => {
    type Branded = string & { readonly brand: 'AccountKey' };
    const plain = pgTable('plain', { id: text('id').primaryKey(), version: integer('version').notNull() });
    const bare = pgTable('bare', { id: varchar('id').primaryKey(), version: integer('version').notNull() });
    const sized = pgTable('sized', {
      id: varchar('id', { length: 12 }).primaryKey(),
      version: integer('version').notNull(),
    });
    const branded = pgTable('branded', {
      id: varchar('id', { length: 256 }).$type<Branded>().primaryKey(),
      version: integer('version').notNull(),
    });
    expect(() => j.entity('plain', plain)).not.toThrow();
    expect(() => j.entity('bare', bare)).not.toThrow();
    expect(() => j.entity('sized', sized)).not.toThrow();
    expect(() => j.entity('branded', branded)).not.toThrow();
  });

  it('refuses a custom type even when it reports varchar(256) or text, because its mapping can change the string', () => {
    const lowering = customType<{ data: string; driverData: string }>({
      dataType: () => 'varchar(256)',
      toDriver: value => value.toLowerCase(),
    });
    const lowered = pgTable('lowered', { id: lowering('id').primaryKey(), version: integer('version').notNull() });
    const message =
      'journal: entity "lowered": key column "id" is a custom column type; a key must be a plain text, varchar or uuid column, because a custom type\'s mapping can change the string';
    expect(() => j.entity('lowered', lowered)).toThrow(message);
    expect(() => j.entity('brand-varchar', tableWith('brand_varchar', 'varchar(256)'))).toThrow(/custom column type/);
    expect(() => j.entity('brand-text', tableWith('brand_text', ' TEXT '))).toThrow(/custom column type/);
  });
});

describe('the length of an id', () => {
  // Why: the database or the log can cut an id (varchar(n) drops excess trailing spaces, the log's
  // entity_id holds 256 characters). A write that ends deleted stores no row, so nothing would
  // show the cut. The journal refuses an id that is empty or too long, before any database access.
  const Opened = j.event('SlugOpened', z.object({}));
  const Closed = j.event('SlugClosed', z.object({}));
  const shorts = pgTable('shorts', {
    id: varchar('id', { length: 3 }).primaryKey(),
    version: integer('version').notNull(),
  });
  const longs = pgTable('longs', { id: text('id').primaryKey(), version: integer('version').notNull() });
  const short = j
    .entity('short-slug', shorts)
    .create(Opened, () => ({}))
    .on(Closed, () => null);
  const long = j
    .entity('slug', longs)
    .create(Opened, () => ({}))
    .on(Closed, () => null);
  const cycleShort = (id: string) => journal.write(db, short, id, { meta, events: () => [Opened({}), Closed({})] });
  const cycle = (id: string) => journal.write(db, long, id, { meta, events: () => [Opened({}), Closed({})] });

  beforeAll(async () => {
    await client.exec('create table shorts (id varchar(3) primary key, version integer not null)');
    await client.exec('create table longs (id text primary key, version integer not null)');
  });

  it('a create-and-delete write under "abc " in a varchar(3) key is refused and logs nothing, because Postgres would drop the space', async () => {
    await expect(cycleShort('abc ').catch(code)).resolves.toBe('ID_MISMATCH');
    expect(await eventsFor('abc ')).toEqual([]);
    expect(await eventsFor('abc')).toEqual([]);
  });

  it('the same write under "abc" works, so the limit is the column length and not stricter', async () => {
    await expect(cycleShort('abc')).resolves.toMatchObject({ row: null });
    const logged = await eventsFor('abc');
    expect(logged.map(e => e.version)).toEqual([1, 2]);
  });

  it('a 257-character text id is refused by write, replay, verify and repair before anything is written, because the log holds 256', async () => {
    const id = `${'a'.repeat(256)} `;
    await expect(cycle(id).catch(code)).resolves.toBe('ID_MISMATCH');
    await expect(journal.replay(db, long, id).catch(code)).resolves.toBe('ID_MISMATCH');
    await expect(journal.verify(db, long, id).catch(code)).resolves.toBe('ID_MISMATCH');
    await expect(journal.repair(db, long, id).catch(code)).resolves.toBe('ID_MISMATCH');
    expect(await db.select().from(tables.events).where(eq(tables.events.kind, 'slug'))).toEqual([]);
  });

  it('the refusal counts code points and shows the length, the limit and whose limit it is', async () => {
    const id = '😀'.repeat(257);
    const error = await cycle(id).catch((error_: unknown) => error_);
    expect(error instanceof Error ? error.message : '').toMatch(/257 characters.*limit is 256.*journal's/);
    await expect(cycle('😀'.repeat(256))).resolves.toMatchObject({ row: null });
  });

  it('a 256-character text id writes, replays and verifies end to end', async () => {
    const id = 'b'.repeat(256);
    orThrow(await journal.write(db, long, id, { meta, events: () => [Opened({})] }));
    const replayed = orThrow(await journal.replay(db, long, id));
    expect(replayed.events.map(e => e.version)).toEqual([1]);
    expect(await journal.verify(db, long, id)).toEqual({ ok: true });
  });

  it('an empty id is refused, because it names no entity', async () => {
    await expect(cycle('').catch(code)).resolves.toBe('ID_MISMATCH');
    await expect(journal.verify(db, long, '').catch(code)).resolves.toBe('ID_MISMATCH');
  });

  it('an id with an unpaired surrogate is refused by write, replay, verify and repair, because the driver would store it as U+FFFD and reach the history of another id', async () => {
    const broken = 'x\uD800';
    const lookalike = 'x\uFFFD';
    orThrow(await journal.write(db, long, lookalike, { meta, events: () => [Opened({})] }));
    await expect(cycle(broken).catch(code)).resolves.toBe('ID_MISMATCH');
    await expect(journal.replay(db, long, broken).catch(code)).resolves.toBe('ID_MISMATCH');
    await expect(journal.verify(db, long, broken).catch(code)).resolves.toBe('ID_MISMATCH');
    await expect(journal.repair(db, long, broken).catch(code)).resolves.toBe('ID_MISMATCH');
    const error = await cycle(broken).catch((error_: unknown) => error_);
    expect(error instanceof Error ? error.message : '').toMatch(/unpaired surrogate/);
    const logged = await eventsFor(lookalike);
    expect(logged.map(e => e.version)).toEqual([1]);
  });

  it('a well-formed astral character (an emoji, two UTF-16 units) in an id still writes, replays and verifies', async () => {
    const id = 'smile-😀';
    orThrow(await journal.write(db, long, id, { meta, events: () => [Opened({})] }));
    const replayed = orThrow(await journal.replay(db, long, id));
    expect(replayed.events.map(e => e.version)).toEqual([1]);
    expect(await journal.verify(db, long, id)).toEqual({ ok: true });
  });
});

describe('the events insert read-back', () => {
  // Why: a database or driver could store another entity_id than the one passed. Returned events
  // carry the id the caller passed, so only comparing the stored value reveals the change.
  const Opened = j.event('NoteOpened', z.object({}));
  const notes = pgTable('notes', { id: text('id').primaryKey(), version: integer('version').notNull() });
  const note = j.entity('note', notes).create(Opened, () => ({}));

  beforeAll(async () => {
    await client.exec('create table notes (id text primary key, version integer not null)');
  });

  it('a returned entityId that differs from the id passed is refused and nothing is committed', async () => {
    const result = await db
      .transaction(tx => journal.write(changing(tx), note, 'n1', { meta, events: () => [Opened({})] }))
      .catch(code);
    expect(result).toBe('ID_MISMATCH');
    expect(await eventsFor('n1')).toEqual([]);
    expect(await db.select().from(notes)).toEqual([]);
  });
});

// An array of length 1 with no element at index 0. JSON storage turns it into [null].
function arrayWithHole(): unknown[] {
  const hole: unknown[] = [];
  hole.length = 1;
  return hole;
}

function valueFor(kind: string): unknown {
  if (kind === 'hole') return arrayWithHole();
  if (kind === 'map') return new Map([['item', 9]]);
  if (kind === 'set') return new Set([1]);
  if (kind === 'dense') return [1, null, 'a'];
  return { a: [1, { b: true }], c: null };
}

describe('values the database stores', () => {
  // Why: replay recomputes the row from reducer output. If the database rounds or trims a value,
  // the next reducer reads the stored form while replay folds the unrounded one, and repair would
  // silently change a correct balance. So the write refuses a value the database would alter.
  const Opened = j.event('PurseOpened', z.object({ amount: z.string() }));
  const Doubled = j.event('PurseDoubled', z.object({}));
  const Scaled = j.event('PurseScaled', z.object({ amount: z.string() }));
  const Noted = j.event('PurseNoted', z.object({ note: z.string() }));
  const Tagged = j.event('PurseTagged', z.object({}));
  const Stamped = j.event('PurseStamped', z.object({}));
  const stampedAt = new Date('2026-01-02T03:04:05.678Z');
  const purses = pgTable('purses', {
    id: text('id').primaryKey(),
    amount: numeric('amount', { precision: 10, scale: 2 }),
    note: text('note'),
    tags: jsonb('tags').$type<Record<string, number>>(),
    stampedAt: timestamp('stamped_at'),
    version: integer('version').notNull().default(0),
  });
  const purse = j
    .entity('purse', purses)
    .create(Opened, e => ({ amount: e.data.amount }))
    .on(Doubled, row => ({ amount: String(Number(row.amount) * 2) }))
    .on(Scaled, (_row, e) => ({ amount: e.data.amount }))
    .on(Noted, (_row, e) => ({ note: e.data.note }))
    .on(Tagged, () => ({ tags: { bb: 1, a: 2 } }))
    .on(Stamped, () => ({ stampedAt }));
  // The same entity with a create reducer that adds a digit the column cannot keep.
  const sloppy = j
    .entity('purse', purses)
    .create(Opened, e => ({ amount: `${e.data.amount}4` }))
    .on(Doubled, row => ({ amount: String(Number(row.amount) * 2) }));
  const open = (id: string, amount: string) =>
    journal.write(db, purse, id, { meta, events: () => [Opened({ amount })] });
  const apply = (id: string, ...events: (ReturnType<typeof Doubled> | ReturnType<typeof Noted>)[]) =>
    journal.write(db, purse, id, { meta, events: () => events });
  const rows = (id: string) => db.select().from(purses).where(eq(purses.id, id));

  beforeAll(async () => {
    await client.exec(
      'create table purses (id text primary key, amount numeric(10,2), note text, tags jsonb, stamped_at timestamp, version integer not null default 0)',
    );
  });

  it('a create whose amount "1.234" the numeric(10,2) column would round is refused, naming the column and both values, and leaves no event or row', async () => {
    const id = 'p-round';
    const error = await open(id, '1.234').catch((error_: unknown) => error_);
    expect(code(error)).toBe('VALUE_MISMATCH');
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('purse');
    expect(message).toContain(id);
    expect(message).toContain('"amount"');
    expect(message).toContain('"1.234"');
    expect(message).toContain('"1.23"');
    expect(await eventsFor(id)).toEqual([]);
    expect(await rows(id)).toEqual([]);
  });

  it('a create with "1.23" and a later doubling to "2.46" write, and replay and verify agree with the table', async () => {
    const id = 'p-ok';
    orThrow(await open(id, '1.23'));
    const doubled = orThrow(await apply(id, Doubled({})));
    expect(doubled.row).toMatchObject({ amount: '2.46', version: 2 });
    const replayed = orThrow(await journal.replay(db, purse, id));
    expect(replayed.row).toMatchObject({ amount: '2.46', version: 2 });
    expect(await journal.verify(db, purse, id)).toEqual({ ok: true });
  });

  it('an update whose patch sets a rounded column is refused and rolls back, because that patch is what replay will fold', async () => {
    const id = 'p-update';
    orThrow(await open(id, '1.23'));
    const error = await journal
      .write(db, purse, id, { meta, events: () => [Scaled({ amount: '5.678' })] })
      .catch((error_: unknown) => error_);
    expect(code(error)).toBe('VALUE_MISMATCH');
    expect(error instanceof Error ? error.message : '').toContain('"5.68"');
    const logged = await eventsFor(id);
    expect(logged.map(e => e.version)).toEqual([1]);
    expect(await rows(id)).toEqual([expect.objectContaining({ amount: '1.23', version: 1 })]);
  });

  it('an update that sets another column succeeds, because only columns set in this write are compared', async () => {
    const id = 'p-untouched';
    orThrow(await open(id, '1.23'));
    const noted = orThrow(await apply(id, Noted({ note: 'rent' })));
    expect(noted.row).toMatchObject({ amount: '1.23', note: 'rent', version: 2 });
    expect(await journal.verify(db, purse, id)).toEqual({ ok: true });
  });

  it('a jsonb object that comes back with its keys in another order is not a mismatch, because the database does not keep key order', async () => {
    const id = 'p-json';
    orThrow(await open(id, '1.00'));
    const tagged = orThrow(await journal.write(db, purse, id, { meta, events: () => [Tagged({})] }));
    expect(tagged.row?.tags).toEqual({ a: 2, bb: 1 });
    expect(await journal.verify(db, purse, id)).toEqual({ ok: true });
  });

  it('a timestamp given a Date with milliseconds is not a mismatch, because the default precision keeps them', async () => {
    const id = 'p-stamp';
    orThrow(await open(id, '1.00'));
    const stamped = orThrow(await journal.write(db, purse, id, { meta, events: () => [Stamped({})] }));
    expect(stamped.row?.stampedAt?.getTime()).toBe(stampedAt.getTime());
    expect(await journal.verify(db, purse, id)).toEqual({ ok: true });
  });

  it('repair refuses a replay the database would round and leaves the row as it was, so it cannot change a correct balance', async () => {
    const id = 'p-repair';
    orThrow(await open(id, '1.23'));
    const error = await journal.repair(db, sloppy, id).catch((error_: unknown) => error_);
    expect(code(error)).toBe('VALUE_MISMATCH');
    expect(error instanceof Error ? error.message : '').toContain('"1.234"');
    expect(await rows(id)).toEqual([expect.objectContaining({ amount: '1.23', version: 1 })]);
    expect(await journal.repair(db, purse, id)).toMatchObject({ amount: '1.23', version: 1 });
  });

  describe('a json column', () => {
    // Why: JSON storage turns a hole into null and a Map or Set into {}. The check must call that lost data.
    const Stored = j.event('BlobStored', z.object({ kind: z.string() }));
    const Loose = j.event('BlobLoose', z.unknown());
    const blobs = pgTable('blobs', {
      id: text('id').primaryKey(),
      payload: jsonb('payload').$type<unknown>(),
      version: integer('version').notNull().default(0),
    });
    const blob = j
      .entity('blob', blobs)
      .create(Stored, e => ({ payload: valueFor(e.data.kind) }))
      .on(Loose, (_row, e) => ({ payload: e.data }));
    const store = (id: string, kind: string) => journal.write(db, blob, id, { meta, events: () => [Stored({ kind })] });
    const blobRows = (id: string) => db.select().from(blobs).where(eq(blobs.id, id));

    beforeAll(async () => {
      await client.exec('create table blobs (id text primary key, payload jsonb, version integer not null default 0)');
    });

    it.each(['hole', 'map', 'set'])(
      'a reducer that returns a %s is refused with VALUE_MISMATCH and writes nothing',
      async kind => {
        const id = `b-${kind}`;
        const error = await store(id, kind).catch((error_: unknown) => error_);
        expect(code(error)).toBe('VALUE_MISMATCH');
        expect(await eventsFor(id)).toEqual([]);
        expect(await blobRows(id)).toEqual([]);
      },
    );

    it.each(['dense', 'nested'])('a %s value still passes, and verify returns ok', async kind => {
      const id = `b-${kind}`;
      orThrow(await store(id, kind));
      expect(await journal.verify(db, blob, id)).toEqual({ ok: true });
    });

    it('an event built with z.unknown() that holds an array with a hole is refused with UNSTABLE_SCHEMA', async () => {
      const id = 'b-event-hole';
      orThrow(await store(id, 'dense'));
      const error = await journal
        .write(db, blob, id, { meta, events: () => [Loose(arrayWithHole())] })
        .catch((error_: unknown) => error_);
      expect(code(error)).toBe('UNSTABLE_SCHEMA');
      const logged = await eventsFor(id);
      expect(logged.map(e => e.version)).toEqual([1]);
    });
  });
});

describe('names the journal stores', () => {
  const named = pgTable('named', { id: text('id').primaryKey(), version: integer('version').notNull().default(0) });
  const Seen = j.event('NamedSeen', z.object({}));
  const entityOf = (kind: string) => j.entity(kind, named);

  it('an entity kind with an unpaired surrogate is refused at definition', () => {
    expect(() => entityOf('kind\uD800')).toThrow(/entity kind/);
    expect(() => entityOf('kind\uDC00x')).toThrow(/entity kind/);
  });

  it('an entity kind of 65 characters is refused and one of 64 is accepted', () => {
    expect(() => entityOf('k'.repeat(65))).toThrow(/entity kind.*64/);
    expect(() => entityOf('k'.repeat(64))).not.toThrow();
  });

  it('an empty entity kind is refused', () => {
    expect(() => entityOf('')).toThrow(/entity kind.*empty/);
  });

  it('an event type of 129 characters is refused and one of 128 is accepted', () => {
    expect(() => j.event('e'.repeat(129), z.object({}))).toThrow(/event type.*128/);
    expect(() => j.event('e'.repeat(128), z.object({}))).not.toThrow();
  });

  it('an empty effect name is refused and an effect name over 128 is refused', () => {
    const entity = entityOf('named').create(Seen, () => ({}));
    expect(() => j.effect('', entity, {})).toThrow(/effect name.*empty/);
    expect(() => j.effect('f'.repeat(129), entity, {})).toThrow(/effect name.*128/);
  });

  it('ordinary names, including one with an emoji, are accepted', () => {
    expect(() => entityOf('order-line')).not.toThrow();
    expect(() => entityOf('pizza\u{1F355}')).not.toThrow();
    expect(() => j.event('Order\u{1F355}Placed', z.object({}))).not.toThrow();
    expect(() => j.effect('mail-\u{1F4E7}', entityOf('named'), {})).not.toThrow();
  });
});

describe('value objects in custom columns', () => {
  // Why: apps hold dates as Temporal values (`Instant`, `PlainDate`) through custom columns whose
  // driver rebuilds the same class on read. The write check must accept a value that round-trips
  // exactly, and still refuse one the database altered. `Amount` stands in for any such class.
  class Amount {
    constructor(readonly text: string) {}
    equals(other: unknown): boolean {
      return other instanceof Amount && other.text === this.text;
    }
  }
  const amount = customType<{ data: Amount; driverData: string }>({
    dataType: () => 'numeric(10,2)',
    toDriver: value => value.text,
    fromDriver: text => new Amount(text),
  });
  const Funded = j.event('TillFunded', z.object({ amount: z.string() }));
  const tills = pgTable('tills', {
    id: text('id').primaryKey(),
    balance: amount('balance'),
    version: integer('version').notNull().default(0),
  });
  const till = j.entity('till', tills).create(Funded, e => ({ balance: new Amount(e.data.amount) }));
  const fund = (id: string, value: string) =>
    journal.write(db, till, id, { meta, events: () => [Funded({ amount: value })] });

  beforeAll(async () => {
    await client.exec(
      'create table tills (id text primary key, balance numeric(10,2), version integer not null default 0)',
    );
  });

  it('a value the column keeps exactly writes, and replay and verify agree, because equal instances compare by equals', async () => {
    const id = 't-exact';
    const written = orThrow(await fund(id, '1.23'));
    expect(written.row?.balance).toEqual(new Amount('1.23'));
    expect(await journal.verify(db, till, id)).toEqual({ ok: true });
  });

  it('a value the column would round is refused, because equals sees the stored value differ', async () => {
    const id = 't-round';
    const error = await fund(id, '1.234').catch((error_: unknown) => error_);
    expect(code(error)).toBe('VALUE_MISMATCH');
    expect(await eventsFor(id)).toEqual([]);
  });
});
