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
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defineApp, DotLifecycleErrorCode } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { rpc } from '@arki/dot/orpc';
import { infra } from '@arki/dot/unit';
import { orThrow, UnexpectedDefect } from '@arki/failure';
import { http } from '@arki/http/dot';

import type * as hubModule from './hub.js';
import type { LiveMeta } from './index.js';
import { liveQueries } from './dot.js';
import { live, tableTag } from './drizzle/index.js';
import { LIVE_ERROR_CODES, liveTables } from './index.js';
import { liveManifest } from './orpc/index.js';
import { liveMigration } from './pg/index.js';
import { RECEIPTS } from './tests/fixtures.js';
import { pglitePool } from './tests/pglite-pool.js';
import { sseReader } from './tests/sse-reader.js';

/** How many `hub.onChange` subscriptions the hubs made by `liveQueries` hold right now. */
const changeListeners = vi.hoisted(() => ({ active: 0 }));
vi.mock('./hub.js', async importOriginal => {
  const original = await importOriginal<typeof hubModule>();
  return {
    ...original,
    createLiveHub: (...args: Parameters<typeof original.createLiveHub>) => {
      const hub = original.createLiveHub(...args);
      return {
        ...hub,
        onChange(listener: Parameters<typeof hub.onChange>[0]) {
          changeListeners.active += 1;
          const off = hub.onChange(listener);
          return () => {
            changeListeners.active -= 1;
            off();
          };
        },
      };
    },
  };
});

const posts = pgTable('posts', { id: text('id').primaryKey(), title: text('title').notNull() });
const authors = pgTable('authors', { id: text('id').primaryKey(), name: text('name').notNull() });

const contract = oc.$meta<LiveMeta>({});
const postsContract = contract.router({
  list: contract.meta(live({ reads: [posts, authors] })).output(z.array(z.string())),
  create: contract.input(z.object({ title: z.string() })),
});
const postsFeature = defineFeature('posts').entrypoints(
  rpc(postsContract, implement(postsContract), o => ({
    list: o.list.handler(() => []),
    create: o.create.handler(() => {
      // A write: nothing to return.
    }),
  })),
);
const appContract = { posts: postsContract };
const TRIGGERS = liveMigration({ app: 'blog', tables: liveTables(liveManifest(appContract)) }).up;

/** The blog app: PGlite, its tables (with or without triggers), live queries, `http()` on a free port. */
function blogApp(options: { readonly triggers: boolean; readonly failStart?: boolean }) {
  const pglite = new PGlite();
  const pool = pglitePool(pglite);
  const database = infra({
    name: 'db',
    provides: { db: () => drizzle({ client: pglite }) },
    async dispose() {
      await pglite.close();
    },
  });
  const schema = infra({
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
    reauthorize: [tableTag(authors)],
    limits: { batchMs: 1 },
    receipts: RECEIPTS,
  });
  const broken = infra({
    name: 'broken',
    start() {
      if (options.failStart === true) throw new Error('a later plugin failed to start');
    },
  });
  const app = defineApp('blog')
    .infra(database)
    .infra(schema)
    .infra(liveQ)
    .infra(broken)
    .features([postsFeature])
    .entrypoints(http({ port: 0, bundles: [liveQ.provides.liveRoutes] }));
  return { app, stats: pool.stats };
}

describe('liveQueries', () => {
  it('fails boot with E002 when a declared table has no trigger, before anything listens', async () => {
    const { app, stats } = blogApp({ triggers: false });
    const failure = await app.boot();
    expect(UnexpectedDefect.is(failure)).toBe(true);
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
    const started = await orThrow(app.start());
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
      await orThrow(started.dispose());
    }
    expect(stats).toMatchObject({ connects: 1, releases: 1 });
    expect(stats.queries).toContain('UNLISTEN "arki_live_blog_v1"');
  });

  it("stop releases the endpoint's onChange subscription, and so does a rolled-back start", async () => {
    // Earlier tests (a boot that fails builds the hub and never stops it) leave their own count.
    const before = changeListeners.active;
    const started = await orThrow(blogApp({ triggers: true }).app.start());
    expect(changeListeners.active).toBe(before + 1);
    await orThrow(started.dispose());
    expect(changeListeners.active).toBe(before);
    const failure = await blogApp({ triggers: true, failStart: true }).app.start();
    expect(UnexpectedDefect.is(failure)).toBe(true);
    if (!UnexpectedDefect.is(failure)) throw new Error('Expected the failed start defect');
    expect(failure.cause).toMatchObject({
      code: DotLifecycleErrorCode.StartFailed,
      phase: 'start',
      plugin: 'broken',
      cause: new Error('a later plugin failed to start'),
    });
    expect(changeListeners.active).toBe(before);
  });

  it('a start that fails later in the app rolls back and gives the listen client back', async () => {
    const { app, stats } = blogApp({ triggers: true, failStart: true });
    const failure = await app.start();
    expect(UnexpectedDefect.is(failure)).toBe(true);
    if (!UnexpectedDefect.is(failure)) throw new Error('Expected the failed start defect');
    expect(failure.cause).toMatchObject({
      code: DotLifecycleErrorCode.StartFailed,
      phase: 'start',
      plugin: 'broken',
      cause: new Error('a later plugin failed to start'),
    });
    expect(stats).toMatchObject({ connects: 1, releases: 1 });
  });

  it('dot explain shows each procedure live.reads, without booting', () => {
    const { app } = blogApp({ triggers: true });
    const actions = orThrow(app.configure()).manifest.actions;
    // The JSON `dot explain` prints is this manifest: each rpc action carries its contract meta.
    expect(actions.find(action => action.id === 'posts.list')?.meta).toEqual({
      procedure: 'list',
      meta: { live: { version: 1, reads: [tableTag(posts), tableTag(authors)] } },
    });
    expect(actions.find(action => action.id === 'posts.create')?.meta).toEqual({ procedure: 'create' });
  });
});
