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
import type { LiveEvent, LiveHub, LiveManifest, LiveScopes, TableTag } from '../index.js';
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

const noop = (): void => undefined;

/** A barrier: `promise` settles when `resolve` is called. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = noop;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * A ready hub and an endpoint whose grant is whatever `state.grant` holds when `authorize` runs.
 * Typed as any grant, the way a JavaScript caller could return one. `wrap` stands between the endpoint and the hub.
 */
async function rig(grant: LiveGrant | null, wrap: (hub: LiveHub) => LiveHub = hub => hub) {
  const source = fakeSource();
  const hub = createLiveHub({ source, limits: { batchMs: 1 }, receipts: RECEIPTS });
  await hub.start();
  source.emit({ kind: 'ready' });
  cleanups.push(() => hub.stop());
  /** `fail`: `authorize` throws, as a session store that is down would. */
  const state: { grant: LiveGrant | null; fail: boolean } = { grant, fail: false };
  const authorize = vi.fn(() =>
    state.fail ? Promise.reject(new Error('the session store is down')) : Promise.resolve(state.grant),
  );
  const endpoint = liveEndpoint({ hub: wrap(hub), manifest, scopes, authorize, reauthorize: [MEMBERSHIPS] });
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
  return { source, hub, state, authorize, request, stream, commit, close: () => endpoint.close() };
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
  it('a grant that cannot see memberships is still re-checked: its membership row goes, bye, and the reconnect is narrower', async () => {
    // Fail-open before: the re-check ran on the projected frame, which this grant never gets.
    const { stream, commit, state, authorize } = await rig({ tables: [POSTS], scopes: { org: [A], user: ['u1'] } });
    const client = await stream();
    expect(await client.next()).toMatchObject({ kind: 'hello', manifest: [LIST] });
    state.grant = { tables: [POSTS], scopes: { org: [], user: ['u1'] } };
    await commit('1', { ...MEMBERSHIPS, keys: ['u1'] }); // the membership row is deleted
    expect(await until(client, 2)).toEqual([{ kind: 'bye' }]);
    const again = await stream();
    expect(await again.next()).toMatchObject({ kind: 'hello', manifest: [], scopes: { org: [], user: ['u1'] } });
    expect(authorize).toHaveBeenCalledTimes(3);
  });

  it('authorize throwing during a re-check ends the stream (fail closed), also for a grant that cannot see memberships', async () => {
    const { stream, commit, state, request } = await rig({ tables: [POSTS], scopes: { org: [A], user: ['u1'] } });
    const client = await stream();
    await client.next();
    state.fail = true;
    await commit('1', { ...MEMBERSHIPS, keys: ['u1'] });
    expect(await until(client, 2)).toEqual([{ kind: 'bye' }]);
    const failed = await request();
    expect(failed.status).toBe(500);
    await failed.body?.cancel();
  });

  it('a burst of 50 membership writes runs authorize once per stream it concerns', async () => {
    // The grant does not see memberships: the re-checks come from the hub's changes, not from frames.
    const { source, stream, commit, authorize } = await rig({ tables: [POSTS], scopes: { org: [A], user: ['u1'] } });
    const client = await stream();
    await client.next();
    for (let txid = 1; txid <= 50; txid += 1) {
      source.emit({ kind: 'change', tags: [{ ...MEMBERSHIPS, keys: ['u1'] }], txid: String(txid) });
    }
    await commit('51', { ...POSTS, keys: [A] });
    // The post, after one re-check that kept the grant.
    const frame = await client.next();
    expect(frame?.kind === 'change' ? frame.tags : []).toContainEqual({ ...POSTS, scope: { name: 'org', keys: [A] } });
    expect(authorize).toHaveBeenCalledTimes(2);
  });

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
    // One per connect, one for the membership write; a replayed frame is no new write.
    expect(authorize).toHaveBeenCalledTimes(3);
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

  it('close() releases the endpoint: rebuilding on the same hub leaves one onChange subscription, and only it re-checks', async () => {
    const { hub, source, state } = await rig({ tables: [POSTS], scopes: { org: [A], user: ['u1'] } });
    let active = 0;
    const counted: typeof hub = {
      ...hub,
      onChange(listener) {
        active += 1;
        const off = hub.onChange(listener);
        return () => {
          active -= 1;
          off();
        };
      },
    };
    const build = (authorize: () => Promise<LiveGrant | null>) =>
      liveEndpoint({ hub: counted, manifest, scopes, authorize, reauthorize: [MEMBERSHIPS] });
    const firstAuthorize = vi.fn(() => Promise.resolve(state.grant));
    const secondAuthorize = vi.fn(() => Promise.resolve(state.grant));
    const first = build(firstAuthorize);
    first.close(); // hot reload: the old endpoint goes before its replacement is built
    const second = build(secondAuthorize);
    expect(active).toBe(1);
    const reader = sseReader(await second.fetch(new Request('http://live.test/api/live')));
    cleanups.push(() => reader.cancel());
    await reader.next();
    source.emit({ kind: 'change', tags: [{ ...MEMBERSHIPS, keys: ['u1'] }], txid: '1' });
    await sleep(5);
    expect(firstAuthorize).not.toHaveBeenCalled();
    expect(secondAuthorize).toHaveBeenCalledTimes(2); // its own open, then the re-check
    second.close();
    expect(active).toBe(0);
  });

  it('another user’s membership change causes no bye, no frame and no authorize on this stream', async () => {
    const { stream, commit, state, authorize } = await rig({ scopes: { org: [A], user: ['u1'] } });
    const client = await stream();
    await client.next();
    // Even if authorize would now answer differently: the write does not concern this principal.
    state.grant = { scopes: { org: [B], user: ['u1'] } };
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

/**
 * The request is held inside `hub.open`, after `authorize` resolved: `opening` says it got there, `release` lets it go
 * on. Barriers, not sleeps: the write lands in exactly that window.
 */
async function held(grant: LiveGrant) {
  const opening = deferred();
  const release = deferred();
  const live = await rig(grant, hub => ({
    ...hub,
    async open(options) {
      opening.resolve();
      await release.promise;
      return hub.open(options);
    },
  }));
  const response = live.request();
  await opening.promise;
  expect(live.authorize).toHaveBeenCalledTimes(1);
  /** Lets the stream open, and reads it. */
  const open = async (): Promise<SseReader> => {
    release.resolve();
    const answer = await response;
    expect(answer.status).toBe(200);
    const reader = sseReader(answer);
    cleanups.push(() => reader.cancel());
    return reader;
  };
  return { ...live, open };
}

describe('a reauthorize write while a stream opens (after authorize read the grant, before the stream can be re-checked)', () => {
  it('a revoking write: bye before any frame of the revoked org, not hello under the old grant and its changes', async () => {
    const { source, state, commit, open } = await held({ scopes: { org: [A], user: ['u1'] } });
    state.grant = { scopes: { org: [B], user: ['u1'] } }; // the membership in A is deleted
    source.emit({ kind: 'change', tags: [{ ...MEMBERSHIPS, keys: ['u1'] }], txid: '1' });
    const client = await open();
    await commit('2', { ...POSTS, keys: [A] });
    // Fail open would be hello with org A, then this post: the old grant served until maxAgeMs.
    expect(await until(client, 2)).toEqual([{ kind: 'bye' }]);
  });

  it('a write that changes nothing: one more authorize, no bye, and the frames flow', async () => {
    const { source, commit, authorize, open } = await held({ scopes: { org: [A], user: ['u1'] } });
    source.emit({ kind: 'change', tags: [{ ...MEMBERSHIPS, keys: ['u1'] }], txid: '1' });
    const client = await open();
    await commit('2', { ...POSTS, keys: [A] });
    expect(await until(client, 2)).toMatchObject([
      { kind: 'hello', scopes: { org: [A], user: ['u1'] } },
      { kind: 'change', tags: [{ ...POSTS, scope: { name: 'org', keys: [A] } }] },
    ]);
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it('no reauthorize write in the window: no extra authorize', async () => {
    const { commit, authorize, open } = await held({ scopes: { org: [A], user: ['u1'] } });
    await commit('1', { ...POSTS, keys: [B] }); // not a reauthorize table
    const client = await open();
    await commit('2', { ...POSTS, keys: [A] });
    expect(await until(client, 2)).toMatchObject([
      { kind: 'hello', scopes: { org: [A], user: ['u1'] } },
      { kind: 'change', tags: [{ ...POSTS, scope: { name: 'org', keys: [A] } }] },
    ]);
    expect(authorize).toHaveBeenCalledTimes(1);
  });
});

describe('close() fails closed', () => {
  it('an open stream gets bye, then ends: the client reconnects elsewhere instead of waiting', async () => {
    const { stream, close } = await rig({ scopes: { org: [A] } });
    const client = await stream();
    expect(await until(client, 1)).toMatchObject([{ kind: 'hello' }]);
    close();
    expect(await until(client, 2)).toEqual([{ kind: 'bye' }]);
  });

  it('a stream still opening when close() runs ends with bye and never serves a change unwatched', async () => {
    const { commit, close, open } = await held({ scopes: { org: [A], user: ['u1'] } });
    close(); // the re-check listener is gone: a stream joining now could never be revoked
    const client = await open();
    await commit('1', { ...POSTS, keys: [A] });
    const frames = await until(client, 3);
    expect(frames.some(frame => frame.kind === 'change')).toBe(false);
    expect(frames.at(-1)).toEqual({ kind: 'bye' });
  });
});
