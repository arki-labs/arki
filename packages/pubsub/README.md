# @arki/pubsub

Publish and subscribe on named channels, with one contract over memory, a polled message table (Postgres or SQLite), Postgres LISTEN/NOTIFY and Redis. Delivery is best effort, like NOTIFY. It is not a queue: nothing is stored for a subscriber that was not listening.

## Usage

```ts run
import { memoryPubSub } from '@arki/pubsub/memory';

const pubsub = memoryPubSub();
const received: string[] = [];
const unsubscribe = await pubsub.subscribe('orders_changed', payload => received.push(payload));

await pubsub.publish('orders_changed', 'ord_1');
await new Promise(resolve => setTimeout(resolve, 0));
if (received[0] !== 'ord_1') throw new Error('not delivered');

await unsubscribe();
await pubsub.close();
```

## Backends

| Entry                 | Factory                                             | `publishIn` | How                                                                                                |
| --------------------- | --------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `@arki/pubsub/memory` | `memoryPubSub()`                                    | no          | In-process fan-out. Tests and one-process apps.                                                    |
| `@arki/pubsub/poll`   | `pollPubSub({ db, table, intervalMs?, retainMs? })` | yes         | A message table from `pubsubTable(c)`, read every `intervalMs` (default 250). Postgres and SQLite. |
| `@arki/pubsub/pg`     | `pgPubSub({ pool })`                                | yes         | `pg_notify` and `LISTEN`. Needs a session pool, never a transaction pooler.                        |
| `@arki/pubsub/redis`  | `redisPubSub({ client })`                           | no          | `PUBLISH`, and `SUBSCRIBE` on a duplicate of the ioredis client.                                   |

`publishIn(tx, channel, payload)` publishes inside your database transaction: the message is sent when `tx` commits and dropped if it rolls back. Only `pollPubSub` and `pgPubSub` have it, and their types say so, so code that needs commit-time delivery cannot pick memory or Redis by mistake. The `tx` type is read off your database; you never write it.

```ts skip="needs a database"
import { pgColumns } from '@arki/db/pg';
import { pollPubSub, pubsubTable } from '@arki/pubsub/poll';

export const pubsubMessages = pubsubTable(pgColumns()); // add it to your schema

const pubsub = pollPubSub({ db, table: pubsubMessages });
await db.transaction(async tx => {
  await tx.insert(orders).values(order);
  await pubsub.publishIn(tx, 'orders_changed', order.id);
});
```

## Semantics, on every backend

- A subscriber gets the messages published after its `subscribe` resolved. Nothing is replayed.
- Order is kept per channel per publisher.
- A rolled-back `publishIn` is never delivered.
- A channel is 1 to 63 characters of `[a-z0-9_]`. A payload is at most 7999 bytes in UTF-8 (NOTIFY refuses 8000). Anything else rejects with a `PubSubError` (`channel` or `payload`).
- After `close()`, calls reject with a `closed` error. `close()` never closes your database, pool or Redis client.
- `subscribe(channel, fn)` resolves with an `Unsubscribe` that fits `@arki/journal`'s `listen` option: `listen: fn => pubsub.subscribe(channel, fn)`.

On Postgres the poll backend can miss a row whose transaction commits after a later id was read: ids are taken at insert, not at commit. That is within best effort; use `pgPubSub` there when you can. On SQLite (one writer) ids commit in order.

## Testing a backend

`describePubSubContract(name, make)` from `@arki/pubsub/testing` registers the conformance cases with vitest. Every backend here runs it: memory and poll (PGlite, libSQL) in `bun run test`, pg and Redis on containers in `bun run test:pg` and `bun run test:redis`.

## Errors

| Code      | `errorCode`        | Meaning                                                                          |
| --------- | ------------------ | -------------------------------------------------------------------------------- |
| `channel` | `ARKI_PUBSUB_E001` | The channel is not 1 to 63 characters of `[a-z0-9_]`.                            |
| `payload` | `ARKI_PUBSUB_E002` | The payload is 8000 bytes or more.                                               |
| `closed`  | `ARKI_PUBSUB_E003` | The pubsub was closed.                                                           |
| `config`  | `ARKI_PUBSUB_E004` | A bad `intervalMs` or `retainMs`, or a database and table of different dialects. |
