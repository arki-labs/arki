# @arki/live

Live queries on your own Postgres. A procedure declares the tables it reads in its oRPC contract meta. A statement trigger publishes a hint at commit. A hub numbers those hints and feeds one stream per browser tab, and the client refetches the queries that read a changed table. Only table names travel; data always comes from a normal, authorized refetch.

This release is the correctness core (milestone M0 of the lesson-01 plan): the wire schemas, the hub, `live()` meta, `snapshot()` and `liveRead()`. The Postgres source, the SSE endpoint, the Dot plugin and the React provider build on it.

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

Reset rules: a cursor of the current epoch still in the ring resumes and replays the missed frames. No cursor, another epoch (a listener gap or a restart), an evicted cursor or one from the future resets. A listener gap ends every stream with `gap`.

## Limits

`batchMs` 20, `replayFrames` 4096, `replayMs` 120 000, `subscriberFrames` 256, 256 tags per frame, identifiers of at most 63 bytes.

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
