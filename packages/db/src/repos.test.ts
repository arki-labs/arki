/**
 * `repos()` — a feature's repositories as one private infra plugin.
 *
 * These tests pin what the builder and the apps rely on: the set is built
 * once per boot and bound to the database the feature names in `.needs()`
 * (not "whatever is called db"); `withTx` rebinds to a real Drizzle
 * transaction, nested ones included; `withTx` is reserved; cross-feature
 * readers keep `this`; `txRepos` publishes `withTx` only; and tests replace
 * the whole set with fakes that type-check. PGlite throughout.
 */
import { defineRelations, eq, sql } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { DepsOf } from '@arki/dot/feature';
import type { Provided } from '@arki/dot/plugin';
import { defineApp, rename } from '@arki/dot';
import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { orThrow } from '@arki/failure';

import type { Repos, TxRepos } from './dot.js';
import { db, DB_PLUGIN_ERROR_CODES, reader, repos, txRepos } from './dot.js';
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
const repository = repos(factories);

const base = defineFeature('notes').needs({ db: database.provides.db }).infra(repository);
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
  const app = await orThrow(defineApp('notes-app').infra(database).features([f]).start());
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
      await orThrow(app.dispose());
    }
  });

  it('binds to the database the feature needs — a second database is never picked by accident', async () => {
    const reports = rename(db({ driver: 'pglite', memory: true, relations }), { db: 'reportsDb' }, 'reports-db');
    const reportRepos = repos({ counts: createCountRepository });
    const statsBase = defineFeature('stats').needs({ db: reports.provides.reportsDb }).infra(reportRepos);
    const stats = statsBase
      .usecases({
        count:
          ({ repos }: DepsOf<typeof statsBase>) =>
          () =>
            repos.counts.count(),
      })
      .entrypoints();
    const app = await orThrow(defineApp('two-dbs').infra(database, reports).features([stats]).start());
    try {
      await createTable(app.services.db);
      await createTable(app.services.reportsDb);
      await app.services.reportsDb.insert(notes).values({ id: 'r1', body: 'report' });
      // The primary database is empty; only the reports database has a row.
      expect(await app.services['stats.usecases'].count()).toBe(1);
    } finally {
      await orThrow(app.dispose());
    }
  });

  it('refuses a feature whose db the factories do not take, and factories that disagree', () => {
    const vectors = repos({ a: (handle: Db & { readonly vector: true }) => ({ handle }) });
    expectTypeOf(vectors.provides.repos).not.toBeNever();
    // @ts-expect-error the feature's db is not `Db & { vector: true }`
    defineFeature('vectors').needs({ db: database.provides.db }).infra(vectors);
    // @ts-expect-error a feature with no `db` cannot host the store — and the same refusal at runtime
    expect(() => defineFeature('bare').infra(repository)).toThrow(/needs "db", which the feature does not declare/);
    // @ts-expect-error `b` wants a stricter database than `a`
    repos({ a: (handle: Database) => ({ handle }), b: (handle: Db & { vector: true }) => ({ handle }) });
  });

  it('reserves withTx, at compile time and at runtime', () => {
    const withTx = (handle: Database) => ({ handle });
    // @ts-expect-error withTx is the rebinding helper, not a repository name
    expect(() => repos({ withTx })).toThrow(expect.objectContaining({ code: DB_PLUGIN_ERROR_CODES.reservedRepoName }));
    // @ts-expect-error same rule for the transaction-only store
    expect(() => txRepos({ withTx })).toThrow(
      expect.objectContaining({ code: DB_PLUGIN_ERROR_CODES.reservedRepoName }),
    );
  });
});

describe('txRepos(): repositories only inside a transaction', () => {
  const store = txRepos(factories);
  const scopedBase = defineFeature('ledger')
    .needs({ db: entrypointOnly(database.provides.db) })
    .infra(store);
  type ScopedDeps = DepsOf<typeof scopedBase>;
  const ledger = scopedBase
    .usecases({
      write:
        ({ repos }: ScopedDeps) =>
        (tx: Transaction, id: string, body: string) =>
          repos.withTx(tx).notes.add(id, body),
      count:
        ({ repos }: ScopedDeps) =>
        (tx: Transaction) =>
          repos.withTx(tx).counts.count(),
    })
    .entrypoints();

  it('publishes withTx and nothing else; usecases never see the db', () => {
    expectTypeOf<Provided<typeof store.provides.repos>>().toEqualTypeOf<TxRepos<typeof factories>>();
    scopedBase.usecases({
      bad:
        ({ repos }: ScopedDeps) =>
        () =>
          // @ts-expect-error no database-bound set: `repos.notes` does not exist
          repos.notes,
    });
    // @ts-expect-error `db` is entrypoint-only: a usecase cannot open its own transaction
    scopedBase.usecases({
      bad:
        ({ db }: { db: Db }) =>
        () =>
          db,
    });
    expectTypeOf<keyof ScopedDeps>().toEqualTypeOf<'repos'>();
  });

  it('a rollback undoes the writes made through withTx(tx)', async () => {
    const app = await orThrow(defineApp('ledger-app').infra(database).features([ledger]).start());
    try {
      await createTable(app.services.db);
      const usecases = app.services['ledger.usecases'];
      const set = app.services['ledger.repos'];
      expect(Object.keys(set)).toEqual(['withTx']);
      await expect(
        app.services.db.transaction(async tx => {
          await usecases.write(tx, 'l1', 'inside');
          expect(await usecases.count(tx)).toBe(1);
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      expect(await app.services.db.transaction(tx => usecases.count(tx))).toBe(0);
    } finally {
      await orThrow(app.dispose());
    }
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
      await orThrow(app.dispose());
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
      await orThrow(app.dispose());
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
      await orThrow(app.dispose());
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
      await orThrow(app.dispose());
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
      await orThrow(app.dispose());
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
    const app = await orThrow(
      defineApp('faked')
        .infra(database)
        .features([feature.override({ repos: fakeRepos })])
        .start(),
    );
    try {
      expect(await app.services['notes.usecases'].read('n')).toBe('fake n');
      expect(await app.services['notes.usecases'].count()).toBe(42);
      await expect(app.services['notes.usecases'].write('n', 'b')).rejects.toThrow('not used by this test');
    } finally {
      await orThrow(app.dispose());
      await pglite.close();
    }
  });
});

type RepoSetOf = ReturnType<Repos<typeof factories>['withTx']>;
