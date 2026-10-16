# @arki/live

Live queries on your own Postgres. A procedure declares the tables it reads in its oRPC contract meta. A statement trigger publishes a hint at commit. A hub numbers those hints and feeds one stream per browser tab, and the client refetches the queries that read a changed table. Only table names travel; data always comes from a normal, authorized refetch.

This release covers milestones M0 to M2 of the lesson-01 plan: the wire schemas, the hub, `live()` meta, `snapshot()` and `liveRead()`, the Postgres source, the SSE endpoint and the Dot plugin. The React provider builds on it.

## The guarantees

| Name                   | Promise                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Committed-write hint   | A tracked statement publishes only if its transaction commits. False positives are allowed.                            |
| One snapshot per query | All reads through one `liveRead()` call's readers run in one `REPEATABLE READ READ ONLY` transaction.                  |
| Safe reconnect         | After any reconnect the client has replayed every missed hint, or it resets (refetches every live query).              |
| Bounded memory         | The replay ring and every stream queue are bounded. Overload becomes `bye` and a reconnect, never unbounded buffering. |

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

The hub is portable (no Postgres code). A source reports `ready`, `gap` and `change`; every stream gets `begin` (resume or reset), then numbered `change` frames.

```ts run
import { createLiveHub } from '@arki/live';
import { fakeSource } from '@arki/live/testing';

const source = fakeSource();
const hub = createLiveHub({ source, limits: { batchMs: 5 } });
await hub.start();
source.emit({ kind: 'ready' });

const stream = hub.open({ signal: AbortSignal.timeout(5000) })[Symbol.asyncIterator]();
const begin = await stream.next();
if (begin.value?.kind !== 'begin' || begin.value.mode !== 'reset') throw new Error('a first connect resets');

source.emit({ kind: 'change', tags: [{ schema: 'public', table: 'posts' }] });
const change = await stream.next();
if (change.value?.kind !== 'change' || change.value.tags[0]?.table !== 'posts')
  throw new Error('expected a change frame');
await hub.stop();
```

Each `change` frame also carries `txids`: the Postgres transaction ids (`pg_current_xact_id()`) of the commits behind it, as decimal strings, because an `xid8` can pass `Number.MAX_SAFE_INTEGER`. A frame names exactly the commits that wrote one of its own tables, each once; a transaction that wrote tables on two frames of a split batch is on both. A client will use this to wait for its own write (`awaitTxId`, coming); today it is informative only. Hints from a source without txids carry `txids: []`.

Reset rules: a cursor of the current epoch still in the ring resumes and replays the missed frames. No cursor, another epoch (a listener gap or a restart), an evicted cursor or one from the future resets. A listener gap ends every stream with `gap`.

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

What the endpoint does, in order, before any stream header: a malformed or repeated `cursor` answers 400 E004; `authorize` returning `null` answers 401 E005; a hub without its listener answers 503 E003 with `retry-after`. Then `hello` with the part of the manifest the grant allows (the procedures whose every table is granted), and `change` frames cut down to the granted tables. A frame keeps only the `txids` of transactions that wrote a granted table, and **a frame with no granted table is skipped whole**, so a client never learns that, or how often, a table it cannot read is written. After `maxAgeMs` (default 5 minutes) the stream sends `bye` and ends, and the client reconnects and is authorized again.

Try it by hand (the demo test `src/tests/demo.pg.test.ts` does the same against Postgres 16 and 17):

```sh
curl -N -H 'authorization: Bearer demo' http://localhost:3000/api/live
# data: {"kind":"hello","v":1,"mode":"reset","cursor":"k3v9….0","manifest":[…]}

psql "$DB_URL" -c "insert into posts values ('p1', 'Hello')"
# data: {"kind":"change","cursor":"k3v9….1","tags":[{"schema":"public","table":"posts"}],"txids":["748"]}

psql "$DB_URL" -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'blog_listener'"
# data: {"kind":"gap"}   then the stream ends; the next connect is a reset (new epoch)
```

## Limits

`batchMs` 20, `replayFrames` 4096, `replayMs` 120 000, `subscriberFrames` 256, 256 tags and 256 txids per frame (a window that reaches 256 transactions flushes at once), identifiers of at most 63 bytes.

## Errors

| Code             | Meaning                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `ARKI_LIVE_E001` | Bad meta or options; `liveRead()` on a procedure without live meta; `snapshot()` given a transaction. |
| `ARKI_LIVE_E002` | Missing, disabled or incompatible triggers.                                                           |
| `ARKI_LIVE_E003` | The hub is not ready (its listener is unavailable or it stopped).                                     |
| `ARKI_LIVE_E004` | A malformed cursor, frame or payload.                                                                 |
| `ARKI_LIVE_E005` | 401/403 on the stream.                                                                                |
| `ARKI_LIVE_E006` | A bounded resource was reached.                                                                       |

Every error has `code` and `remediation`.
