/**
 * Type proof (plan M0.3): `liveRead()` and `snapshot()` compose on a real
 * `defineFeature` → `rpc()` chain, with several output and error schemas and
 * `repos()` readers, and no cast anywhere. `tsc` checks this file
 * (`bun run typecheck`); the runtime tests check what the meta looks like.
 * `@ts-expect-error` appears only in the negative fixtures.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import { count, inArray } from 'drizzle-orm';
import { integer, pgSchema, pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { RepoSet } from '@arki/db/dot';
import type { DepsOf, ServicesBag } from '@arki/dot/feature';
import { repos } from '@arki/db/dot';
import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { needsMiddleware, rpc } from '@arki/dot/orpc';
import { infra } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';

import type { LiveMeta } from '../index.js';
import { live, snapshot, tableTag } from '../drizzle/index.js';
import { liveRead } from '../orpc/index.js';

// ── tables and the app's database types, the way an app declares them ──
const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  authorId: text('author_id').notNull(),
});
const users = pgTable('users', { id: text('id').primaryKey(), name: text('name').notNull() });
const billing = pgSchema('billing');
const invoices = billing.table('invoices', { id: text('id').primaryKey(), cents: integer('cents').notNull() });

type Db = NodePgDatabase;
type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];
type Database = Db | Transaction;

const postRepository = (db: Database) => ({
  page: (page: number) =>
    db
      .select()
      .from(posts)
      .limit(10)
      .offset((page - 1) * 10),
  total: async () => {
    const [row] = await db.select({ total: count() }).from(posts);
    return row?.total ?? 0;
  },
});
const userRepository = (db: Database) => ({
  names: (ids: string[]) => db.select().from(users).where(inArray(users.id, ids)),
});

// ── the app: a database plugin and the request context ──
declare const rootDb: Db;
const database = infra({ name: 'database', provides: { db: (): Db => rootDb } });
type RequestContext = {
  readonly session: { readonly user: { readonly id: string } } | null;
  readonly headers: Headers;
  readonly services: ServicesBag;
};
const bind = needsMiddleware<RequestContext>();

// ── the contract: two live procedures (different outputs and errors) and one write ──
type AppMeta = { readonly auth?: 'public' | 'user' };
const contract = oc.$meta<AppMeta & LiveMeta>({});
const Post = z.object({ id: z.string(), title: z.string(), author: z.string() });
const postsRpcContract = contract.router({
  list: contract
    .meta({ auth: 'public', ...live({ reads: [posts, users] }) })
    .input(z.object({ page: z.int().positive() }))
    .output(z.array(Post))
    .errors({ PAGE_OUT_OF_RANGE: { data: z.object({ last: z.int() }) }, RATE_LIMITED: {} }),
  stats: contract
    .meta(live({ reads: [posts, invoices] }))
    .output(z.object({ posts: z.int(), firstTitle: z.string().nullable() }))
    .errors({ UNAVAILABLE: {} }),
  create: contract.input(z.object({ title: z.string() })).output(Post),
});

// ── the feature chain ──
const store = repos({ posts: postRepository, users: userRepository });
const postsDeps = defineFeature('posts')
  .needs({ db: entrypointOnly(database.provides.db) })
  .infra(store);
type Deps = DepsOf<typeof postsDeps>;
const postsLogic = postsDeps.usecases({
  /** The readers bound to the snapshot's transaction: the one place a live read touches the repos. */
  readers:
    ({ repos: bound }: Pick<Deps, 'repos'>) =>
    (tx: Transaction) =>
      bound.withTx(tx),
  title:
    ({ repos: bound }: Pick<Deps, 'repos'>) =>
    async () => {
      const [first] = await bound.posts.page(1);
      return first?.title ?? null;
    },
});
const rpcImplementer = implement(postsRpcContract).$context<RequestContext>().use(bind(postsLogic));

/** What a live handler reads: the repos bound to the snapshot's transaction. */
type Readers = RepoSet<{ posts: typeof postRepository; users: typeof userRepository }>;

/** The app's one-liner: the `readers` usecase binds the repos to one snapshot per call. */
const readSnapshot = liveRead((context: DepsOf<typeof postsLogic>) =>
  snapshot(context.db, tx => orThrow(context.usecases.readers(tx))),
);

const postsProcedures = {
  list: (impl: typeof rpcImplementer) =>
    impl.list.use(readSnapshot).handler(async ({ context, input, errors }) => {
      expectTypeOf(context.liveRead).toEqualTypeOf<Readers>();
      const page = await context.liveRead.posts.page(input.page);
      if (page.length === 0 && input.page > 1) throw errors.PAGE_OUT_OF_RANGE({ data: { last: 1 } });
      const authors = await context.liveRead.users.names(page.map(row => row.authorId));
      const names = new Map(authors.map(author => [author.id, author.name]));
      return page.map(row => ({ id: row.id, title: row.title, author: names.get(row.authorId) ?? '?' }));
    }),
  stats: (impl: typeof rpcImplementer) =>
    impl.stats.use(readSnapshot).handler(async ({ context }) => {
      // Two reads, one snapshot.
      const total = await context.liveRead.posts.total();
      const first = await context.liveRead.posts.page(1);
      return { posts: total, firstTitle: first[0]?.title ?? null };
    }),
  create: (impl: typeof rpcImplementer) =>
    impl.create.handler(async ({ context, input }) => {
      // A write procedure has no `liveRead`: it never asked for one.
      expectTypeOf(context).not.toHaveProperty('liveRead');
      const rows = await context.db.insert(posts).values({ id: 'p1', title: input.title, authorId: 'u1' }).returning();
      const row = rows[0];
      if (!row) throw new Error('insert returned nothing');
      return { id: row.id, title: row.title, author: row.authorId };
    }),
};

const postsFeature = postsLogic.entrypoints(rpc(postsRpcContract, rpcImplementer, postsProcedures));

// ── negative fixtures ──
function negativeFixtures(impl: typeof rpcImplementer, tx: Transaction): void {
  // A select that needs a context key the chain does not have does not compile.
  // @ts-expect-error -- `missing` is not on the handler context
  impl.list.use(liveRead((context: { readonly missing: Db }) => snapshot(context.missing, t => t)));

  // A transaction handle is not a snapshot: a nested transaction is a savepoint.
  // @ts-expect-error -- `rollback` marks a transaction handle
  snapshot(tx, t => t);

  // Only Drizzle tables go in `reads`.
  // @ts-expect-error -- a string is not a table
  live({ reads: ['posts'] });

  // A handler that never used liveRead() has no snapshot readers.
  impl.list.handler(({ context }) => {
    // @ts-expect-error -- no `liveRead` without the middleware
    void context.liveRead;
    return [];
  });
}

describe('live meta on the contract', () => {
  it('is plain JSON naming each table once, with its schema', () => {
    expectTypeOf(live({ reads: [posts] })).toExtend<LiveMeta>();
    const meta = live({ reads: [posts, users, posts, invoices] });
    const wire = JSON.stringify(meta);
    expect(JSON.parse(wire)).toEqual(meta);
    expect(meta).toEqual({
      live: {
        version: 1,
        reads: [
          { schema: 'public', table: 'posts' },
          { schema: 'public', table: 'users' },
          { schema: 'billing', table: 'invoices' },
        ],
      },
    });
    expect(tableTag(invoices)).toEqual({ schema: 'billing', table: 'invoices' });
  });

  it('reaches the procedure meta that rpc() reads, next to app meta', () => {
    expect(postsRpcContract.list['~orpc'].meta).toEqual({
      auth: 'public',
      live: {
        version: 1,
        reads: [
          { schema: 'public', table: 'posts' },
          { schema: 'public', table: 'users' },
        ],
      },
    });
    expect(postsRpcContract.create['~orpc'].meta).toEqual({});
    expect(postsFeature.name).toBe('posts');
    expect(typeof negativeFixtures).toBe('function');
  });
});
