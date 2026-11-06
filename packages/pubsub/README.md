# @arki/pubsub

Publish and subscribe on named channels, with one contract and a dedicated integration per backend: memory, Postgres LISTEN/NOTIFY, SQLite (a polled table) and Redis. Import the one you use. Delivery is best effort, like NOTIFY. It is not a queue: nothing is stored for a subscriber that was not listening.

## Install

```sh
npm install @arki/pubsub
# or
bun add @arki/pubsub
# or
pnpm add @arki/pubsub
```

Each backend needs its own client. `@arki/pubsub/pg` uses a Postgres session pool. `@arki/pubsub/sqlite` uses a libSQL database. `@arki/pubsub/redis` uses an `ioredis` client. `@arki/pubsub/memory` needs nothing. `ioredis`, `@arki/db` and `drizzle-orm` are optional peers.

## Quick start

Publish on a channel and read it in a subscriber. This is the in-memory backend.

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

## When not to use this

- You need a queue. Nothing is stored for a subscriber that was not listening, and a message is never replayed. Use `@arki/queue`.
- You need delivery to every subscriber with no loss. Delivery is best effort, like NOTIFY.
- You need payloads over 7999 bytes. Send an id and let the subscriber read the rest from the database.

## Runtime support

The memory pubsub runs on Node, Bun, Deno, browsers and React Native (Hermes). The Postgres, SQLite and Redis integrations need their client and a server runtime. `bun run test:runtimes` runs a smoke test of the root and `./memory` on every engine; the Hermes leg needs `HERMES_BIN`.

<!-- runtimes:start -->

| Runtime | Result | Version tested        | Date (UTC) |
| ------- | ------ | --------------------- | ---------- |
| node    | pass   | v22.13.1              | 2026-11-05 |
| bun     | pass   | 1.4.2                 | 2026-11-05 |
| deno    | pass   | 2.9.8                 | 2026-11-05 |
| browser | pass   | Chromium 156.0.8078.4 | 2026-11-05 |
| hermes  | pass   | V1 250829098.0.17     | 2026-11-05 |

<!-- runtimes:end -->

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
- Postgres: when the channel's first connection or `LISTEN` fails, `subscribe` resolves to `db.listen_unavailable` (`ListenUnavailable` from `@arki/db/pg`) instead, and nothing is subscribed. The journal worker's `start()` returns that failure.

SQLite has one writer, so ids commit in order and the SQLite integration never skips a row. Its next publisher deletes rows older than `retainMs` (default 60 s).

## Testing a backend

`describePubSubContract(name, make)` from `@arki/pubsub/testing` registers the conformance cases with vitest. Every integration here runs it: memory and SQLite (libSQL) in `bun run test`, Postgres and Redis on containers in `bun run test:pg` and `bun run test:redis`.

## Observability

Spans (OpenTelemetry API only; nothing is exported until the app configures an SDK):

| Span                 | When                                                                       | Attributes                                                         |
| -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `pubsub.publish`     | each `publish`, until the backend accepted it                              | `pubsub.backend`, `error.type` on a throw                          |
| `pubsub.publish_in`  | each `publishIn` inside the caller's transaction                           | `pubsub.backend`, `error.type` on a throw                          |
| `pubsub.deliver`     | one message to one subscriber, until its callback (or its promise) settles | `pubsub.backend`, `error.type` when the callback throws or rejects |
| `pubsub.sqlite.poll` | a SQLite poll that read rows or failed; the deliveries nest under it       | `pubsub.backend`, `pubsub.messages`, `error.type` on a failed read |

Metrics: `pubsub.operations` (counter; `operation` = `publish`, `publish_in`, `deliver` or `poll`, `backend`, `outcome`). Every poll is counted, idle ones included.

`error.type` is the `ARKI_PUBSUB_E…` id or the error class, never the message. Never recorded: channel names, payloads.

Not instrumented: `subscribe` — on Postgres the listen is `@arki/db`'s `db.listen.start` (one per channel); the other backends only register a callback or send one `SUBSCRIBE`, and the delivery spans show it works. Idle SQLite polls — one every `intervalMs` would flood traces; they are counted instead.

## Public imports

| Import                 | What it holds                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `@arki/pubsub`         | The contract: `CHANNEL_PATTERN`, `MAX_PAYLOAD_BYTES`, `PubSubError`, `PUBSUB_ERROR_CODES` and the types. |
| `@arki/pubsub/memory`  | `memoryPubSub`.                                                                                          |
| `@arki/pubsub/pg`      | `pgPubSub`.                                                                                              |
| `@arki/pubsub/sqlite`  | `sqlitePubSub`, `pubsubTable`.                                                                           |
| `@arki/pubsub/redis`   | `redisPubSub`.                                                                                           |
| `@arki/pubsub/testing` | `describePubSubContract`, the conformance suite.                                                         |

## Failure behaviour

A bad call or a closed pubsub throws a `PubSubError`. Match on `code` or `errorCode`, never on the message. A Postgres `subscribe` that cannot open its `LISTEN` resolves to the failure `db.listen_unavailable` instead of throwing.

| Code      | `errorCode`        | Meaning                                               |
| --------- | ------------------ | ----------------------------------------------------- |
| `channel` | `ARKI_PUBSUB_E001` | The channel is not 1 to 63 characters of `[a-z0-9_]`. |
| `payload` | `ARKI_PUBSUB_E002` | The payload is 8000 bytes or more.                    |
| `closed`  | `ARKI_PUBSUB_E003` | The pubsub was closed.                                |
| `config`  | `ARKI_PUBSUB_E004` | A non-positive `intervalMs` or `retainMs`.            |

## Limits

- A channel is 1 to 63 characters of `[a-z0-9_]`.
- A payload is at most 7999 bytes in UTF-8.
- Nothing is stored for a subscriber that was not listening. A message published before `subscribe` resolved is not replayed.
- Order is kept per channel per publisher.
- `publishIn` exists on `pgPubSub` and `sqlitePubSub` only.
- `pgPubSub` needs a session pool, never a transaction pooler.
- SQLite polls every `intervalMs` (default 250) and deletes rows older than `retainMs` (default 60 s).

## Documentation

- [Agent guide](docs/agent-guide.md): the model, the task map, the rules and the errors.
- [llms.txt](llms.txt): the import map for agents.

## Support

Questions and bugs: <https://github.com/arki-labs/arki/issues>. Include the package version, the backend and the error `code`.
