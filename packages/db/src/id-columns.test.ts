/**
 * `idColumns(defineId('sty_'))`: the browser-safe id declaration from
 * `@arki/contracts` becomes table columns here. The prefix is written once,
 * the default id comes from the declaration, and the contracts select schema
 * checks the prefix at runtime.
 */
import type { PGlite } from '@electric-sql/pglite';
import { defineRelations, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { IdOf } from '@arki/contracts';
import { defineId, RandomSourceUnavailable, z } from '@arki/contracts';
import { createInsertSchema, createSelectSchema, jsonColumn } from '@arki/contracts/drizzle';
import { orThrow, UnexpectedDefect, UnexpectedFailure } from '@arki/failure';

import { createUnitOfWork } from './composition.js';
import { createIdFactory, idColumns } from './id-factory.js';
import { initDbRuntimeLocal } from './runtime-local.js';
import { runTransaction, runTransactionOnce } from './transaction.js';

const storyId = defineId('sty_');
type StoryId = IdOf<typeof storyId>;
const universeId = defineId('univ_');

const story = idColumns(storyId);
const stories = pgTable('stories', {
  id: story.primaryColumn(),
  universeId: idColumns(universeId).reference('universe_id'),
  parentId: story.optionalReference('parent_id'),
  title: text('title').notNull(),
});
const relations = defineRelations({ stories });
const storedProfile = z.object({ age: z.number() });
const profiles = pgTable('profiles', {
  id: integer('id').primaryKey(),
  profile: jsonColumn('profile', storedProfile).notNull(),
});
const generatedRows = pgTable('generated_rows', {
  id: story.primaryColumn(),
  requiredId: story.requiredColumn('required_id'),
});
const generate = vi.fn(storyId.create);
const injected = idColumns({ schema: storyId.schema, create: generate });
const injectedRows = pgTable('injected_rows', {
  id: injected.primaryColumn(),
  requiredId: injected.requiredColumn('required_id'),
});
const legacyId = createIdFactory('legacy:/');
const legacyRows = pgTable('legacy_rows', { id: legacyId.primaryColumn() });
const refundId = defineId('id_', { kind: 'billing.refund' });
const paymentId = defineId('id_', { kind: 'billing.payment' });
const nominalRows = pgTable('nominal_rows', {
  id: idColumns(refundId).primaryColumn(),
  paymentId: idColumns(paymentId).reference('payment_id'),
});

let client: PGlite;
let db: Awaited<ReturnType<typeof initDbRuntimeLocal<typeof relations>>>['db'];

beforeAll(async () => {
  ({ db, pglite: client } = await initDbRuntimeLocal({ memory: true }, { relations }));
  await db.execute(
    sql`create table stories (id varchar(256) primary key, universe_id varchar(256) not null, parent_id varchar(256), title text not null)`,
  );
  await db.execute(sql`create table profiles (id integer primary key, profile jsonb not null)`);
  await db.execute(sql`create table generated_rows (id varchar(256) primary key, required_id varchar(256) not null)`);
  await db.execute(sql`create table injected_rows (id varchar(256) primary key, required_id varchar(256) not null)`);
  await db.execute(sql`create table legacy_rows (id varchar(256) primary key)`);
  await db.execute(sql`create table nominal_rows (id varchar(256) primary key, payment_id varchar(256) not null)`);
});

afterAll(async () => {
  await client.close();
});

describe('idColumns', () => {
  it('keeps same-format domain brands through generated defaults, storage and validated JSON', async () => {
    const payment = paymentId.schema.parse('id_existing_payment');
    const [row] = await db.insert(nominalRows).values({ paymentId: payment }).returning();
    if (!row) throw new Error('Expected inserted row');
    expectTypeOf(row.id).toEqualTypeOf<IdOf<typeof refundId>>();
    expectTypeOf(row.paymentId).toEqualTypeOf<IdOf<typeof paymentId>>();
    expect(row.id).toMatch(/^id_[a-z][a-z0-9]{23}$/);
    expect(row.paymentId).toBe('id_existing_payment');
    const encoded = JSON.stringify(row);
    const wire: unknown = JSON.parse(encoded);
    const schema = createSelectSchema(nominalRows, { id: () => refundId.schema, paymentId: () => paymentId.schema });
    const decoded = schema.parse(wire);
    expectTypeOf(decoded).toEqualTypeOf<typeof row>();
    expect(decoded).toEqual(row);
  });

  it('types every column from the declaration: no `$type<…>` written by hand', () => {
    type Row = typeof stories.$inferSelect;
    expectTypeOf<Row['id']>().toEqualTypeOf<StoryId>();
    expectTypeOf<Row['universeId']>().toEqualTypeOf<`univ_${string}`>();
    expectTypeOf<Row['parentId']>().toEqualTypeOf<StoryId | null>();
  });

  it('the primary column defaults to a fresh id from the declaration', async () => {
    const [row] = await db
      .insert(stories)
      .values({ universeId: orThrow(universeId.create()), title: 'The Lighthouse' })
      .returning();
    expect(row?.id).toMatch(/^sty_[a-z][a-z0-9]{23}$/);
    expect(storyId.is(row?.id)).toBe(true);
  });

  it('both generated column defaults store success-only IDs', async () => {
    const [row] = await db.insert(generatedRows).values({}).returning();
    expect(row?.id).toMatch(/^sty_[a-z][a-z0-9]{23}$/);
    expect(row?.requiredId).toMatch(/^sty_[a-z][a-z0-9]{23}$/);
    expect(row?.id).not.toBe(row?.requiredId);
  });

  it.each(['primary', 'required'] as const)(
    '%s entropy failure rejects the insert without storing a row',
    async column => {
      const before = await db.select().from(generatedRows);
      vi.stubGlobal('crypto', null);
      try {
        const values =
          column === 'primary'
            ? { requiredId: storyId.schema.parse('sty_explicit') }
            : { id: storyId.schema.parse('sty_explicit') };
        const insert = async () => db.insert(generatedRows).values(values).returning();
        await expect(insert()).rejects.toMatchObject({
          name: 'UnexpectedFailure',
          failure: { code: RandomSourceUnavailable.code },
        });
      } finally {
        vi.unstubAllGlobals();
      }
      expect(await db.select().from(generatedRows)).toEqual(before);
    },
  );

  it('the scalar bridge retains the exact producer failure and private cause', async () => {
    const cause = new Error('provider failed');
    const failure = UnexpectedDefect({ cause });
    generate.mockReturnValueOnce(failure);
    let caught: unknown;
    try {
      await db.insert(injectedRows).values({}).returning();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnexpectedFailure);
    if (!(caught instanceof UnexpectedFailure)) throw new Error('Expected the scalar failure bridge');
    expect(caught.failure).toBe(failure);
    expect(caught.cause).toBe(cause);
    expect(await db.select().from(injectedRows)).toEqual([]);
  });

  it.each(['once', 'serializable', 'unit-of-work'] as const)(
    '%s restores bridged ID failures by identity after rollback',
    async mode => {
      const failure = RandomSourceUnavailable();
      generate.mockClear().mockReturnValueOnce(failure);
      const work = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        await tx.insert(profiles).values({ id: 99, profile: { age: 42 } });
        return tx.insert(injectedRows).values({}).returning();
      };
      const outcome =
        mode === 'once'
          ? await runTransactionOnce(db, work)
          : mode === 'serializable'
            ? await runTransaction(db, work)
            : await createUnitOfWork(db, { tx: tx => tx })(scope => work(scope.tx));
      expect(outcome).toBe(failure);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(await db.select().from(injectedRows)).toEqual([]);
      expect(await db.select().from(profiles)).not.toContainEqual({ id: 99, profile: { age: 42 } });
    },
  );

  it('explicit IDs bypass both generated defaults when entropy is unavailable', async () => {
    generate.mockClear();
    vi.stubGlobal('crypto', null);
    try {
      const values = {
        id: storyId.schema.parse('sty_explicit_primary'),
        requiredId: storyId.schema.parse('sty_explicit_required'),
      };
      const [row] = await db.insert(injectedRows).values(values).returning();
      expect(row).toEqual(values);
      expect(generate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('the contracts select schema rejects an id of another kind', () => {
    const select = createSelectSchema(stories);
    const ok = { id: storyId.create(), universeId: universeId.create(), parentId: null, title: 't' };
    expect(select.safeParse(ok).success).toBe(true);
    expect(select.safeParse({ ...ok, universeId: storyId.create() }).success).toBe(false);
  });

  it('wire transforms run once before storage; selecting uses the stable storage schema', async () => {
    const decode = vi.fn(Number);
    const wireProfile = z.object({ age: z.codec(z.string(), storedProfile.shape.age, { decode, encode: String }) });
    const insert = createInsertSchema(profiles, { profile: () => wireProfile });
    const parsed = insert.parse({ id: 1, profile: { age: '42' } });
    expectTypeOf<typeof parsed.profile>().toEqualTypeOf<z.output<typeof storedProfile>>();
    expect(parsed.profile).toEqual({ age: 42 });
    const [row] = await db.insert(profiles).values(parsed).returning();
    expect(row?.profile).toEqual({ age: 42 });
    expect(createSelectSchema(profiles).parse(row).profile).toEqual({ age: 42 });
    expect(decode).toHaveBeenCalledExactlyOnceWith('42', expect.anything());
  });

  it('createIdFactory keeps working for ids declared the old way', () => {
    const poet = createIdFactory('pt_');
    expect(poet.create()).toMatch(/^pt_/);
    expect(poet.make).toBe(poet.create);
    expect(poet.schema.safeParse('xx_1').success).toBe(false);
  });

  it('legacy scalar defaults commit successes and roll back preceding writes on entropy refusal', async () => {
    const committed = await runTransactionOnce(db, tx => tx.insert(legacyRows).values({}).returning());
    expect(committed).toEqual([{ id: expect.stringMatching(/^legacy:\/[a-z][a-z0-9]{23}$/) }]);
    vi.stubGlobal('crypto', null);
    try {
      const refused = await runTransactionOnce(db, async tx => {
        await tx.insert(profiles).values({ id: 101, profile: { age: 42 } });
        return tx.insert(legacyRows).values({}).returning();
      });
      expect(RandomSourceUnavailable.is(refused)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await db.select().from(legacyRows)).toEqual(committed);
    expect(await db.select().from(profiles)).not.toContainEqual({ id: 101, profile: { age: 42 } });
  });
});
