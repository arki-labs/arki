// Speed of @arki/db: ID creation and PGlite queries through the runtime-local handle.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// IDs are random, so the contract is their shape (prefix, length, alphabet),
// never their value. Query rows use one in-memory PGlite for the whole suite.

import { randomUUID } from 'node:crypto';
import { createId as cuid2 } from '@paralleldrive/cuid2';
import { asc, eq } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { nanoid } from 'nanoid';
import { v7 as uuidv7 } from 'uuid';

import { compare, defineSuite, scenario } from '@arki/bench';
import { orThrow } from '@arki/failure';
import { createIdFactory, createPrefixedId } from '@arki/db/id';
import { defineRelations } from '@arki/db/orm';
import { initDbRuntimeLocal } from '@arki/db/runtime-local';

const userId = createIdFactory('usr_');

/** Describes the shape of an id: prefix, length and which characters it uses. */
function idShape(id: string): string {
  const prefix = id.startsWith('usr_') ? 'usr_' : 'none';
  const rest = prefix === 'usr_' ? id.slice(4) : id;
  const alphabet = /^[a-z][a-z0-9]*$/.test(rest) ? 'a-z0-9 (starts with a letter)' : 'other';
  return `prefix=${prefix} len=${id.length} alphabet=${alphabet}`;
}

// cuid2 makes 24 characters; with `usr_` in front that is 28.
const PREFIXED_CUID2 = 'prefix=usr_ len=28 alphabet=a-z0-9 (starts with a letter)';

// One table definition for both handles, so the id default is the same on both sides.
const readItems = pgTable('read_items', { id: userId.primaryColumn(), name: text('name').notNull() });
const writeItems = pgTable('write_items', { id: userId.primaryColumn(), name: text('name').notNull() });

const SEED_COUNT = 50;
const seedId = (index: number): `usr_${string}` => `usr_seed${String(index).padStart(3, '0')}`;
const seedName = (index: number): string => `item ${index}`;
const seedRows = Array.from({ length: SEED_COUNT }, (_, index) => ({
  id: seedId(index),
  name: seedName(index),
}));

/** One PGlite for every case in every group. Created on first use, not at import. */
const sharedEnvironment = (() => {
  let pending: ReturnType<typeof createEnvironment> | undefined;
  return () => (pending ??= createEnvironment());
})();

async function createEnvironment() {
  const { db, pglite } = await initDbRuntimeLocal(
    { memory: true },
    { relations: defineRelations({ readItems, writeItems }) },
  );
  await pglite.exec(`
    create table read_items (id varchar(256) primary key, name text not null);
    create table write_items (id varchar(256) primary key, name text not null);
  `);
  const rawDb = drizzle({ client: pglite });
  await rawDb.insert(readItems).values(seedRows);
  return { db, rawDb };
}

type Row = { id: string; name: string };
const readRows = (rows: readonly Row[]): string => JSON.stringify(rows.map(({ id, name }) => ({ id, name })));
const readOne = (row: Row | undefined): string => JSON.stringify(row ? { id: row.id, name: row.name } : null);
/** An inserted row has a random id: keep the name and the id's shape. */
const insertedRows = (rows: readonly Row[]): string =>
  JSON.stringify(rows.map(row => ({ name: row.name, id: idShape(row.id) })));

const findIds: readonly `usr_${string}`[] = [seedId(0), seedId(7), seedId(49), 'usr_missing'];
const findExpected = (id: `usr_${string}`): string => {
  const index = findIds.indexOf(id);
  return JSON.stringify(index !== -1 && index < 3 ? { id, name: seedName(Number(id.slice(-3))) } : null);
};

export default defineSuite({
  id: '@arki/db',
  intro:
    'ID creation in `@arki/db`, and in-memory PGlite queries through the `@arki/db` handle (`initDbRuntimeLocal`) against raw Drizzle on the same PGlite instance.',
  notes: [
    '`@arki/db` has no repository class. It supplies the prefixed ID factory (secure randomness with a typed prefix, plus a validated column) and the PGlite runtime. The query tables compare the `@arki/db` handle with a plain `drizzle()` on the same PGlite and the same table, so the difference is only the handle.',
    'IDs are random. The ID table compares their shape, not their value. nanoid, uuid v7 and `randomUUID()` return another shape, so they appear in a separate table without ranking.',
    'The insert table writes to a table that grows during the run; compare its rows with each other only.',
  ],
  groups: [
    compare<number>({
      id: 'prefixed-id',
      title: 'Create one prefixed ID',
      contract: {
        id: 'db-prefixed-id/v1',
        description:
          'a string of shape `usr_` followed by 24 lowercase base-36 characters (28 in all, starting with a letter after the prefix)',
      },
      // The input only varies the call; the id is random each time.
      inputs: [0, 1, 2, 3],
      expected: () => PREFIXED_CUID2,
      baseline: 'factory',
      cases: c => ({
        factory: c({
          label: '@arki/db createIdFactory("usr_").create()',
          package: '@arki/db',
          setup: index => index,
          // The benchmark requires a successful scalar; fail the run if entropy is unavailable.
          run: () => orThrow(userId.create()),
          normalize: idShape,
        }),
        prefixed: c({
          label: '@arki/db createPrefixedId("usr_")',
          package: '@arki/db',
          variant: true,
          setup: index => index,
          // The benchmark requires a successful scalar; fail the run if entropy is unavailable.
          run: () => orThrow(createPrefixedId('usr_')),
          normalize: idShape,
        }),
        cuid2: c({
          label: '@paralleldrive/cuid2 createId + manual prefix',
          package: '@paralleldrive/cuid2',
          setup: index => index,
          run: () => `usr_${cuid2()}`,
          normalize: idShape,
        }),
      }),
    }),
    scenario({
      kind: 'scenario',
      id: 'random-id',
      title: 'Create one random ID of any shape',
      note: 'Different shapes and lengths: shown side by side, not ranked. uuid v7 is time-ordered; randomUUID is v4.',
      cases: {
        arki: { label: '@arki/db createIdFactory("usr_").create()', package: '@arki/db', run: () => orThrow(userId.create()) },
        cuid2: {
          label: '@paralleldrive/cuid2 createId (no prefix)',
          package: '@paralleldrive/cuid2',
          run: () => cuid2(),
        },
        nanoid: { label: 'nanoid', package: 'nanoid', run: () => nanoid() },
        uuidv7: { label: 'uuid v7', package: 'uuid', run: () => uuidv7() },
        randomUuid: { label: 'crypto.randomUUID()', run: () => randomUUID() },
      },
    }),
    compare<string>({
      id: 'insert-row',
      title: 'Insert one row (PGlite, in memory)',
      contract: {
        id: 'db-insert-returning/v1',
        description:
          'a single inserted row, with its name and an id of shape `usr_` + cuid2 (compared by shape, the id is random)',
      },
      inputs: ['alpha', 'beta', 'gamma', 'δέλτα'],
      expected: name => JSON.stringify([{ name, id: PREFIXED_CUID2 }]),
      mode: 'async',
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/db handle',
          package: '@arki/db',
          setup: name => ({ environment: sharedEnvironment(), name }),
          run: async ({ environment, name }) => {
            const { db } = await environment;
            return db.insert(writeItems).values({ name }).returning();
          },
          normalize: insertedRows,
        }),
        raw: c({
          label: 'raw drizzle() on the same PGlite',
          package: 'drizzle-orm',
          setup: name => ({ environment: sharedEnvironment(), name }),
          run: async ({ environment, name }) => {
            const { rawDb } = await environment;
            return rawDb.insert(writeItems).values({ name }).returning();
          },
          normalize: insertedRows,
        }),
      }),
    }),
    compare<`usr_${string}`>({
      id: 'find-by-id',
      title: 'Find one row by id',
      contract: {
        id: 'db-find-by-id/v1',
        description:
          'the row with that id as `{ id, name }`, or null when no row has it (3 seeded ids and 1 missing id)',
      },
      inputs: findIds,
      expected: findExpected,
      mode: 'async',
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/db handle, select().where(eq)',
          package: '@arki/db',
          setup: id => ({ environment: sharedEnvironment(), id }),
          run: async ({ environment, id }) => {
            const { db } = await environment;
            return db.select().from(readItems).where(eq(readItems.id, id));
          },
          normalize: rows => readOne(rows[0]),
        }),
        arkiRelational: c({
          label: '@arki/db handle, query.findFirst',
          package: '@arki/db',
          variant: true,
          setup: id => ({ environment: sharedEnvironment(), id }),
          run: async ({ environment, id }) => {
            const { db } = await environment;
            return db.query.readItems.findFirst({ where: { id } });
          },
          normalize: readOne,
        }),
        raw: c({
          label: 'raw drizzle() on the same PGlite, select().where(eq)',
          package: 'drizzle-orm',
          setup: id => ({ environment: sharedEnvironment(), id }),
          run: async ({ environment, id }) => {
            const { rawDb } = await environment;
            return rawDb.select().from(readItems).where(eq(readItems.id, id));
          },
          normalize: rows => readOne(rows[0]),
        }),
      }),
    }),
    compare<number>({
      id: 'list-rows',
      title: 'List the first N rows',
      contract: {
        id: 'db-list-first-n/v1',
        description: 'the first N seeded rows ordered by id, as `[{ id, name }]` (N = 0, 1, 10, 50)',
      },
      inputs: [0, 1, 10, 50],
      expected: count => JSON.stringify(seedRows.slice(0, count)),
      mode: 'async',
      baseline: 'arki',
      cases: c => ({
        arki: c({
          label: '@arki/db handle',
          package: '@arki/db',
          setup: count => ({ environment: sharedEnvironment(), count }),
          run: async ({ environment, count }) => {
            const { db } = await environment;
            return db.select().from(readItems).orderBy(asc(readItems.id)).limit(count);
          },
          normalize: readRows,
        }),
        raw: c({
          label: 'raw drizzle() on the same PGlite',
          package: 'drizzle-orm',
          setup: count => ({ environment: sharedEnvironment(), count }),
          run: async ({ environment, count }) => {
            const { rawDb } = await environment;
            return rawDb.select().from(readItems).orderBy(asc(readItems.id)).limit(count);
          },
          normalize: readRows,
        }),
      }),
    }),
  ],
});
