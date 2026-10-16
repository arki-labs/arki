/**
 * A Dot app with live queries, end to end: the contract declares what each
 * procedure reads, the handler reads through one snapshot, `liveQueries`
 * checks the triggers at boot and serves `GET /api/live`. Compiled by
 * `bun run typecheck`; not shipped.
 *
 * The triggers come from a migration: write `liveMigration({ app: 'blog',
 * tables: liveTables(liveManifest(appContract)) }).up` into one, next to the
 * tables, and run it before boot.
 */
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { z } from 'zod';

import type { DepsOf, ServicesBag } from '@arki/dot/feature';
import type { LiveMeta } from '@arki/live';
import { repos } from '@arki/db/dot';
import { defineApp } from '@arki/dot';
import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { needsMiddleware, rpc } from '@arki/dot/orpc';
import { plugin } from '@arki/dot/plugin';
import { http } from '@arki/http/dot';
import { liveQueries } from '@arki/live/dot';
import { live, snapshot } from '@arki/live/drizzle';
import { liveRead } from '@arki/live/orpc';

const posts = pgTable('posts', { id: text('id').primaryKey(), title: text('title').notNull() });

type Db = NodePgDatabase;
type Database = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
const postRepository = (db: Database) => ({
  all: () => db.select().from(posts).orderBy(posts.id),
  add: (id: string, title: string) => db.insert(posts).values({ id, title }),
});

// Two pools: the app's, and the listener's own (it holds one client for as long as it runs).
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const listenPool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  application_name: 'blog_listener',
});
const database = plugin({ name: 'database', provides: { db: (): Db => drizzle({ client: appPool }) } });

const contract = oc.$meta<LiveMeta>({});
const Post = z.object({ id: z.string(), title: z.string() });
const postsContract = contract.router({
  list: contract.meta(live({ reads: [posts] })).output(z.array(Post)),
  create: contract.input(z.object({ id: z.string(), title: z.string().min(1) })),
});
const appContract = { posts: postsContract };

type RequestContext = { readonly headers: Headers; readonly services: ServicesBag };
const store = repos({ posts: postRepository });
const postsDeps = defineFeature('posts')
  .needs({ db: entrypointOnly(database.provides.db) })
  .infra(store);
type Deps = DepsOf<typeof postsDeps>;
const postsLogic = postsDeps.usecases({});
const impl = implement(postsContract).$context<RequestContext>().use(needsMiddleware<RequestContext>()(postsLogic));

/** One snapshot per call: every read of the handler sees one point in time. */
const readSnapshot = liveRead((context: { readonly db: Db; readonly repos: Deps['repos'] }) =>
  snapshot(context.db, tx => context.repos.withTx(tx)),
);

const postsFeature = postsLogic.entrypoints(
  rpc(postsContract, impl, {
    list: o => o.list.use(readSnapshot).handler(({ context }) => context.liveRead.posts.all()),
    create: o =>
      o.create.handler(async ({ context, input }) => {
        await context.repos.posts.add(input.id, input.title);
      }),
  }),
);

const liveQ = liveQueries({
  app: 'blog',
  needs: { db: database.provides.db },
  db: ({ db }) => db,
  pool: () => listenPool,
  contract: appContract,
  // `null` answers 401. `{}` grants every table of the manifest; `{ tables }` narrows it.
  authorize: request => Promise.resolve(request.headers.get('authorization') === null ? null : {}),
});

export const app = defineApp('blog')
  .use(database)
  .use(liveQ)
  .features([postsFeature])
  .serve(http({ port: 3000, bundles: [liveQ.provides.liveRoutes] }));
