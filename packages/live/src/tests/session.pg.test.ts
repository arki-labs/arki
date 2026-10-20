// @vitest-environment jsdom
/**
 * Sessions on real Postgres 16 and 18 (testcontainers), through the React
 * provider: `revoked-session` (plan § 8) and an account switch while a fetch
 * is in flight, next to `@arki/offline`'s actor-bound write queue.
 *
 * Why these tests exist: a live query refetches on its own, so it can fetch
 * at the worst moment — right as a session ends or changes hands. The
 * refetch is the authority (the procedure checks the session), the stream is
 * authorized again every `maxAgeMs`, and on an account switch the app resets
 * its queries and remounts the provider (`key`), so nothing read for one
 * account reaches the next: not data, not a fetch already in flight, not
 * table hints of the old grant, not a write queued by the old account.
 */
import { orThrow } from '@arki/failure';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ReactElement } from 'react';
import { createElement } from 'react';
import { oc, ORPCError } from '@orpc/contract';
import { createRouterClient, implement } from '@orpc/server';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { render, waitFor } from '@testing-library/react';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { OPERATION, operations } from '@arki/contracts/orpc';

import type { LiveGrant } from '../http.js';
import type { LiveHub, LiveMeta, LiveStatus, TableTag } from '../index.js';
import { liveEndpoint } from '../http.js';
import { createLiveHub, live } from '../index.js';
import { liveManifest } from '../orpc/index.js';
import { liveMigration, pgSource } from '../pg/index.js';
import { LiveProvider, useLiveQuery, useLiveStatus } from '../react.js';

// The queue keeps its entries in IndexedDB, which jsdom does not have: an in-memory store stands in.
const idbStore = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
  get: (key: string) => Promise.resolve(idbStore.get(key)),
  set: (key: string, value: unknown) => {
    idbStore.set(key, value);
    return Promise.resolve();
  },
  del: (key: string) => {
    idbStore.delete(key);
    return Promise.resolve();
  },
}));
const { createOfflineMutationQueue } = await import('@arki/offline/mutations');

const tag = (table: string): TableTag => ({ schema: 'public', table });
const POSTS = tag('posts');
const SECRETS = tag('secrets');

const base = oc.$meta<LiveMeta>({});
const contract = base.router({
  posts: {
    list: base.meta(live({ reads: [POSTS] })).output(z.array(z.string())),
    create: oc
      .$meta<{ readonly offlineSafe: true }>({ offlineSafe: true })
      .input(z.object({ id: z.string(), title: z.string() })),
  },
  secrets: { list: base.meta(live({ reads: [SECRETS] })).output(z.array(z.string())) },
});
const manifest = liveManifest(contract);
const createPost = { [OPERATION]: operations(contract).posts.create };

/** Alice may read secrets; Bob may not. */
const GRANTS: Record<string, LiveGrant> = {
  alice: { tables: [POSTS, SECRETS] },
  bob: { tables: [POSTS] },
};

type Deferred = { readonly promise: Promise<void>; resolve(): void };
const noop = (): void => undefined;
function deferred(): Deferred {
  let resolve = noop;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.each(['postgres:16-alpine', 'postgres:18-alpine'])('%s', image => {
  let container: StartedPostgreSqlContainer;
  let writer: pg.Pool;
  const cleanups: (() => Promise<void> | void)[] = [];

  beforeAll(async () => {
    container = await new PostgreSqlContainer(image).start();
    writer = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
    await writer.query(`
      create table posts (id text primary key, title text not null, owner text not null);
      create table secrets (id text primary key);
      create table sessions (token text primary key, user_id text not null);
    `);
    await writer.query(liveMigration({ app: 'blog', tables: [POSTS, SECRETS] }).up);
  }, 180_000);

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
    vi.restoreAllMocks();
    idbStore.clear();
  });

  afterAll(async () => {
    await writer.end();
    await container.stop();
  });

  const userOf = async (token: string | undefined): Promise<string | undefined> => {
    if (token === undefined) return undefined;
    const result = await writer.query<{ user_id: string }>('select user_id from sessions where token = $1', [token]);
    return result.rows[0]?.user_id;
  };

  /** The app: the hub on its own listen pool, the endpoint, the procedures, the provider, and who is signed in. */
  async function blog(options: { readonly maxAgeMs?: number } = {}) {
    const run = Math.random().toString(36).slice(2, 8);
    const listenPool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 1 });
    listenPool.on('error', () => null);
    const hub: LiveHub = createLiveHub({
      source: pgSource({ pool: listenPool, app: 'blog', retryMs: 20 }),
      limits: { batchMs: 5 },
    });
    cleanups.push(async () => {
      await hub.stop();
      await listenPool.end();
    });
    await hub.start();
    await expect.poll(() => hub.status(), { timeout: 10_000 }).toBe('ready');

    const session: { token: string | undefined; user: string | null } = { token: undefined, user: null };
    const signIn = async (user: string): Promise<void> => {
      const token = `${user}_${run}_${Math.random().toString(36).slice(2, 8)}`;
      await writer.query('insert into sessions values ($1, $2)', [token, user]);
      session.token = token;
      session.user = user;
    };
    /** `posts.list` answers after this resolves, with the rows it read when it started. */
    const reads = { posts: 0, gate: Promise.resolve() };

    const impl = implement(contract).$context<{ token: string | undefined }>();
    const router = impl.router({
      posts: {
        list: impl.posts.list.handler(async ({ context }) => {
          reads.posts += 1;
          const user = await userOf(context.token);
          if (user === undefined) throw new ORPCError('UNAUTHORIZED');
          const result = await writer.query<{ title: string }>(
            'select title from posts where owner = $1 and id like $2 order by id',
            [user, `${run}%`],
          );
          await reads.gate;
          return result.rows.map(row => row.title);
        }),
        create: impl.posts.create.handler(async ({ context, input }) => {
          const user = await userOf(context.token);
          if (user === undefined) throw new ORPCError('UNAUTHORIZED');
          await writer.query('insert into posts values ($1, $2, $3)', [input.id, input.title, user]);
        }),
      },
      secrets: {
        list: impl.secrets.list.handler(async ({ context }) => {
          if ((await userOf(context.token)) !== 'alice') throw new ORPCError('FORBIDDEN');
          const result = await writer.query<{ id: string }>('select id from secrets order by id');
          return result.rows.map(row => row.id);
        }),
      },
    });
    // Each call carries the session of the moment it starts, like a cookie.
    const rpc = createRouterClient(router, { context: () => ({ token: session.token }) });
    const orpc = createTanstackQueryUtils(rpc);

    const endpoint = liveEndpoint({
      hub,
      manifest,
      authorize: async request => {
        const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
        const user = await userOf(token);
        return user === undefined ? null : (GRANTS[user] ?? null);
      },
      ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
    });
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      return endpoint.fetch(new Request(new URL(url, 'http://live.test'), init));
    };

    const statuses: LiveStatus[] = [];
    function Status(): null {
      const status = useLiveStatus();
      if (statuses.at(-1) !== status) statuses.push(status);
      return null;
    }
    function Screen(): null {
      useLiveQuery(orpc.posts.list.queryOptions());
      useLiveQuery({ ...orpc.secrets.list.queryOptions(), retry: false });
      return null;
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
    /** `key`: the provider is remounted for each account, so the stream is authorized for it. */
    const tree = (): ReactElement =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          LiveProvider,
          {
            key: session.user ?? 'signed-out',
            fetch,
            headers: (): Record<string, string> =>
              session.token === undefined ? {} : { authorization: `Bearer ${session.token}` },
          },
          createElement(Status),
          createElement(Screen),
        ),
      );
    const mount = () => {
      const view = render(tree());
      cleanups.push(() => view.unmount());
      return { rerender: () => view.rerender(tree()) };
    };
    const postsKey = orpc.posts.list.queryKey();
    const secretsKey = orpc.secrets.list.queryKey();
    const insertPost = (id: string, owner: string) =>
      writer.query('insert into posts values ($1, $2, $3)', [`${run}${id}`, `${owner}: ${id}`, owner]);
    return { hub, session, signIn, reads, rpc, queryClient, statuses, mount, postsKey, secretsKey, insertPost, run };
  }

  it('revoked-session: the next refetch is 401 and resets the data; the stream is refused at its next reconnect', async () => {
    // maxAgeMs is short so the re-authorization happens within the test; the wait is on the status.
    const app = await blog({ maxAgeMs: 300 });
    await app.signIn('alice');
    await app.insertPost('a1', 'alice');
    app.mount();
    await waitFor(() => expect(app.queryClient.getQueryData(app.postsKey)).toEqual(['alice: a1']));
    await waitFor(() => expect(app.statuses.at(-1)).toBe('live'));
    const before = app.reads.posts;

    // The session row is deleted. Sessions are a per-request table, so no procedure declares them:
    // the next write to a table the procedure reads makes it refetch, and that refetch is refused.
    await writer.query('delete from sessions where token = $1', [app.session.token]);
    await app.insertPost('a2', 'alice');
    // Real Postgres under a parallel suite: the hint, the refetch and the 401 can take over waitFor's 1 s default.
    await waitFor(() => expect(app.queryClient.getQueryState(app.postsKey)?.status).toBe('error'), { timeout: 5000 });
    await waitFor(() => expect(app.queryClient.getQueryData(app.postsKey)).toBeUndefined(), { timeout: 5000 });
    await waitFor(() => expect(app.statuses.at(-1)).toBe('unauthorized'), { timeout: 5000 });
    // The hint's refetch and the reset's refetch, then nothing: no retry, no loop.
    expect(app.reads.posts - before).toBe(2);
    expect(app.hub.connections()).toBe(0);
  });

  it('account switch with a fetch in flight: nothing read or queued for Alice reaches Bob', async () => {
    const app = await blog();
    await app.signIn('alice');
    await app.insertPost('a1', 'alice');
    await writer.query(`insert into secrets values ('s_${app.run}')`);
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const queue = createOfflineMutationQueue({
      storageKey: `queue-${app.run}`,
      deadLetterStorageKey: `dead-${app.run}`,
      rpc: {
        call: (_path, input) => app.rpc.posts.create(z.object({ id: z.string(), title: z.string() }).parse(input)),
      },
      actorId: () => app.session.user,
    });
    cleanups.push(() => queue.dispose());
    const view = app.mount();
    await waitFor(() => expect(app.queryClient.getQueryData(app.postsKey)).toEqual(['alice: a1']));
    await waitFor(() => expect(app.queryClient.getQueryData(app.secretsKey)).toEqual([`s_${app.run}`]));
    await waitFor(() => expect(app.statuses.at(-1)).toBe('live'));

    // Offline, Alice queues a write.
    const queued = await queue.enqueue(createPost, { id: `${app.run}queued`, title: 'queued by alice' });
    expect(queued.status).toBe('queued');

    // A commit makes Alice's live list refetch; that fetch is held after its SELECT (Alice's rows).
    const held = deferred();
    app.reads.gate = held.promise;
    cleanups.push(() => held.resolve());
    const started = app.reads.posts;
    await app.insertPost('a2', 'alice');
    await waitFor(() => expect(app.reads.posts).toBe(started + 1));

    // The switch, as the README says: reset the queries, remount the provider for the new account.
    const seenByBob: unknown[] = [];
    await app.signIn('bob');
    await app.insertPost('b1', 'bob');
    app.reads.gate = Promise.resolve();
    const unsubscribe = app.queryClient.getQueryCache().subscribe(event => {
      if (event.type === 'updated' && event.action.type === 'success') seenByBob.push(event.query.state.data);
    });
    cleanups.push(unsubscribe);
    await app.queryClient.resetQueries();
    view.rerender();
    held.resolve();

    await waitFor(() => expect(app.queryClient.getQueryData(app.postsKey)).toEqual(['bob: b1']));
    await waitFor(() => expect(app.statuses.at(-1)).toBe('live'));
    // Alice's in-flight answer never landed in Bob's cache, and her secrets are gone.
    expect(seenByBob).not.toContainEqual(['alice: a1', 'alice: a2']);
    expect(app.queryClient.getQueryData(app.secretsKey)).toBeUndefined();
    // One stream, authorized for Bob: a secrets write invalidates nothing he holds.
    await waitFor(() => expect(app.hub.connections()).toBe(1));
    const invalidated: string[] = [];
    const watch = app.queryClient.getQueryCache().subscribe(event => {
      if (event.type === 'updated' && event.action.type === 'invalidate')
        invalidated.push(JSON.stringify(event.query.queryKey[0]));
    });
    cleanups.push(watch);
    await writer.query(`insert into secrets values ('s2_${app.run}')`);
    await app.insertPost('b2', 'bob');
    await waitFor(() => expect(app.queryClient.getQueryData(app.postsKey)).toEqual(['bob: b1', 'bob: b2']));
    expect(invalidated).not.toContain(JSON.stringify(app.secretsKey[0]));

    // Back online: Alice's queued write is not sent under Bob's session.
    online.mockReturnValue(true);
    await queue.drain();
    const dead = orThrow(await queue.deadLetter.list());
    expect(dead.map(entry => entry.lastError?.code)).toEqual(['ACTOR_MISMATCH']);
    const row = await writer.query('select 1 from posts where id = $1', [`${app.run}queued`]);
    expect(row.rowCount).toBe(0);
  });
});
