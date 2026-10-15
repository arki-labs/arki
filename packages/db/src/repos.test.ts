/**
 * `repos()` — a feature's repositories as one private infra plugin.
 *
 * These tests pin what the builder and the apps rely on: the set is built
 * once per boot and bound to the database the handle names (not "whatever is
 * called db"); `withTx` rebinds to a real Drizzle transaction, nested ones
 * included; `withTx` is reserved; cross-feature readers keep `this`; and
 * tests replace the whole set with fakes that type-check. PGlite throughout.
 */
import { defineApp, rename } from '@arki/dot';
import type { DepsOf } from '@arki/dot/feature';
import { defineFeature } from '@arki/dot/feature';
import type { Provided } from '@arki/dot/plugin';
import { defineRelations, eq, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { Repos } from './dot.js';
import { DB_PLUGIN_ERROR_CODES, db, reader, repos } from './dot.js';
import { initDbRuntimeLocal } from './runtime-local.js';

const notes = pgTable('notes', { id: text('id').primaryKey(), body: text('body').notNull() });
const relations = defineRelations({ notes });

const database = db({ driver: 'pglite', memory: true, relations });
type Db = Provided<typeof database.provides.db>;
/** The app's transaction type, read off Drizzle — what a real app exports from `db.ts`. */
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
/** What every factory takes: the pool or a transaction. */
type Database = Db | Transaction;

/** A class repository: it reads `this.db`, so copying its methods unbound would break it. */
class NoteRepository {
  constructor(private readonly db: Database) {}
  async add(id: string, body: string): Promise<void> {
    await this.db.insert(notes).values({ id, body });
  }
  async get(id: string): Promise<string | null> {
    const [row] = await this.db.select().from(notes).where(eq(notes.id, id));
    return row?.body ?? null;
  }
}

/** A function repository, the other common style. */
const createCountRepository = (database: Database) => ({
  count: async (): Promise<number> => {
    const rows = await database.select().from(notes);
    return rows.length;
  },
});

let built = 0;
const factories = {
  notes: (database: Database) => {
    built += 1;
    return new NoteRepository(database);
  },
  counts: createCountRepository,
};
const repository = repos(database.provides.db, factories);

const base = defineFeature('notes').infra(repository);
type Deps = DepsOf<typeof base>;
const core = base.usecases({
  write:
    ({ repos }: Deps) =>
    (id: string, body: string) =>
      repos.notes.add(id, body),
  read:
    ({ repos }: Deps) =>
    (id: string) =>
      repos.notes.get(id),
  count:
    ({ repos }: Deps) =>
    () =>
      repos.counts.count(),
});
const feature = core.provides({ noteReader: ({ repos }) => reader(repos.notes, ['get']) }).entrypoints();

const createTable = (handle: Db) => handle.execute(sql`create table notes (id text primary key, body text not null)`);

async function bootNotes(f: typeof feature = feature) {
  const app = await defineApp('notes-app').infra(database).features([f]).start();
  await createTable(app.services.db);
  return app;
}

describe('repos(): boot and wiring', () => {
  it('is private to the feature (`notes.repos`) and dot explain draws feature → notes/repos → db', () => {
    const configured = defineApp('wiring').infra(database).features([feature]).configure();
    const byName = new Map(configured.manifest.plugins.map(p => [p.name, p]));
    expect(byName.get('notes/repos')?.provides).toEqual(['notes.repos']);
    expect(byName.get('notes/repos')?.dependencies).toEqual(['db']);
    expect(byName.get('notes')?.dependencies).toContain('notes.repos');
  });

  it('builds each repository once per boot, not per call', async () => {
    built = 0;
    const app = await bootNotes();
    try {
      const usecases = app.services['notes.usecases'];
      await usecases.write('n1', 'one');
      await usecases.write('n2', 'two');
      expect(await usecases.read('n1')).toBe('one');
      expect(await usecases.count()).toBe(2);
      expect(built).toBe(1);
    } finally {
      await app.dispose();
    }
  });

  it('binds to the database the handle names — a second database is never picked by accident', async () => {
    const reports = rename(db({ driver: 'pglite', memory: true, relations }), { db: 'reportsDb' }, 'reports-db');
    const reportRepos = repos(reports.provides.reportsDb, { counts: createCountRepository });
    const statsBase = defineFeature('stats').infra(reportRepos);
    const stats = statsBase
      .usecases({ count: ({ repos }: DepsOf<typeof statsBase>) => () => repos.counts.count() })
      .entrypoints();
    const app = await defineApp('two-dbs').infra(database, reports).features([stats]).start();
    try {
      await createTable(app.services.db);
      await createTable(app.services.reportsDb);
      await app.services.reportsDb.insert(notes).values({ id: 'r1', body: 'report' });
      // The primary database is empty; only the reports database has a row.
      expect(await app.services['stats.usecases'].count()).toBe(1);
    } finally {
      await app.dispose();
    }
  });

  it('refuses a database the factories do not take, and factories that disagree', () => {
    const vectors = repos(database.provides.db, { a: (handle: Database) => ({ handle }) });
    expectTypeOf(vectors.provides.repos).not.toBeNever();
    // @ts-expect-error the handle's database is not `Db & { vector: true }`
    repos(database.provides.db, { a: (handle: Db & { readonly vector: true }) => ({ handle }) });
    // @ts-expect-error `b` wants a stricter database than `a`
    repos(database.provides.db, { a: (handle: Database) => ({ handle }), b: (handle: Db & { vector: true }) => ({ handle }) });
  });

  it('reserves withTx, at compile time and at runtime', () => {
    const withTx = (handle: Database) => ({ handle });
    // @ts-expect-error withTx is the rebinding helper, not a repository name
    expect(() => repos(database.provides.db, { withTx })).toThrow(
      expect.objectContaining({ code: DB_PLUGIN_ERROR_CODES.reservedRepoName }),
    );
  });
});

describe('repos(): transactions', () => {
  it('withTx(tx) writes inside the transaction: a rollback undoes them', async () => {
    const app = await bootNotes();
    try {
      const set = app.services['notes.repos'];
      await expect(
        app.services.db.transaction(async tx => {
          const inTx = set.withTx(tx);
          await inTx.notes.add('t1', 'inside');
          // Visible inside the transaction…
          expect(await inTx.notes.get('t1')).toBe('inside');
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      // …and gone after the rollback.
      expect(await set.notes.get('t1')).toBeNull();
    } finally {
      await app.dispose();
    }
  });

  it('nested: rebind the original set to the inner tx; an inner rollback keeps the outer writes', async () => {
    const app = await bootNotes();
    try {
      const set = app.services['notes.repos'];
      await app.services.db.transaction(async outer => {
        await set.withTx(outer).notes.add('outer', 'kept');
        await expect(
          outer.transaction(async inner => {
            await set.withTx(inner).notes.add('inner', 'dropped');
            throw new Error('inner only');
          }),
        ).rejects.toThrow('inner only');
      });
      expect(await set.notes.get('outer')).toBe('kept');
      expect(await set.notes.get('inner')).toBeNull();
    } finally {
      await app.dispose();
    }
  });

  it('allocates a fresh set per withTx call (so call it once per transaction)', async () => {
    const app = await bootNotes();
    try {
      const set = app.services['notes.repos'];
      await app.services.db.transaction(async tx => {
        expect(set.withTx(tx)).not.toBe(set.withTx(tx));
        expect('withTx' in set.withTx(tx)).toBe(false);
      });
    } finally {
      await app.dispose();
    }
  });
});

describe('reader(): cross-feature reads', () => {
  it('publishes bound methods, so a class repository keeps its this.db', async () => {
    const app = await bootNotes();
    try {
      await app.services['notes.usecases'].write('x', 'shared');
      const { get } = app.services.noteReader;
      expect(await get('x')).toBe('shared');
      // The trap reader() avoids: an unbound copy loses `this`.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- the trap under test: the copy loses `this`
      const unbound = { get: app.services['notes.repos'].notes.get };
      await expect(unbound.get('x')).rejects.toThrow(TypeError);
      expectTypeOf(app.services.noteReader).toEqualTypeOf<Pick<NoteRepository, 'get'>>();
    } finally {
      await app.dispose();
    }
  });

  it('accepts method names only', () => {
    const repo = { label: 'notes', get: () => 'row' };
    // @ts-expect-error `label` is a value, not a method
    expect(() => reader(repo, ['label'])).toThrow(
      expect.objectContaining({ code: DB_PLUGIN_ERROR_CODES.readerNotAMethod }),
    );
  });
});

describe('repos(): test fakes that type-check', () => {
  it('override takes the whole set — a half-faked set does not compile', () => {
    // @ts-expect-error `notes` and `withTx` are missing: replace the set, not one repository
    feature.override({ repos: { counts: { count: async () => 1 } } });
  });

  it('pattern 1: real instances with spies — the class keeps its private fields, so the type fits', async () => {
    const app = await bootNotes();
    try {
      const real = app.services['notes.repos'];
      const get = vi.spyOn(real.notes, 'get').mockResolvedValue('stubbed');
      expect(await app.services['notes.usecases'].read('anything')).toBe('stubbed');
      expect(get).toHaveBeenCalledWith('anything');
    } finally {
      await app.dispose();
    }
  });

  it('pattern 2: a full fixture whose unused methods throw, swapped in before boot', async () => {
    const unused = async (): Promise<never> => {
      throw new Error('not used by this test');
    };
    // The fake never queries; it only needs a real handle to construct.
    const { db: handle, pglite } = await initDbRuntimeLocal({ memory: true }, { relations });
    // `NoteRepository` has a private field, so an object literal cannot pose as it;
    // a subclass that overrides every method can, and keeps the type exact.
    class FakeNotes extends NoteRepository {
      override add = unused;
      override get = async (id: string) => `fake ${id}`;
    }
    const fakeSet: RepoSetOf = { notes: new FakeNotes(handle), counts: { count: async () => 42 } };
    const fakeRepos: Repos<typeof factories> = { ...fakeSet, withTx: () => fakeSet };
    const app = await defineApp('faked').infra(database).features([feature.override({ repos: fakeRepos })]).start();
    try {
      expect(await app.services['notes.usecases'].read('n')).toBe('fake n');
      expect(await app.services['notes.usecases'].count()).toBe(42);
      await expect(app.services['notes.usecases'].write('n', 'b')).rejects.toThrow('not used by this test');
    } finally {
      await app.dispose();
      await pglite.close();
    }
  });
});

type RepoSetOf = ReturnType<Repos<typeof factories>['withTx']>;
