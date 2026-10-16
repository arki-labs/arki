/**
 * `liveEndpoint` with scoped tables: the grant becomes the view the hub
 * applies, `hello` names the client's own keys, and a write to a
 * `reauthorize` table re-runs `authorize` (scoped-hints plan § 2.5, tests T7
 * and T11).
 *
 * Why these tests exist: the endpoint is where a session's memberships turn
 * into keys. A key written in another form than Postgres prints it would
 * never match its hints (the client goes stale); a scoped table with no keys
 * granted must show nothing (closed by default); a procedure that reads a
 * scoped table without saying where its key comes from could only be kept
 * fresh by refetching it on every tenant's write, so it is live for `'all'`
 * grants only. And a removed membership must stop the old org's hints soon,
 * not after `maxAgeMs`.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { LiveGrant } from '../http.js';
import type { LiveEvent, LiveManifest, LiveScopes, TableTag } from '../index.js';
import type { SseReader } from './sse-reader.js';
import { liveEndpoint } from '../http.js';
import { createLiveHub } from '../index.js';
import { fakeSource } from '../testing.js';
import { RECEIPTS } from './fixtures.js';
import { sseReader } from './sse-reader.js';

const tag = (table: string): TableTag => ({ schema: 'public', table });
const POSTS = tag('posts');
const USERS = tag('users');
/** Scoped by user, read by no procedure: only the endpoint's `reauthorize` names it. */
const MEMBERSHIPS = tag('memberships');

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

const LIST = {
  path: ['posts', 'list'],
  reads: [POSTS],
  scope: { org: { from: 'input', path: ['orgId'], kind: 'uuid' } },
};
const MINE = { path: ['posts', 'mine'], reads: [POSTS, USERS], scope: { org: { from: 'session' } } };
/** Reads a scoped table and declares no scope: live only for `org: 'all'` (D6). */
const STATS = { path: ['posts', 'stats'], reads: [POSTS] };
const NAMES = { path: ['users', 'names'], reads: [USERS] };
const manifest: LiveManifest = [LIST, MINE, STATS, NAMES];

const receipt = (txid: string): Promise<string> => RECEIPTS.of(txid);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * A ready hub and an endpoint whose grant is whatever `state.grant` holds when `authorize` runs.
 * Typed as any grant, the way a JavaScript caller could return one.
 */
async function rig(grant: LiveGrant | null) {
  const source = fakeSource();
  const hub = createLiveHub({ source, limits: { batchMs: 1 }, receipts: RECEIPTS });
  await hub.start();
  source.emit({ kind: 'ready' });
  cleanups.push(() => hub.stop());
  const state: { grant: LiveGrant | null } = { grant };
  const authorize = vi.fn(() => Promise.resolve(state.grant));
  const endpoint = liveEndpoint({ hub, manifest, scopes, authorize, reauthorize: [MEMBERSHIPS] });
  const request = (query = '') => endpoint.fetch(new Request(`http://live.test/api/live${query}`));
  const stream = async (query = ''): Promise<SseReader> => {
    const response = await request(query);
    expect(response.status).toBe(200);
    const reader = sseReader(response);
    cleanups.push(() => reader.cancel());
    return reader;
  };
  /** One commit's hint, then a wait past the batch window. */
  const commit = async (txid: string, ...tags: readonly (TableTag & { readonly keys?: readonly string[] })[]) => {
    source.emit({ kind: 'change', tags, txid });
    await sleep(5);
  };
  return { hub, state, authorize, request, stream, commit };
}

/** Every frame up to the next `bye` or end, after `hello`. */
async function until(reader: SseReader, count: number): Promise<LiveEvent[]> {
  const frames: LiveEvent[] = [];
  while (frames.length < count) {
    const frame = await reader.next();
    if (frame === undefined) break;
    frames.push(frame);
  }
  return frames;
}

describe('T7: the grant becomes the view: own keys only, closed by default', () => {
  it('org [A] (any UUID form): hello has its own keys and the scoped procedures; a frame names A only, with A’s receipt', async () => {
    const { stream, commit } = await rig({ scopes: { org: [`{${A.toUpperCase()}}`], user: ['u1'] } });
    const client = await stream();
    expect(await client.next()).toMatchObject({
      kind: 'hello',
      manifest: [LIST, MINE, NAMES],
      scopes: { org: [A], user: ['u1'] },
    });
    await commit('1', { ...POSTS, keys: [B] });
    await commit('2', { ...POSTS, keys: [A, B] }, USERS);
    expect(await client.next()).toMatchObject({
      kind: 'change',
      tags: [{ ...POSTS, scope: { name: 'org', keys: [A] } }, USERS],
      txids: [await receipt('2')],
    });
  });

  it('org [C] sees no frame of A and B; org all sees both keys and the procedure that declares no scope', async () => {
    const other = await rig({ scopes: { org: [C] } });
    const c = await other.stream();
    await c.next();
    await other.commit('1', { ...POSTS, keys: [A, B] });
    await other.commit('2', USERS);
    // The first frame C gets is the users one: the posts write never reached its stream.
    expect(await c.next()).toMatchObject({ kind: 'change', tags: [USERS], txids: [await receipt('2')] });

    const admin = await rig({ scopes: { org: 'all' } });
    const all = await admin.stream();
    expect(await all.next()).toMatchObject({ kind: 'hello', manifest, scopes: { org: 'all' } });
    await admin.commit('3', { ...POSTS, keys: [A, B] });
    expect(await all.next()).toMatchObject({ tags: [{ ...POSTS, scope: { name: 'org', keys: [A, B] } }] });
  });

  it('a grant without the org dimension (or with no org keys) shows no scoped procedure and no key; unscoped tables still flow', async () => {
    for (const grant of [{}, { scopes: { org: [] } }]) {
      const { stream, commit } = await rig(grant);
      const client = await stream();
      expect(await client.next()).toMatchObject({ kind: 'hello', manifest: [NAMES] });
      await commit('1', { ...POSTS, keys: [A] });
      await commit('2', USERS);
      expect(await client.next()).toMatchObject({ tags: [USERS], txids: [await receipt('2')] });
    }
  });

  it('a grant that cannot be right (undeclared dimension, a key of the wrong kind, too many keys) opens no stream', async () => {
    const bad: LiveGrant[] = [
      { scopes: { team: ['t1'] } },
      { scopes: { org: ['not-a-uuid'] } },
      {
        scopes: {
          org: Array.from({ length: 4097 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`),
        },
      },
    ];
    for (const grant of bad) {
      const { request, hub, state } = await rig(null);
      // Typed apps cannot write these (see the type test); a JavaScript caller still could.
      state.grant = grant;
      const response = await request();
      expect(response.status).toBe(500);
      await response.body?.cancel();
      expect(hub.connections()).toBe(0);
    }
  });

  it('the grant is typed by the declared dimensions', () => {
    const hub = createLiveHub({ source: fakeSource() });
    expectTypeOf<LiveGrant<'org' | 'user'>['scopes']>().toEqualTypeOf<
      { readonly org?: readonly string[] | 'all'; readonly user?: readonly string[] | 'all' } | undefined
    >();
    liveEndpoint({
      hub,
      manifest,
      scopes,
      // @ts-expect-error -- `team` is not a dimension of `scopes`.
      authorize: () => Promise.resolve({ scopes: { team: ['t1'] } }),
    });
    liveEndpoint({
      hub,
      manifest,
      scopes,
      authorize: () => Promise.resolve({ scopes: { org: 'all' as const, user: ['u1'] } }),
    });
  });
});

describe('T11: a write to a reauthorize table re-runs authorize', () => {
  it('a removed org ends the stream with bye; the resume replays under the new grant: the gained org since the cursor, never the removed one', async () => {
    const { stream, commit, state, authorize } = await rig({ scopes: { org: [A], user: ['u1'] } });
    const client = await stream();
    await client.next();
    await commit('1', { ...POSTS, keys: [A] });
    const seen = await client.next();
    if (seen?.kind !== 'change') throw new Error('expected a change');
    await commit('2', { ...POSTS, keys: [B] }); // hidden: B is not granted yet
    state.grant = { scopes: { org: [B], user: ['u1'] } };
    await commit('3', { ...MEMBERSHIPS, keys: ['u1'] });
    expect(await until(client, 2)).toEqual([{ kind: 'bye' }]);
    await commit('4', { ...POSTS, keys: [A] }); // after the move: never shown to this user again

    const again = await stream(`?cursor=${seen.cursor}`);
    const [hello, ...replay] = await until(again, 3);
    expect(hello).toMatchObject({ kind: 'hello', mode: 'resume', scopes: { org: [B], user: ['u1'] } });
    const tags = replay.flatMap(frame => (frame.kind === 'change' ? frame.tags : []));
    expect(tags).toEqual([
      { ...POSTS, scope: { name: 'org', keys: [B] } },
      { ...MEMBERSHIPS, scope: { name: 'user', keys: ['u1'] } },
    ]);
    // One per connect, one per memberships frame: live (the bye), and replayed (now the same grant, so it goes out).
    expect(authorize).toHaveBeenCalledTimes(4);
  });

  it('an unchanged grant keeps the stream: the memberships frame goes out, no bye', async () => {
    const { stream, commit, authorize } = await rig({ scopes: { org: [A], user: ['u1'] } });
    const client = await stream();
    await client.next();
    await commit('1', { ...MEMBERSHIPS, keys: ['u1'] });
    await commit('2', { ...POSTS, keys: [A] });
    expect(await until(client, 2)).toMatchObject([
      { kind: 'change', tags: [{ ...MEMBERSHIPS, scope: { name: 'user', keys: ['u1'] } }] },
      { kind: 'change', tags: [{ ...POSTS, scope: { name: 'org', keys: [A] } }] },
    ]);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it('another user’s membership change never reaches the stream, so it runs no authorize', async () => {
    const { stream, commit, authorize } = await rig({ scopes: { org: [A], user: ['u1'] } });
    const client = await stream();
    await client.next();
    await commit('1', { ...MEMBERSHIPS, keys: ['u2'] });
    await commit('2', { ...POSTS, keys: [A] });
    expect(await client.next()).toMatchObject({ tags: [{ ...POSTS, scope: { name: 'org', keys: [A] } }] });
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it('a refusal on the re-check is a change: bye, and the reconnect answers 401', async () => {
    const { stream, commit, state, request } = await rig({ scopes: { org: [A], user: ['u1'] } });
    const client = await stream();
    await client.next();
    state.grant = null;
    await commit('1', { ...MEMBERSHIPS, keys: ['u1'] });
    expect(await until(client, 2)).toEqual([{ kind: 'bye' }]);
    const refused = await request();
    expect(refused.status).toBe(401);
  });
});
