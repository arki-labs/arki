# @arki/pubsub for agents

The long form of [llms.txt](../llms.txt). When they disagree, `src/index.ts` wins.

## The model

1. One contract, `PubSub`: `publish(channel, payload)`, `subscribe(channel, onMessage)` (resolves with `Unsubscribe` once live), `close()`.
2. `TransactionalPubSub<Tx>` adds `publishIn(tx, channel, payload)`: sent at commit, dropped on rollback. Only `pgPubSub` and `sqlitePubSub` return it.
3. Delivery is best effort, like NOTIFY. No replay, no queue, no acknowledgement. Order is kept per channel per publisher.
4. Each backend is a dedicated integration on its own entry, written straight against its driver; its client is an optional peer. Only the contract and the conformance suite are shared.

## Task map

### Wake a worker when a row is written

1. Postgres: `pgPubSub({ pool })` with a session pool. SQLite: export `pubsubTable()` from `@arki/pubsub/sqlite` in your schema, then `sqlitePubSub({ db })`.
2. The code after this step is the same for both.
3. Write the row and `publishIn(tx, channel, id)` in the same transaction.
4. The worker subscribes and re-reads the database on each message; the payload is a hint, not the data.

### Feed `@arki/journal`'s wake channel

`listen: fn => pubsub.subscribe(channel, fn)`. No adapter: `Unsubscribe` fits journal's `Unlisten`.

### Test a new backend

Call `describePubSubContract('name', () => Promise.resolve({ pubsub, transaction }))` in a test file. Leave out `transaction` for a backend without `publishIn`; those cases are skipped with a reason. Pass `{ shared: false }` when two instances cannot hear each other.

## Rules that bite

- Channels are `^[a-z0-9_]{1,63}$`; payloads are at most 7999 UTF-8 bytes. Send ids, not documents.
- `pgPubSub` behind a transaction pooler hears nothing: LISTEN needs a session.
- `close()` does not close your database, pool or Redis client.
- A subscriber callback that throws is logged at `warn`; the others still get the message.
- The SQLite integration deletes rows older than `retainMs` (default 60 s) on the next publish; a subscriber slower than that misses rows.

## Errors

| Code                           | Meaning                                 | What to do                                   |
| ------------------------------ | --------------------------------------- | -------------------------------------------- |
| `channel` (`ARKI_PUBSUB_E001`) | Bad channel name                        | Use 1 to 63 characters of `[a-z0-9_]`.       |
| `payload` (`ARKI_PUBSUB_E002`) | Payload of 8000 bytes or more           | Send an id; read the rest from the database. |
| `closed` (`ARKI_PUBSUB_E003`)  | Used after `close()`                    | Make a new pubsub.                           |
| `config` (`ARKI_PUBSUB_E004`)  | Non-positive `intervalMs` or `retainMs` | Fix the option named in the message.         |

## Verify

```sh
bun run typecheck
bun run test
bun run test:pg      # Docker
bun run test:redis   # Docker
bun run test:docs
```
