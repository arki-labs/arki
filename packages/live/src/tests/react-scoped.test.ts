// @vitest-environment jsdom
/**
 * `@arki/live/react` with scoped tables (scoped-hints plan § 2.6, test T12):
 * the real hub and endpoint behind the provider, oRPC utils for the keys.
 *
 * Why these tests exist: the point of scoping is that tenant A's write
 * refetches tenant A's queries, not every cached input of every procedure
 * that reads the table. The client matches a hinted key against each query's
 * input the way Postgres prints it, or an upper-case UUID in a URL would
 * never refresh. And a grant can shrink between two connections: the data of
 * an org the user just left must not stay on screen.
 */
import type { ReactElement } from 'react';
import { createElement } from 'react';
import { oc } from '@orpc/contract';
import { createRouterClient, implement } from '@orpc/server';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { LiveGrant } from '../http.js';
import type { LiveMeta, LiveScopes, LiveStatus, TableTag } from '../index.js';
import { liveEndpoint } from '../http.js';
import { createLiveHub, live } from '../index.js';
import { liveManifest } from '../orpc/index.js';
import { LiveProvider, useLiveQuery, useLiveStatus } from '../react.js';
import { fakeSource } from '../testing.js';
import { RECEIPTS } from './fixtures.js';

const POSTS: TableTag = { schema: 'public', table: 'posts' };
const MEMBERSHIPS: TableTag = { schema: 'public', table: 'memberships' };
const A = '0a000000-0000-4000-8000-000000000000';
const B = '0b000000-0000-4000-8000-000000000000';
const C = '0c000000-0000-4000-8000-000000000000';

const scopes: LiveScopes<'org' | 'user'> = {
  dimensions: ['org', 'user'],
  tables: [
    { tag: POSTS, dimension: 'org', column: 'org_id', kind: 'uuid' },
    { tag: MEMBERSHIPS, dimension: 'user', column: 'user_id', kind: 'text' },
  ],
};

const base = oc.$meta<LiveMeta>({});
const contract = base.router({
  posts: {
    list: base
      .meta(live({ reads: [POSTS], scope: { org: 'input.orgId' } }))
      .input(z.object({ orgId: z.uuid() }))
      .output(z.array(z.string())),
    mine: base.meta(live({ reads: [POSTS], scope: { org: 'session' } })).output(z.array(z.string())),
  },
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function app(initial: LiveGrant<'org' | 'user'>) {
  /** Fetches per `posts.list` input (as the client sent it), and of `posts.mine`. */
  const calls = new Map<string, number>();
  const count = (key: string): void => void calls.set(key, (calls.get(key) ?? 0) + 1);
  const impl = implement(contract);
  const router = impl.router({
    posts: {
      list: impl.posts.list.handler(({ input }) => {
        count(input.orgId);
        return [input.orgId];
      }),
      mine: impl.posts.mine.handler(() => {
        count('mine');
        return ['mine'];
      }),
    },
  });
  const orpc = createTanstackQueryUtils(createRouterClient(router));
  const source = fakeSource();
  const hub = createLiveHub({ source, limits: { batchMs: 1 }, receipts: RECEIPTS });
  await hub.start();
  source.emit({ kind: 'ready' });
  cleanups.push(() => hub.stop());
  const state = { grant: initial };
  const endpoint = liveEndpoint({
    hub,
    manifest: liveManifest(contract, { scopes }),
    scopes,
    reauthorize: [MEMBERSHIPS],
    authorize: () => Promise.resolve(state.grant),
  });
  const fetch: typeof globalThis.fetch = (input, init) =>
    endpoint.fetch(
      new Request(new URL(input instanceof Request ? input.url : String(input), 'http://live.test'), init),
    );

  const statuses: LiveStatus[] = [];
  function Status(): null {
    const status = useLiveStatus();
    if (statuses.at(-1) !== status) statuses.push(status);
    return null;
  }
  const List = (orgId: string) =>
    function ListScreen(): null {
      useLiveQuery(orpc.posts.list.queryOptions({ input: { orgId } }));
      return null;
    };
  function Mine(): null {
    useLiveQuery(orpc.posts.mine.queryOptions());
    return null;
  }
  const queryClient = new QueryClient();
  function mount(screens: readonly (() => ReactElement | null)[]): void {
    const children = [Status, ...screens].map((screen, index) => createElement(screen, { key: index }));
    render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(LiveProvider, { fetch }, ...children)),
    );
  }
  const write = (txid: string, table: TableTag, ...keys: string[]): void =>
    source.emit({ kind: 'change', tags: [{ ...table, keys }], txid });
  const listKey = (orgId: string) => orpc.posts.list.queryKey({ input: { orgId } });
  const settled = () => waitFor(() => expect(queryClient.isFetching()).toBe(0));
  return { calls, state, queryClient, orpc, List, Mine, mount, write, listKey, statuses, settled };
}

describe('T12: a scoped hint refetches the queries of its keys', () => {
  it('a hint on A refetches list({ orgId: A }), in any UUID form, and not B; a session path refetches on any key', async () => {
    const { calls, mount, List, Mine, write, statuses, settled } = await app({ scopes: { org: [A, B] } });
    mount([List(A), List(A.toUpperCase()), List(B), Mine]);
    await waitFor(() => expect(statuses).toContain('live'));
    await settled();
    const before = new Map(calls);
    write('1', POSTS, A);
    await waitFor(() => expect(calls.get(A)).toBe((before.get(A) ?? 0) + 1));
    await waitFor(() => expect(calls.get(A.toUpperCase())).toBe((before.get(A.toUpperCase()) ?? 0) + 1));
    await waitFor(() => expect(calls.get('mine')).toBe((before.get('mine') ?? 0) + 1));
    await settled();
    expect(calls.get(B)).toBe(before.get(B));

    write('2', POSTS, B);
    await waitFor(() => expect(calls.get(B)).toBe((before.get(B) ?? 0) + 1));
    await waitFor(() => expect(calls.get('mine')).toBe((before.get('mine') ?? 0) + 2));
    await settled();
    expect(calls.get(A)).toBe((before.get(A) ?? 0) + 1);
  });

  it('a grant that loses B and gains C on resume drops B’s cache, refetches C’s, and leaves A alone', async () => {
    const { calls, state, queryClient, orpc, mount, List, write, listKey, statuses, settled } = await app({
      scopes: { org: [A, B], user: ['u1'] },
    });
    // B and C are cached without an observer (read before, say, by a server render); A is on screen.
    for (const orgId of [B, C]) await queryClient.fetchQuery(orpc.posts.list.queryOptions({ input: { orgId } }));
    await queryClient.fetchQuery(orpc.posts.mine.queryOptions());
    mount([List(A)]);
    await waitFor(() => expect(statuses).toContain('live'));
    await settled();
    const before = new Map(calls);
    state.grant = { scopes: { org: [A, C], user: ['u1'] } };
    // The membership write ends the stream with bye; the client resumes under the new grant.
    write('1', MEMBERSHIPS, 'u1');
    await waitFor(() => expect(queryClient.getQueryData(listKey(B))).toBeUndefined());
    // Lost a key: the session path may hold B's rows, so it goes too.
    expect(queryClient.getQueryData(orpc.posts.mine.queryKey())).toBeUndefined();
    expect(queryClient.getQueryState(listKey(C))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(listKey(A))).toEqual([A]);
    await settled();
    expect(calls.get(A)).toBe(before.get(A));
  });
});
