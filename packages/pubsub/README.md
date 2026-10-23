# @arki/pubsub

Publish and subscribe on named channels, with one contract and a dedicated integration per backend: memory, Postgres LISTEN/NOTIFY, SQLite (a polled table) and Redis. Import the one you use. Delivery is best effort, like NOTIFY. It is not a queue: nothing is stored for a subscriber that was not listening.

## Usage

```ts run
import { memoryPubSub } from '@arki/pubsub/memory';

const pubsub = memoryPubSub();
const received: string[] = [];
const unsubscribe = await pubsub.subscribe('pizza_ready', payload => received.push(payload));

await pubsub.publish('pizza_ready', 'ord_42');
await new Promise(resolve => setTimeout(resolve, 0));
if (received[0] !== 'ord_42') throw new Error('not delivered');

await unsubscribe();
await pubsub.close();
```

## Integrations

| Entry                 | Factory                                                | `publishIn` | How                                                                                                                                 |
| --------------------- | ------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@arki/pubsub/memory` | `memoryPubSub()`                                       | no          | In-process fan-out. Tests and one-process apps.                                                                                     |
| `@arki/pubsub/pg`     | `pgPubSub({ pool })`                                   | yes         | `pg_notify` and `LISTEN`. Needs a session pool, never a transaction pooler; on a pooled host use `sessionPool` from `@arki/db/dot`. |
| `@arki/pubsub/sqlite` | `sqlitePubSub({ db, table?, intervalMs?, retainMs? })` | yes         | A message table from `pubsubTable()`, read every `intervalMs` (default 250). libSQL.                                                |
| `@arki/pubsub/redis`  | `redisPubSub({ client })`                              | no          | `PUBLISH`, and `SUBSCRIBE` on a duplicate of the ioredis client.                                                                    |

`publishIn(tx, channel, payload)` publishes inside your database transaction: the message is sent when `tx` commits and dropped if it rolls back. Only `pgPubSub` and `sqlitePubSub` have it, and their types say so, so code that needs commit-time delivery cannot pick memory or Redis by mistake. The `tx` type comes from your database; you never write it.

```ts skip="needs a database"
import { pubsubTable, sqlitePubSub } from '@arki/pubsub/sqlite';

export const pubsubMessages = pubsubTable(); // export it from your schema so migrations create it

const pubsub = sqlitePubSub({ db, table: pubsubMessages });
await db.transaction(async tx => {
  await tx.insert(orders).values(order);
  await pubsub.publishIn(tx, 'pizza_ready', order.id);
});
```

## Semantics, on every backend

- A subscriber gets the messages published after its `subscribe` resolved. Nothing is replayed.
- Order is kept per channel per publisher.
- A rolled-back `publishIn` is never delivered.
- A channel is 1 to 63 characters of `[a-z0-9_]`. A payload is at most 7999 bytes in UTF-8 (NOTIFY refuses 8000). Anything else rejects with a `PubSubError` (`channel` or `payload`).
- After `close()`, calls reject with a `closed` error. `close()` never closes your database, pool or Redis client.
- `subscribe(channel, fn)` resolves with an `Unsubscribe` that fits `@arki/journal`'s `listen` option: `listen: fn => pubsub.subscribe(channel, fn)`.

SQLite has one writer, so ids commit in order and the SQLite integration never skips a row. Its next publisher deletes rows older than `retainMs` (default 60 s).

## Testing a backend

`describePubSubContract(name, make)` from `@arki/pubsub/testing` registers the conformance cases with vitest. Every integration here runs it: memory and SQLite (libSQL) in `bun run test`, Postgres and Redis on containers in `bun run test:pg` and `bun run test:redis`.

## Errors

| Code      | `errorCode`        | Meaning                                               |
| --------- | ------------------ | ----------------------------------------------------- |
| `channel` | `ARKI_PUBSUB_E001` | The channel is not 1 to 63 characters of `[a-z0-9_]`. |
| `payload` | `ARKI_PUBSUB_E002` | The payload is 8000 bytes or more.                    |
| `closed`  | `ARKI_PUBSUB_E003` | The pubsub was closed.                                |
| `config`  | `ARKI_PUBSUB_E004` | A non-positive `intervalMs` or `retainMs`.            |
