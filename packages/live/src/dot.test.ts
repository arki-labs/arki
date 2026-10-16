/**
 * `liveQueries` in a Dot app on PGlite, served by `http()`.
 *
 * Why these tests exist: the plugin is where an app either gets live queries
 * or fails loudly. A declared table without its trigger would never publish,
 * so boot must stop with E002 before anything listens. A start that fails
 * further down the app must not leave the listener holding a pool client.
 * And the declarations must be visible to `dot explain` without booting.
 *
 * PGlite has one connection, so the listener's "pool" here hands out a client
 * on that same instance (notifications to the listening session itself are
 * delivered at commit). Real pools, a separate listen backend and killing it
 * are in `tests/demo.pg.test.ts`.
 */
import { PGlite } from '@electric-sql/pglite';
import { oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ListenClient, ListenPool } from '@arki/db/pg';
import { defineApp, DotLifecycleError } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { rpc } from '@arki/dot/orpc';
import { plugin } from '@arki/dot/plugin';
import { http } from '@arki/http/dot';

import type { LiveMeta } from './index.js';
import { liveQueries } from './dot.js';
import { live, tableTag } from './drizzle/index.js';
import { LIVE_ERROR_CODES, liveTables } from './index.js';
import { liveManifest } from './orpc/index.js';
import { liveMigration } from './pg/index.js';
import { RECEIPTS } from './tests/fixtures.js';
import { sseReader } from './tests/sse-reader.js';

const posts = pgTable('posts', { id: text('id').primaryKey(), title: text('title').notNull() });
const authors = pgTable('authors', { id: text('id').primaryKey(), name: text('name').notNull() });

const contract = oc.$meta<LiveMeta>({});
const postsContract = contract.router({
  list: contract.meta(live({ reads: [posts, authors] })).output(z.array(z.string())),
  create: contract.input(z.object({ title: z.string() })),
});
const postsFeature = defineFeature('posts').entrypoints(
  rpc(postsContract, implement(postsContract), {
    list: o => o.list.handler(() => []),
    create: o =>
      o.create.handler(() => {
        // A write: nothing to return.
      }),
  }),
);
const appContract = { posts: postsContract };
const TRIGGERS = liveMigration({ app: 'blog', tables: liveTables(liveManifest(appContract)) }).up;

type Notification = { readonly channel: string; readonly payload?: string };
type Handlers = {
  notification: (message: Notification) => void;
  error: (error: Error) => void;
  end: () => void;
};

/** A listen "pool" on one PGlite instance, counting what the listener takes and gives back. */
function pglitePool(
  pglite: PGlite,
): ListenPool & { readonly stats: { connects: number; releases: number; queries: string[] } } {
  const stats = { connects: 0, releases: 0, queries: [] as string[] };
  return {
    stats,
    connect() {
      stats.connects += 1;
      const handlers: { [Event in keyof Handlers]: Handlers[Event][] } = { notification: [], error: [], end: [] };
      const unsubscribe = pglite.onNotification((channel, payload) => {
        for (const listener of handlers.notification) listener({ channel, payload });
      });
      const client: ListenClient = {
        async query(text) {
          stats.queries.push(text);
          return await pglite.query(text);
        },
        on<Event extends keyof Handlers>(event: Event, listener: Handlers[Event]) {
          handlers[event].push(listener);
        },
        release() {
          stats.releases += 1;
          unsubscribe();
        },
      };
      return Promise.resolve(client);
    },
  };
}

/** The blog app: PGlite, its tables (with or without triggers), live queries, `http()` on a free port. */
function blogApp(options: { readonly triggers: boolean; readonly failStart?: boolean }) {
  const pglite = new PGlite();
  const pool = pglitePool(pglite);
  const database = plugin({
    name: 'db',
    provides: { db: () => drizzle({ client: pglite }) },
    async dispose() {
      await pglite.close();
    },
  });
  const schema = plugin({
    name: 'schema',
    needs: { db: database.provides.db },
    async boot() {
      await pglite.exec(`
        create table posts (id text primary key, title text not null);
        create table authors (id text primary key, name text not null);
        ${options.triggers ? TRIGGERS : ''}
      `);
    },
  });
  const liveQ = liveQueries({
    app: 'blog',
    needs: { db: database.provides.db },
    db: ({ db: handle }) => handle,
    pool: () => pool,
    contract: appContract,
    authorize: () => Promise.resolve({}),
    limits: { batchMs: 1 },
    receipts: RECEIPTS,
  });
  const broken = plugin({
    name: 'broken',
    start() {
      if (options.failStart === true) throw new Error('a later plugin failed to start');
    },
  });
  const app = defineApp('blog')
    .use(database)
    .use(schema)
    .use(liveQ)
    .use(broken)
    .features([postsFeature])
    .serve(http({ port: 0, bundles: [liveQ.provides.liveRoutes] }));
  return { app, stats: pool.stats };
}

describe('liveQueries', () => {
  it('fails boot with E002 when a declared table has no trigger, before anything listens', async () => {
    const { app, stats } = blogApp({ triggers: false });
    const failure = await app.boot().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DotLifecycleError);
    expect(failure).toMatchObject({
      cause: {
        code: LIVE_ERROR_CODES.triggers,
        message: expect.stringMatching(/public\.posts \(missing-trigger\).*public\.authors \(missing-trigger\)/),
      },
    });
    expect(stats.connects).toBe(0);
  });

  it('serves /api/live from http(): a commit in the database reaches the stream; stop releases the listener', async () => {
    const { app, stats } = blogApp({ triggers: true });
    const started = await app.start();
    try {
      const url = started.services.httpServer.url();
      if (url === undefined) throw new Error('the server has no url');
      const response = await fetch(new URL('/api/live', url));
      expect(response.status).toBe(200);
      const client = sseReader(response);
      expect(await client.next()).toMatchObject({
        kind: 'hello',
        mode: 'reset',
        manifest: [{ path: ['posts', 'list'], reads: [tableTag(posts), tableTag(authors)] }],
      });
      await started.services.db.insert(posts).values({ id: 'p1', title: 'Hello' });
      expect(await client.next()).toMatchObject({
        kind: 'change',
        tags: [tableTag(posts)],
        // A receipt, never the decimal transaction id.
        txids: [expect.stringMatching(/^[\w-]{22}$/)],
      });
      expect(started.services.live.connections()).toBe(1);
      await client.cancel();
    } finally {
      await started.dispose();
    }
    expect(stats).toMatchObject({ connects: 1, releases: 1 });
    expect(stats.queries).toContain('UNLISTEN "arki_live_blog_v1"');
  });

  it('a start that fails later in the app rolls back and gives the listen client back', async () => {
    const { app, stats } = blogApp({ triggers: true, failStart: true });
    const failure = await app.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DotLifecycleError);
    expect(stats).toMatchObject({ connects: 1, releases: 1 });
  });

  it('dot explain shows each procedure live.reads, without booting', () => {
    const { app } = blogApp({ triggers: true });
    const actions = app.configure().manifest.actions;
    // The JSON `dot explain` prints is this manifest: each rpc action carries its contract meta.
    expect(actions.find(action => action.id === 'posts.list')?.meta).toEqual({
      procedure: 'list',
      meta: { live: { version: 1, reads: [tableTag(posts), tableTag(authors)] } },
    });
    expect(actions.find(action => action.id === 'posts.create')?.meta).toEqual({ procedure: 'create' });
  });
});
