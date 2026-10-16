// @vitest-environment jsdom
/**
 * `@arki/live/react` on a real `QueryClient` (plan M3.2, M3.5, round-8 fixes):
 * the real hub and endpoint behind the provider's `fetch`, oRPC utils for the
 * keys, a `fakeSource` for commits. Each test names the bug it guards.
 */
import type { ReactElement } from 'react';
import { createElement, StrictMode } from 'react';
import { oc, ORPCError } from '@orpc/contract';
import { createRouterClient, implement } from '@orpc/server';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';
import { dehydrate, hydrate, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import type { LiveGrant } from '../http.js';
import type { LiveMeta, LiveStatus, TableTag } from '../index.js';
import type { LiveProviderProps } from '../react.js';
import { debugReact } from '../debug.js';
import { liveEndpoint } from '../http.js';
import { createLiveHub, live, LIVE_ERROR_CODES } from '../index.js';
import { liveManifest } from '../orpc/index.js';
import { awaitTxId, LiveProvider, setLiveCursor, useLiveQuery, useLiveStatus } from '../react.js';
import { fakeSource, waitForInvalidation } from '../testing.js';
import { RECEIPTS } from './fixtures.js';

const POSTS: TableTag = { schema: 'public', table: 'posts' };
const USERS: TableTag = { schema: 'public', table: 'users' };

const base = oc.$meta<LiveMeta>({});
const contract = base.router({
  posts: {
    list: base
      .meta(live({ reads: [POSTS] }))
      .input(z.object({ page: z.int() }))
      .output(z.array(z.string())),
    create: base.input(z.object({ title: z.string() })).output(z.string()),
    rows: base.meta(live({ reads: [POSTS] })).output(z.array(z.object({ id: z.string(), title: z.string() }))),
  },
  users: { list: base.meta(live({ reads: [USERS] })).output(z.array(z.string())) },
});

const noop = (): void => undefined;
const idle = (queryClient: QueryClient) => waitFor(() => expect(queryClient.isFetching()).toBe(0));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = noop;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

/** An app: a model database, oRPC utils over it, the hub and endpoint, and the provider's `fetch`. */
async function app() {
  const db = {
    posts: ['v0'],
    users: ['u0'],
    calls: { posts: 0, users: 0, create: 0 },
    /** `posts.list` reads at its start and answers when this resolves. */
    gate: Promise.resolve(),
    denied: false,
  };
  const impl = implement(contract);
  const router = impl.router({
    posts: {
      list: impl.posts.list.handler(async () => {
        db.calls.posts += 1;
        if (db.denied) throw new ORPCError('UNAUTHORIZED');
        const rows = [...db.posts];
        await db.gate;
        return rows;
      }),
      create: impl.posts.create.handler(({ input }) => {
        db.calls.create += 1;
        return input.title;
      }),
      rows: impl.posts.rows.handler(() => db.posts.map((title, index) => ({ id: String(index), title }))),
    },
    users: {
      list: impl.users.list.handler(() => {
        db.calls.users += 1;
        return [...db.users];
      }),
    },
  });
  const orpc = createTanstackQueryUtils(createRouterClient(router));

  const source = fakeSource();
  const hub = createLiveHub({ source, limits: { batchMs: 1 }, receipts: RECEIPTS });
  await hub.start();
  source.emit({ kind: 'ready' });
  let grant: LiveGrant | null = {};
  const endpoint = liveEndpoint({ hub, manifest: liveManifest(contract), authorize: () => Promise.resolve(grant) });
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    return endpoint.fetch(new Request(new URL(url, 'http://live.test'), init));
  };
  cleanups.push(() => hub.stop());

  const statuses: LiveStatus[] = [];
  function Status(): null {
    const status = useLiveStatus();
    if (statuses.at(-1) !== status) statuses.push(status);
    return null;
  }
  function Posts(): null {
    useLiveQuery(orpc.posts.list.queryOptions({ input: { page: 1 } }));
    return null;
  }
  function Users(): null {
    useLiveQuery(orpc.users.list.queryOptions());
    return null;
  }

  function mount(
    queryClient: QueryClient,
    screens: readonly (() => ReactElement | null)[],
    props: Omit<LiveProviderProps, 'children'> = {},
    strict = false,
  ) {
    const tree = (provider: Omit<LiveProviderProps, 'children'>): ReactElement => {
      const children = [Status, ...screens].map((screen, index) => createElement(screen, { key: index }));
      const element = createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(LiveProvider, { fetch, ...provider }, ...children),
      );
      return strict ? createElement(StrictMode, null, element) : element;
    };
    const view = render(tree(props));
    return { rerender: (next: Omit<LiveProviderProps, 'children'>) => view.rerender(tree(next)) };
  }

  /** A commit to `table`, its hint at the hub. */
  function commit(table: 'posts' | 'users', row: string, txid?: string): void {
    db[table] = [row];
    source.emit({ kind: 'change', tags: [table === 'posts' ? POSTS : USERS], ...(txid === undefined ? {} : { txid }) });
  }

  const postsKey = orpc.posts.list.queryKey({ input: { page: 1 } });
  const usersKey = orpc.users.list.queryKey();
  const setGrant = (next: LiveGrant | null): void => {
    grant = next;
  };
  /** The listener drops and comes back: the stream ends with gap and the reconnect resets. */
  const restartListener = (): void => {
    source.emit({ kind: 'gap' });
    source.emit({ kind: 'ready' });
  };
  return { db, orpc, hub, urls, statuses, Posts, Users, mount, commit, postsKey, usersKey, setGrant, restartListener };
}

const client = (): QueryClient => new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });

describe('invalidation by path', () => {
  it('a change refetches only the queries whose tables changed; a reset refetches every live query', async () => {
    const { db, hub, mount, commit, Posts, Users, restartListener } = await app();
    const queryClient = client();
    mount(queryClient, [Posts, Users]);
    await waitFor(() => expect(hub.connections()).toBe(1));
    await idle(queryClient);
    const before = { ...db.calls };

    const users = waitForInvalidation(queryClient, ['users', 'list']);
    commit('users', 'u1');
    await users;
    await idle(queryClient);
    expect(db.calls).toEqual({ ...before, users: before.users + 1 });

    restartListener();
    await waitFor(() => expect(db.calls.posts).toBe(before.posts + 1), { timeout: 3000 });
    await waitFor(() => expect(db.calls.users).toBe(before.users + 2));
  });

  it('StrictMode leaves one stream', async () => {
    const { hub, mount, statuses, Posts } = await app();
    mount(client(), [Posts], {}, true);
    await waitFor(() => expect(statuses).toContain('live'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(hub.connections()).toBe(1);
  });

  it('useLiveQuery outside a LiveProvider throws E001', async () => {
    const { Posts } = await app();
    vi.spyOn(console, 'error').mockImplementation(noop);
    expect(() => render(createElement(QueryClientProvider, { client: client() }, createElement(Posts)))).toThrow(
      LIVE_ERROR_CODES.config,
    );
  });
});

describe('the first-fetch race (round 8, synthesis § 4 rows 1-3)', () => {
  it('a hint during a first fetch is not lost: the query refetches once after that fetch', async () => {
    // TanStack does not cancel a first fetch, and its success clears the invalidated flag. Without
    // the trailing refetch the page shows the pre-commit rows until the next write.
    const { db, mount, commit, statuses, Posts, postsKey } = await app();
    const gate = deferred();
    db.gate = gate.promise;
    const queryClient = client();
    mount(queryClient, [Posts]);
    await waitFor(() => expect(statuses).toContain('live'));
    expect(db.calls.posts).toBe(1); // the first fetch read v0 and is still running
    commit('posts', 'v1', '5');
    await awaitTxId(queryClient, await RECEIPTS.of('5'));
    db.gate = Promise.resolve();
    gate.resolve();
    await waitFor(() => expect(queryClient.getQueryData(postsKey)).toEqual(['v1']));
    await idle(queryClient);
    expect(db.calls.posts).toBe(2); // one trailing refetch, not a cancel-and-restart per hint
  });
});

describe('401/403 (round 8, synthesis § 4 rows 4-6)', () => {
  it('a live query that starts failing with 401 is reset once and not retried: no refetch loop', async () => {
    // resetQueries refetches active queries; if that refetch's 401 reset again, it would loop.
    const { db, mount, commit, Posts, postsKey } = await app();
    const queryClient = client();
    mount(queryClient, [Posts]);
    await waitFor(() => expect(queryClient.getQueryData(postsKey)).toEqual(['v0']));
    await idle(queryClient);
    const before = db.calls.posts;
    db.denied = true;
    commit('posts', 'v1');
    await waitFor(() => expect(queryClient.getQueryState(postsKey)?.status).toBe('error'));
    await waitFor(() => expect(queryClient.getQueryData(postsKey)).toBeUndefined());
    await new Promise(resolve => setTimeout(resolve, 200));
    // The refetch the hint caused, then the one the reset caused. No retries, nothing after.
    expect(db.calls.posts).toBe(before + 2);
    expect(queryClient.getQueryData(postsKey)).toBeUndefined();
  });

  it('paths that leave the manifest on a new hello are dropped from the cache', async () => {
    // A narrower grant: data read under the old one must not stay on screen.
    const { orpc, hub, mount, statuses, Posts, usersKey, setGrant, restartListener } = await app();
    const queryClient = client();
    await queryClient.fetchQuery(orpc.users.list.queryOptions());
    mount(queryClient, [Posts]);
    await waitFor(() => expect(statuses).toContain('live'));
    expect(queryClient.getQueryData(usersKey)).toEqual(['u0']);
    setGrant({ tables: [POSTS] });
    restartListener();
    await waitFor(() => expect(queryClient.getQueryData(usersKey)).toBeUndefined(), { timeout: 3000 });
    expect(hub.connections()).toBe(1);
  });

  it('a refused stream is unauthorized; new headers try again', async () => {
    const { urls, statuses, mount, Posts, setGrant } = await app();
    setGrant(null);
    const view = mount(client(), [Posts], { headers: () => ({ authorization: 'old' }) });
    await waitFor(() => expect(statuses.at(-1)).toBe('unauthorized'));
    expect(urls).toHaveLength(1);
    setGrant({});
    view.rerender({ headers: () => ({ authorization: 'new' }) });
    await waitFor(() => expect(statuses.at(-1)).toBe('live'));
    expect(urls).toHaveLength(2);
    // While live, a new headers function (an inline arrow each render) does not reconnect.
    view.rerender({ headers: () => ({ authorization: 'newer' }) });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(urls).toHaveLength(2);
  });
});

describe('the dev-mode manifest check', () => {
  it('warns once, E001, when a hook is used on a procedure that is not live', async () => {
    // The types cannot reject it: oRPC gives every procedure query options, mutations included.
    const warn = vi.spyOn(debugReact, 'warn');
    const context = await app();
    const { orpc, mount, statuses, Posts } = context;
    function Create(): null {
      useLiveQuery(orpc.posts.create.queryOptions({ input: { title: 'x' } }));
      return null;
    }
    const { urls, restartListener } = context;
    mount(client(), [Posts, Create, Create]);
    await waitFor(() => expect(statuses).toContain('live'));
    // A second hello checks again, and stays quiet about a path it already named.
    restartListener();
    await waitFor(() => expect(urls).toHaveLength(2), { timeout: 3000 });
    await waitFor(() => expect(statuses.at(-1)).toBe('live'));
    const warned = warn.mock.calls.filter(([message]) => String(message).includes('not in the live manifest'));
    expect(warned).toHaveLength(1);
    expect(warned[0]?.[1]).toMatchObject({ code: LIVE_ERROR_CODES.config, path: '["posts","create"]' });
  });
});

async function serverRender(context: Awaited<ReturnType<typeof app>>) {
  const server = new QueryClient();
  // Cursor first, data second: every commit after the cursor is replayed to the client.
  setLiveCursor(server, await context.hub.cursor());
  await server.prefetchQuery(context.orpc.posts.list.queryOptions({ input: { page: 1 } }));
  return dehydrate(server);
}
const browser = (): QueryClient => new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });

describe('server rendering with the hub cursor (D4)', () => {
  it('a commit between the server render and the client connect is replayed, not lost', async () => {
    const context = await app();
    const state = await serverRender(context);
    context.commit('posts', 'v1');
    const queryClient = browser();
    hydrate(queryClient, state);
    expect(queryClient.getQueryData(context.postsKey)).toEqual(['v0']);
    context.mount(queryClient, [context.Posts]);
    await waitFor(() => expect(queryClient.getQueryData(context.postsKey)).toEqual(['v1']));
    expect(context.urls[0]).toMatch(/\?cursor=[\w-]{75}$/);
  });

  it('with no commit in between, the client resumes and refetches nothing', async () => {
    const context = await app();
    const state = await serverRender(context);
    const queryClient = browser();
    hydrate(queryClient, state);
    context.mount(queryClient, [context.Posts]);
    await waitFor(() => expect(context.statuses).toContain('live'));
    await idle(queryClient);
    expect(context.db.calls.posts).toBe(1); // the server's read only
  });
});

describe('awaitTxId', () => {
  it('resolves when a change frame names the receipt, at once when one already did, and on a reset', async () => {
    const { mount, commit, statuses, Posts, restartListener } = await app();
    const queryClient = client();
    mount(queryClient, [Posts]);
    await waitFor(() => expect(statuses).toContain('live'));
    const own = await RECEIPTS.of('41');
    const pending = awaitTxId(queryClient, own, { timeoutMs: 2000 });
    commit('posts', 'v1', '41');
    await expect(pending).resolves.toBeUndefined();
    await expect(awaitTxId(queryClient, own, { timeoutMs: 1 })).resolves.toBeUndefined();

    const covered = awaitTxId(queryClient, await RECEIPTS.of('99'), { timeoutMs: 3000 });
    restartListener();
    await expect(covered).resolves.toBeUndefined();
  });

  it('rejects with E006 on timeout and with E001 without a provider', async () => {
    const { mount, statuses, Posts } = await app();
    const queryClient = client();
    await expect(awaitTxId(queryClient, await RECEIPTS.of('1'))).rejects.toMatchObject({
      code: LIVE_ERROR_CODES.config,
    });
    mount(queryClient, [Posts]);
    await waitFor(() => expect(statuses).toContain('live'));
    await expect(awaitTxId(queryClient, await RECEIPTS.of('7'), { timeoutMs: 20 })).rejects.toMatchObject({
      code: LIVE_ERROR_CODES.limit,
    });
  });
});

describe('TanStack DB: the upstream query collection (D1)', () => {
  it('a collection built on the same oRPC query options refreshes when @arki/live invalidates its key', async () => {
    // Compile proof: oRPC options spread into queryCollectionOptions with no cast; the row type is
    // the procedure's output row. Runtime: the provider's invalidation by path reaches it.
    const { orpc, mount, commit, statuses } = await app();
    const queryClient = client();
    const rows = createCollection(
      queryCollectionOptions({ ...orpc.posts.rows.queryOptions(), queryClient, getKey: row => row.id }),
    );
    type Row = (typeof rows.toArray)[number];
    expectTypeOf<Pick<Row, 'id' | 'title'>>().toEqualTypeOf<{ id: string; title: string }>();
    mount(queryClient, []);
    await waitFor(() => expect(statuses).toContain('live'));
    await rows.preload();
    expect(rows.toArray.map(row => row.title)).toEqual(['v0']);
    commit('posts', 'v1');
    await waitFor(() => expect(rows.toArray.map(row => row.title)).toEqual(['v1']));
    await rows.cleanup();
  });
});
