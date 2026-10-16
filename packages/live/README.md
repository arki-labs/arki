# @arki/live

Live queries on your own Postgres. A procedure declares the tables it reads in its oRPC contract meta. A statement trigger publishes a hint at commit. A hub numbers those hints and feeds one stream per browser tab, and the client refetches the queries that read a changed table. Only table names travel; data always comes from a normal, authorized refetch.

This release covers milestones M0 to M4 of the lesson-01 plan: the wire schemas, the hub, `live()` meta, `snapshot()` and `liveRead()`, the Postgres source, the SSE endpoint, the Dot plugin, the stream client and the React provider, proven by a failure matrix on Postgres 16 and 18, a browser run on a TanStack Start app, and contract-checked benchmarks.

## The guarantees

| Name                      | Promise                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Committed-write hint      | A tracked statement publishes only if its transaction commits. False positives are allowed.                                                                                                                                                         |
| Live updates              | While connected, authorized and with complete declarations, every active live query refetches after a commit to a table it declares.                                                                                                                |
| One snapshot per query    | All reads through one `liveRead()` call's readers run in one `REPEATABLE READ READ ONLY` transaction.                                                                                                                                               |
| Safe reconnect            | After any reconnect the client has replayed every missed hint, or it resets (refetches every live query).                                                                                                                                           |
| Hidden writes stay hidden | Writes to tables a client may not see change nothing it can observe: its frames, their size and timing, its receipts, cursors and queue, its `bye`, and whether it resumes or resets. One exception: an overloaded hub resets every client at once. |
| Bounded memory            | The replay ring keeps `replayMs` of hints under a hard cap; every stream queue is bounded. Overload becomes a reconnect, never unbounded buffering.                                                                                                 |

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

Each `change` frame also carries `txids`: the **receipts** of the commits behind it, never their Postgres transaction ids. A raw `pg_current_xact_id()` is one counter for the whole database, so the gap between two ids would tell a client how many transactions ran in between, on tables it may not read. A receipt is `base64url(HMAC-SHA256(secret, "arki-live/v1|" + app + "|" + xid8))` cut to 22 characters: one length, no order, nothing to subtract. Give the hub `receipts: liveReceipts({ app, secret })`. The secret comes from the app config, has at least 32 characters, and is the same on every instance of the app, like a session secret (make one with `openssl rand -base64 32`). `liveReceipts` throws E001 for a shorter secret or without WebCrypto. A hub without `receipts`, or a source without txids, sends `txids: []`. A frame names exactly the commits that wrote one of its own tables, each once; a transaction that wrote tables on two frames of a split window is on both. A client waits for its own write with `awaitTxId` (below).

Cursors are opaque. Inside the hub a position is its epoch, its hint number and the time it was taken; on the wire it is sealed with AES-GCM under a key the hub makes at `start()`, with a random IV. Every cursor is 75 base64url characters and none can be read. Streams whose windows close at the same position share one sealed cursor (one AES-GCM call, not one per client); `begin` cursors and `hub.cursor()` are sealed fresh each time. Keep it as a string.

Every source change is one hint in the ring. Each stream sees the hints through its grant and batches the visible ones in its own window: the first visible hint opens a `batchMs` window, and when it closes (or holds 256 transactions) the stream gets the window's tables unioned, 256 per frame. A frame's cursor is the hub's position when its window closed.

Reset rules: a cursor this hub sealed, of the current epoch and at most `replayMs` old, resumes and replays the missed hints through the stream's grant and windows, timed by when each hint arrived: the stream gets the frames it would have got had it stayed connected. The ring evicts by that same age, and every hint after a cursor arrived after the cursor was taken, so every hint a young cursor needs is still there. No cursor, a cursor the hub cannot open (another hub's or replica's, changed, from before a restart), another epoch (a listener gap) or an older cursor resets. The decision depends on the cursor's age alone, never on how many hints passed: hints of tables a client cannot see count too, so a count would tell it they happened.

Two things end every stream with `gap`: a listener gap, and an overload. `replayFrames` is a hard cap on the ring (in hints: one per table per commit), not an eviction: a ring that reaches it starts a new epoch, so every client resets together. That reveals only "the hub was overloaded", the same to everyone. It is logged at warn (`arki:live:hub`, with the cap, the hints held and the streams). Size the cap above the peak hint rate times `replayMs`. The default, 262 144, covers about 2 000 hints per second for 120 s; a hotter app shortens `replayMs` or raises the cap.

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

What the endpoint does, in order, before any stream header: a malformed or repeated `cursor` answers 400 E004 (a well-formed cursor the hub cannot open is not an error: the stream starts with a reset); `authorize` returning `null` answers 401 E005; a hub without its listener answers 503 E003 with `retry-after`. Then `hello` with the part of the manifest the grant allows (the procedures whose every table is granted), and `change` frames of the granted tables only. The endpoint passes the grant into `hub.open({ grant })`, and the hub applies it to every hint **before** the stream's own batch window, queue and frame split. A hint with no granted table never reaches the stream: it opens no window, takes no queue slot, and counts toward neither the 256-transaction flush nor `subscriberFrames`. A frame names only the receipts of transactions that wrote a granted table. Because cursors are opaque, a client cannot count the hints it was not sent either. So hidden writes change nothing a stream shows: not its frames, not their timing, not its `bye`. After `maxAgeMs` (default 5 minutes) the stream sends `bye` and ends, and the client reconnects and is authorized again.

Try it by hand (the demo test `src/tests/demo.pg.test.ts` does the same against Postgres 16 and 18):

```sh
curl -N -H 'authorization: Bearer demo' http://localhost:3000/api/live
# data: {"kind":"hello","v":1,"mode":"reset","cursor":"q8Zt…(75 characters)","manifest":[…]}

psql "$DB_URL" -c "insert into posts values ('p1', 'Hello')"
# data: {"kind":"change","cursor":"Vb3K…(75 characters)","tags":[{"schema":"public","table":"posts"}],"txids":["Qm3x…(22 characters)"]}

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
    create: contract.input(z.object({ title: z.string() })).output(z.object({ id: z.string(), receipt: z.string() })),
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

What the provider does with each frame: `hello` with `reset` invalidates every live path (`[path]` matches every input of a procedure); `change` invalidates the paths whose tables changed; the cursor is saved after that. On `bye` it reconnects at once with the cursor; on `gap`, a dropped connection or a 5xx it backs off (250 ms doubling to 10 s, jittered; a 503 waits at least its `retry-after`), and `online` or the page becoming visible ends the wait. On 401/403 it stops (`unauthorized`) until the `headers` function changes. A new `headers` function while live does not reconnect: the latest one is read before each connect. A connection can die without a close (Wi-Fi gone, a NAT that forgot it); the server sends a keepalive every 15 s, so a read that gets no byte for 35 s drops the connection and backs off, and in a browser `offline` drops it at once.

Rules `useLiveQuery` adds to `useQuery`, each for a bug plain invalidation has:

- **A hint during a first fetch is not lost.** TanStack Query does not cancel a query's first fetch, and that fetch's success clears the invalidated flag. The provider marks such a query and refetches it once after that fetch succeeds.
- **401/403 never loops.** It is not retried, and a live query that fails with 401/403 while it still holds data is reset once (its data dropped). The reset's own refetch fails with no data left, so it stops there.
- **No `initialData`** (a type error): a reset would bring it back after a 401. Use `placeholderData`.
- **A narrower grant drops data.** Paths that leave the manifest on a new `hello` are removed from the cache.
- **A procedure that is not live warns.** The types cannot reject `useLiveQuery(orpc.posts.create.queryOptions(…))`: oRPC gives every procedure query options. After `hello`, a hook whose path is not in the manifest logs E001 once (`arki:live:react`).

If the utils were built with a `path` prefix, pass it as `keyPrefix`. One provider per `QueryClient`: a second logs E001.

### Wait for your own write

A mutation that returns the receipt of its own transaction can wait until the hint for it arrived, so the cache is refetching by the time the mutation settles. On the server, read `select pg_current_xact_id()::text` inside the writing transaction and return `{ id, receipt: await receipts.of(txid) }`, with the same `receipts` the hub has. Never return the raw id: it is the database-wide counter.

```tsx continue
import { useMutation } from '@tanstack/react-query';

import { awaitTxId } from '@arki/live/react';

export function NewPost() {
  const create = useMutation({
    ...orpc.posts.create.mutationOptions(),
    onSuccess: ({ receipt }) => awaitTxId(queryClient, receipt, { timeoutMs: 5000 }),
  });
  return (
    <button disabled={create.isPending} onClick={() => create.mutate({ title: 'Hello' })}>
      Post
    </button>
  );
}
```

`awaitTxId` resolves when a `change` frame names the receipt (also when one already did, among the last 1024) or a reset refetched every live query; it rejects with E006 after `timeoutMs` (default 10 000) and with E001 when no provider is mounted for that client.

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

### Sign-out and account switch

The stream is authorized when it connects and again every `maxAgeMs`, not on every frame. So when the account changes, remount the provider for the new one (`key`) and reset the queries. The reset drops the old account's data and cancels its fetches still in flight; the remount closes the old stream, whose grant was the old account's.

```tsx
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { LiveProvider } from '@arki/live/react';

const queryClient = new QueryClient();

export function SignedInApp({ userId, children }: { readonly userId: string | null; readonly children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <LiveProvider key={userId ?? 'signed-out'} url="/api/live">
        {children}
      </LiveProvider>
    </QueryClientProvider>
  );
}

export async function switchAccount(signIn: () => Promise<void>) {
  await signIn();
  await queryClient.resetQueries();
}
```

Without the remount the old stream keeps the old grant's table hints until `maxAgeMs`. `src/tests/session.pg.test.ts` proves the recipe with a fetch in flight and an `@arki/offline` write queued by the old account (it is dead-lettered, never sent).

### Testing

`waitForInvalidation(queryClient, ['posts', 'list'])` from `@arki/live/testing` resolves when a query of that path is invalidated (E006 after the timeout). Call it before the write.

To install the triggers in a test database, run the migration SQL: `await pglite.exec(liveMigration({ app, tables }).up)`, or `db.execute(sql.raw(…))` with Drizzle. (`/testing` has no `applyLiveTriggers`: it must load with no peer installed, and building a Drizzle `SQL` value needs `drizzle-orm` at run time.)

## Write paths

Every write that commits through Postgres publishes: a journal command, a repository, raw SQL, a queue worker, a `psql` session. The trigger is a statement trigger on insert, update, delete and truncate, so a statement that touches no row still publishes (a false positive, allowed). Partitioned tables need the trigger on every leaf; `verifyLiveTriggers` reports a leaf without one. What no trigger sees — a view, a materialized-view refresh, a table you chose not to track — is published by hand with `touch(tx, app, tag)` in the writing transaction.

## Security

- The stream needs `authorize`. It decides which tables a client gets hints for; every refetch is still authorized by its procedure, so a hint never carries data.
- A hint tells its receiver that a table changed, and when. On a table shared by tenants, any client granted it sees the activity of every tenant on it. Grant only what the client's procedures read.
- Hidden writes stay hidden (the guarantee above). The grant applies before each stream's batch window, queue and frame split, so a stream's frames, their size and timing, its `bye`, its receipts, its cursors and its resume-or-reset do not depend on them; only a global overload reset does. What remains is machine-level: hidden load slows the same hub and database.
- Frames and mutations carry receipts, not transaction ids: an HMAC under the app's secret, so a client cannot read the database-wide transaction counter or count the transactions between two it saw. Keep the secret like a session secret, the same on every instance; a new secret only makes `awaitTxId` calls in flight time out. Two clients who compare their receipts can tell that one transaction wrote tables both of them see.
- Revocation: data stops at the next refetch (a 401/403 resets the query once); the stream itself is refused at its next reconnect, at most `maxAgeMs` (5 min) later. On sign-out or an account switch, follow the recipe above.

## Operations

- Give the listener its own pool of one connection. It holds that client while it runs.
- Reads must hit the primary: a replica can lag behind the hint that made the client refetch.
- The listen session never sits in a long transaction: Postgres delivers notifications between transactions.
- Declare the tables a procedure's answer depends on, auth tables included (memberships, roles). Do not declare per-request tables (sessions, counters): they would refetch on every request. Revocation is covered by the refetch and `maxAgeMs`.
- Proxies must stream: `@arki/http` sends `x-accel-buffering: no` and a 15 s heartbeat (under Cloudflare's 100 s idle cap).
- Watch `select pg_notification_queue_usage()`. A listener that stops reading lets the queue fill, and a full queue fails commits that notify.
- Postgres 14 or later (tested on 16 and 18).

## When to use Electric, Zero or PowerSync instead

`@arki/live` refetches: each commit to a table makes every live query that reads it ask the server again. That is simple and safe (any SQL, auth stays in the procedure, nothing to run beside Postgres), and its cost grows with clients × queries × writes. Table-level hints also refetch every input of a procedure, so many tenants on one hot table cost more origin queries per commit than slow polling would.

| Pick                                              | When                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Electric (with TanStack DB's Electric collection) | Many clients watch the same hot rows and refetch cost dominates. You want row-level sync and can run logical replication (`wal_level=logical`) and the Electric service. |
| Zero                                              | You want client-side incremental queries over a local replica (instant filters and sorts over many rows), and accept its schema and permission model.                    |
| PowerSync                                         | The app must read and edit relational data offline for long periods (durable local SQLite), with a sync service. Short offline writes are `@arki/offline`'s queue.       |
| `@arki/live`                                      | Online screens over any SQL and aggregates, auth in your procedures, your own Postgres, PGlite in tests, no extra service.                                               |

## Limits

`batchMs` 20, `replayMs` 120 000 (the age up to which a cursor resumes), `replayFrames` 262 144 (the overload cap, in hints), `subscriberFrames` 256, 256 tags and 256 txids per frame (a window that reaches 256 transactions flushes at once), identifiers of at most 63 bytes. A stream that receives no byte for 35 s is dropped by the client.

## Tests

- `bun run test`: unit tests, PGlite, and Postgres 16 and 18 through testcontainers (Docker). The failure matrix (`src/tests/failure.pg.test.ts`) has one test per named scenario: commits around `LISTEN`, reverse commit order, rollback, listener gap, replica switch, server restart, cursor expiry and overload, slow subscriber, untracked table, pool exhaustion, a listen connection that ends cleanly. Barriers, not sleeps.
- `bun run test:e2e`: Playwright on a TanStack Start app (`e2e/app`) with real Postgres: two tabs, a network loss, a server restart.
- `bun run test:runtimes -- --require-all`, `bun run test:peers` (every entry with its optional peers absent), `bun run test:pack` (the tarball).
- `examples/dot.ts`, a Dot app with live queries, is compiled by `bun run typecheck`.

<!-- bench:start -->

## Benchmarks

Numbers pending an idle publish run (`bun run bench --profile publish --write-readme`); none is recorded yet.

What `bench/live.bench.ts` measures, each case checked against its contract before it is timed:

- Fan-out: one commit to 1, 100 and 1 000 streams, cursor sealing included, at the hub and through the endpoint and client. The overload cap is never reached.
- A reconnect storm: 1 000 streams resuming from one cursor.
- Freshness per strategy (deterministic counts): origin queries per commit, wasted fetches, staleness, for live queries, a TanStack DB query collection, invalidate-everything and `refetchInterval` polling, on 20 and 200 tenants with a hot table.
- Writer overhead on PGlite: single-row, bulk and multi-table commits with and without the triggers.

Not measured: an Electric collection (it needs logical replication and the Electric service) and a parser race against `@microsoft/fetch-event-source` (not in the workspace catalog).
<!-- bench:end -->

## Where this differs from the plan

- Plan § 5 steps 5 and 7 bound the ring by count and age and reset an "evicted" cursor. The hub evicts by age only and decides resume or reset by the cursor's age; `replayFrames` is an overload cap that starts a new epoch (see Reset rules).
- Plan § 5 step 8: the `bye` at `maxAgeMs` comes from `liveEndpoint`, and a slow subscriber's `bye` from the hub; an overload ends streams with `gap`, not `bye`. The client also closes a connection that sent nothing for 35 s.
- Plan § 3 lists `applyLiveTriggers` in `/testing`; it is not shipped (see Testing).

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
