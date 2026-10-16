# @arki/live

Live queries on your own Postgres. A procedure declares the tables it reads in its oRPC contract meta. A statement trigger publishes a hint at commit. A hub numbers those hints and feeds one stream per browser tab, and the client refetches the queries that read a changed table. Only table names travel; data always comes from a normal, authorized refetch.

This release covers milestones M0 to M3 of the lesson-01 plan: the wire schemas, the hub, `live()` meta, `snapshot()` and `liveRead()`, the Postgres source, the SSE endpoint, the Dot plugin, the stream client and the React provider.

## The guarantees

| Name                   | Promise                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Committed-write hint   | A tracked statement publishes only if its transaction commits. False positives are allowed.                                          |
| Live updates           | While connected, authorized and with complete declarations, every active live query refetches after a commit to a table it declares. |
| One snapshot per query | All reads through one `liveRead()` call's readers run in one `REPEATABLE READ READ ONLY` transaction.                                |
| Safe reconnect         | After any reconnect the client has replayed every missed hint, or it resets (refetches every live query).                            |
| Bounded memory         | The replay ring and every stream queue are bounded. Overload becomes `bye` and a reconnect, never unbounded buffering.               |

Not promised: two queries agreeing with each other, ordering between tables inside one batch, exactly-once hints.

## Declare what a procedure reads

```ts
import { oc } from '@orpc/contract';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { LiveMeta } from '@arki/live';
import { live } from '@arki/live/drizzle';

const posts = pgTable('posts', { id: text('id').primaryKey(), title: text('title').notNull() });
const contract = oc.$meta<LiveMeta>({});

export const postsContract = contract.router({
  list: contract.meta(live({ reads: [posts] })).output(z.array(z.object({ id: z.string(), title: z.string() }))),
  create: contract.input(z.object({ title: z.string() })).output(z.object({ id: z.string() })), // no meta: never live
});
```

## One snapshot per query

`snapshot(db, bind)` opens one read-only repeatable-read transaction per call and binds your readers to it. `liveRead()` runs the rest of the oRPC chain inside it and puts the readers on `context.liveRead`. Without it, each statement of a handler gets its own snapshot.

```ts continue
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { implement } from '@orpc/server';
import { sql } from 'drizzle-orm';

import { snapshot } from '@arki/live/drizzle';
import { liveRead } from '@arki/live/orpc';

type Ctx = { readonly db: NodePgDatabase };
const impl = implement(postsContract).$context<Ctx>();
const reader = (db: Pick<NodePgDatabase, 'execute'>) => ({
  count: async () => (await db.execute<{ n: number }>(sql`select count(*)::int as n from posts`)).rows[0]?.n ?? 0,
});

export const list = impl.list
  .use(liveRead((context: Ctx) => snapshot(context.db, reader)))
  .handler(async ({ context }) => ((await context.liveRead.count()) === 0 ? [] : [{ id: 'p1', title: 'One' }]));
```

## The hub

The hub is portable (no Postgres code) but needs WebCrypto (`crypto.subtle`: Node 20+, Bun, Deno, a browser's secure context); `start()` rejects with E001 without it. A source reports `ready`, `gap` and `change`; every stream gets `begin` (resume or reset), then `change` frames, each with a cursor.

```ts run
import { createLiveHub } from '@arki/live';
import { fakeSource } from '@arki/live/testing';

const source = fakeSource();
const hub = createLiveHub({ source, limits: { batchMs: 5 } });
await hub.start();
source.emit({ kind: 'ready' });

const feed = await hub.open({ signal: AbortSignal.timeout(5000) });
const stream = feed[Symbol.asyncIterator]();
const begin = await stream.next();
if (begin.value?.kind !== 'begin' || begin.value.mode !== 'reset') throw new Error('a first connect resets');

source.emit({ kind: 'change', tags: [{ schema: 'public', table: 'posts' }] });
const change = await stream.next();
if (change.value?.kind !== 'change' || change.value.tags[0]?.table !== 'posts')
  throw new Error('expected a change frame');
await hub.stop();
```

Each `change` frame also carries `txids`: the Postgres transaction ids (`pg_current_xact_id()`) of the commits behind it, as decimal strings, because an `xid8` can pass `Number.MAX_SAFE_INTEGER`. A frame names exactly the commits that wrote one of its own tables, each once; a transaction that wrote tables on two frames of a split batch is on both. A client waits for its own write with `awaitTxId` (below). Hints from a source without txids carry `txids: []`.

Cursors are opaque. Inside the hub a position is its epoch and frame number; on the wire it is sealed with AES-GCM under a key the hub makes at `start()`, with a fresh random IV every time. Every cursor is 64 base64url characters, two cursors for one position differ, and none can be read. Keep it as a string.

Reset rules: a cursor this hub sealed, of the current epoch and still in the ring, resumes and replays the missed frames. No cursor, a cursor the hub cannot open (another hub's or replica's, changed, from before a restart), another epoch (a listener gap), or an evicted position resets. A listener gap ends every stream with `gap`.

`hub.cursor()` gives the current position as a new cursor (or `undefined` while the hub is not ready). It reads the position when called, so a server that calls it before reading a page's data can hand it to the client, and the client replays every commit since (see Server rendering).

## Serve the stream

`liveEndpoint` serves `GET /api/live` as server-sent events. Give the hub a pool of its own: the listener holds one client for as long as it runs.

```ts
import { oc } from '@orpc/contract';
import pg from 'pg';
import { z } from 'zod';

import type { LiveMeta } from '@arki/live';
import { listen } from '@arki/http';
import { createLiveHub, live } from '@arki/live';
import { liveEndpoint } from '@arki/live/http';
import { liveManifest } from '@arki/live/orpc';
import { pgSource } from '@arki/live/pg';

const contract = oc.$meta<LiveMeta>({});
const posts = { schema: 'public', table: 'posts' };
const appContract = { posts: { list: contract.meta(live({ reads: [posts] })).output(z.array(z.string())) } };

const listenPool = new pg.Pool({ connectionString: process.env.DB_URL, max: 1, application_name: 'blog_listener' });
const hub = createLiveHub({ source: pgSource({ pool: listenPool, app: 'blog' }) });
await hub.start(); // rejects when the first LISTEN fails

const endpoint = liveEndpoint({
  hub,
  manifest: liveManifest(appContract),
  // null answers 401. `{ tables }` limits what this client sees; `{}` is every manifest table.
  authorize: request => Promise.resolve(request.headers.get('authorization') === 'Bearer demo' ? {} : null),
});
await listen(endpoint.fetch, { port: 3000 });
```

In a TanStack Start route: `GET: ({ request }) => endpoint.fetch(request)` in `routes/api/live.ts`. In a Dot app, `liveQueries` from `@arki/live/dot` does all of this: it checks the triggers at boot (E002), listens at start, sends `bye` and gives the client back at stop, and publishes the bundle as `liveRoutes` for `http({ bundles: [liveQ.provides.liveRoutes] })`. Declare it after `dbMigrations` and before `http()`.

What the endpoint does, in order, before any stream header: a malformed or repeated `cursor` answers 400 E004 (a well-formed cursor the hub cannot open is not an error: the stream starts with a reset); `authorize` returning `null` answers 401 E005; a hub without its listener answers 503 E003 with `retry-after`. Then `hello` with the part of the manifest the grant allows (the procedures whose every table is granted), and `change` frames cut down to the granted tables. A frame keeps only the `txids` of transactions that wrote a granted table, and **a frame with no granted table is skipped whole**. Because cursors are opaque, a client cannot count the frames it was not sent either. What it can still see is the timing of the frames it does get: a hidden write that lands in the same batch window as a visible one is merged into that frame without a trace, but the stream as a whole shows only when visible tables changed. After `maxAgeMs` (default 5 minutes) the stream sends `bye` and ends, and the client reconnects and is authorized again.

Try it by hand (the demo test `src/tests/demo.pg.test.ts` does the same against Postgres 16 and 17):

```sh
curl -N -H 'authorization: Bearer demo' http://localhost:3000/api/live
# data: {"kind":"hello","v":1,"mode":"reset","cursor":"q8Zt…(64 characters)","manifest":[…]}

psql "$DB_URL" -c "insert into posts values ('p1', 'Hello')"
# data: {"kind":"change","cursor":"Vb3K…(64 characters)","tags":[{"schema":"public","table":"posts"}],"txids":["748"]}

psql "$DB_URL" -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'blog_listener'"
# data: {"kind":"gap"}   then the stream ends; the next connect is a reset (new epoch)
```

## Use it in React

`LiveProvider` opens one stream per tab (in an effect, so never on the server) inside your `QueryClientProvider`. `useLiveQuery` takes the query options oRPC builds; input, output, error and `select` types all come from oRPC and TanStack.

```tsx
import type { ContractRouterClient } from '@orpc/contract';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { oc } from '@orpc/contract';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { z } from 'zod';

import type { LiveMeta } from '@arki/live';
import { live } from '@arki/live';
import { LiveProvider, useLiveQuery, useLiveStatus } from '@arki/live/react';

const contract = oc.$meta<LiveMeta>({});
const posts = { schema: 'public', table: 'posts' };
const Post = z.object({ id: z.string(), title: z.string() });
const appContract = {
  posts: {
    list: contract
      .meta(live({ reads: [posts] }))
      .input(z.object({ page: z.int() }))
      .output(z.array(Post)),
    create: contract.input(z.object({ title: z.string() })).output(z.object({ id: z.string(), txid: z.string() })),
  },
};
const client: ContractRouterClient<typeof appContract> = createORPCClient(
  new RPCLink({ url: 'http://localhost:3000/rpc' }),
);
const orpc = createTanstackQueryUtils(client);
const queryClient = new QueryClient();

function Posts() {
  const list = useLiveQuery(orpc.posts.list.queryOptions({ input: { page: 1 } }));
  const status = useLiveStatus(); // 'connecting' | 'live' | 'reconnecting' | 'unauthorized' | 'closed'
  if (list.isPending) return <p>Loading…</p>;
  return (
    <ul data-live={status}>
      {list.data?.map(post => (
        <li key={post.id}>{post.title}</li>
      ))}
    </ul>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LiveProvider url="/api/live">
        <Posts />
      </LiveProvider>
    </QueryClientProvider>
  );
}
```

What the provider does with each frame: `hello` with `reset` invalidates every live path (`[path]` matches every input of a procedure); `change` invalidates the paths whose tables changed; the cursor is saved after that. On `bye` it reconnects at once with the cursor; on `gap`, a dropped connection or a 5xx it backs off (250 ms doubling to 10 s, jittered; a 503 waits at least its `retry-after`), and `online` or the page becoming visible ends the wait. On 401/403 it stops (`unauthorized`) until the `headers` function changes. A new `headers` function while live does not reconnect: the latest one is read before each connect.

Rules `useLiveQuery` adds to `useQuery`, each for a bug plain invalidation has:

- **A hint during a first fetch is not lost.** TanStack Query does not cancel a query's first fetch, and that fetch's success clears the invalidated flag. The provider marks such a query and refetches it once after that fetch succeeds.
- **401/403 never loops.** It is not retried, and a live query that fails with 401/403 while it still holds data is reset once (its data dropped). The reset's own refetch fails with no data left, so it stops there.
- **No `initialData`** (a type error): a reset would bring it back after a 401. Use `placeholderData`.
- **A narrower grant drops data.** Paths that leave the manifest on a new `hello` are removed from the cache.
- **A procedure that is not live warns.** The types cannot reject `useLiveQuery(orpc.posts.create.queryOptions(…))`: oRPC gives every procedure query options. After `hello`, a hook whose path is not in the manifest logs E001 once (`arki:live:react`).

If the utils were built with a `path` prefix, pass it as `keyPrefix`. One provider per `QueryClient`: a second logs E001.

### Wait for your own write

A mutation that returns its transaction's id (`select pg_current_xact_id()::text`, inside the same transaction) can wait until the hint for it arrived, so the cache is refetching by the time the mutation settles:

```tsx continue
import { useMutation } from '@tanstack/react-query';

import { awaitTxId } from '@arki/live/react';

export function NewPost() {
  const create = useMutation({
    ...orpc.posts.create.mutationOptions(),
    onSuccess: ({ txid }) => awaitTxId(queryClient, txid, { timeoutMs: 5000 }),
  });
  return (
    <button disabled={create.isPending} onClick={() => create.mutate({ title: 'Hello' })}>
      Post
    </button>
  );
}
```

`awaitTxId` resolves when a `change` frame names the txid (also when one already did, among the last 1024) or a reset refetched every live query; it rejects with E006 after `timeoutMs` (default 10 000) and with E001 when no provider is mounted for that client.

### TanStack DB

TanStack DB's own query collection works on the same options, so the provider's invalidation refreshes it too. No `@arki/live` code is involved:

```tsx continue
import { createCollection } from '@tanstack/db';
import { queryCollectionOptions } from '@tanstack/query-db-collection';

export const firstPage = createCollection(
  queryCollectionOptions({
    ...orpc.posts.list.queryOptions({ input: { page: 1 } }),
    queryClient,
    getKey: post => post.id,
  }),
);
```

A query collection treats one response as the whole set, so each input (page) is its own collection.

### Server rendering

Without a cursor the first connect is a reset, which refetches every hydrated live query once. To skip that, read the hub's cursor on the server **before** the page's data and dehydrate it with the page:

```ts
import type { QueryClient } from '@tanstack/react-query';
import { dehydrate } from '@tanstack/react-query';

import type { LiveHub } from '@arki/live';
import { setLiveCursor } from '@arki/live/react';

export async function dehydratePage(hub: LiveHub, queryClient: QueryClient, load: () => Promise<void>) {
  setLiveCursor(queryClient, await hub.cursor()); // first: every commit after it is replayed to the client
  await load();
  return dehydrate(queryClient);
}
```

The provider connects with that cursor. The hub resumes when the client reaches the same hub (the same replica, the same listener epoch, still in the ring) and replays any commit since the cursor; anything else resets, which is safe. In TanStack Start, call `hub.cursor()` from a server function in the root route's loader on the server only, before the child loaders run, with `setupRouterSsrQueryIntegration` dehydrating the query client. Hydrated data is refetched only if a commit came after the cursor, as long as `staleTime` keeps it fresh on mount.

### Testing

`waitForInvalidation(queryClient, ['posts', 'list'])` from `@arki/live/testing` resolves when a query of that path is invalidated (E006 after the timeout). Call it before the write.

## Limits

`batchMs` 20, `replayFrames` 4096, `replayMs` 120 000, `subscriberFrames` 256, 256 tags and 256 txids per frame (a window that reaches 256 transactions flushes at once), identifiers of at most 63 bytes.

## Errors

| Code             | Meaning                                                                                                                                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARKI_LIVE_E001` | Bad meta or options; `liveRead()` on a procedure without live meta; `snapshot()` given a transaction; a hub without WebCrypto; a hook outside `LiveProvider`, a second provider, or a hook path not in the manifest. |
| `ARKI_LIVE_E002` | Missing, disabled or incompatible triggers.                                                                                                                                                                          |
| `ARKI_LIVE_E003` | The hub is not ready (its listener is unavailable or it stopped).                                                                                                                                                    |
| `ARKI_LIVE_E004` | A malformed cursor, frame or payload; a `fetch` with no streaming body (the client stops).                                                                                                                           |
| `ARKI_LIVE_E005` | 401/403 on the stream.                                                                                                                                                                                               |
| `ARKI_LIVE_E006` | A bounded resource was reached; `awaitTxId` or `waitForInvalidation` timed out.                                                                                                                                      |

Every error has `code` and `remediation`.
