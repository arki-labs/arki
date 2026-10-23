# Plan: Tier 3, capabilities off Postgres (pub/sub, SQLite locks)

Date: 2026-10-23
Source: [`docs/arki/research/17-multi-database/design.md`](../../../../docs/arki/research/17-multi-database/design.md) § 3.4 and § 5, Tier 3.
Category: clean. A new leaf package with one contract and four backends behind their own entries; a lease store that mirrors `pgLease`; one new kit column kind.

## Goal

The features that today need Postgres's LISTEN/NOTIFY or advisory locks get a backend that works on SQLite and Redis too:

1. `@arki/pubsub`: publish and subscribe, with `memoryPubSub`, `pollPubSub` (a message table, Postgres or SQLite), `pgPubSub` (LISTEN/NOTIFY) and `redisPubSub`.
2. `@arki/lock/sqlite`: `sqliteLease`, a lease store on SQLite, so `@arki/lock` and `@arki/schedule` run there.

## Founder decisions (2026-10-23)

- **Journal goes last.** Another session is editing `@arki/journal` now. Its SQLite port (with queue's outbox and mail, which write journal's tables) waits until that work is committed, then follows the same rules. It is not in this plan.
- **No dialect helpers over Drizzle.** The design's `claim()`, `now()`, `addSeconds()`, `jsonGet()` are dropped: each package keeps plain per-dialect query files (the Tier 2 rule: no abstraction over Drizzle's query API, no lost inference). Only a tiny SQL fragment everyone repeats gets one shared export: `sqliteNowMs` in `@arki/db/sqlite`.
- **Names:** one factory per backend, each in its own entry: `memoryPubSub`, `pollPubSub`, `pgPubSub`, `redisPubSub`.
- **Publishing inside a transaction is a typed capability.** Every backend has `publish(channel, payload)` (sends now). Backends that can join the writer's transaction (pg, poll) also have `publishIn(tx, channel, payload)`, and their type says so. Redis and memory do not, so a caller that needs commit-time delivery cannot pick them by mistake.

## Layering

`@arki/lock` is a kernel package and may not import `@arki/db` (platform). So `sqliteLease` speaks raw SQL through a structural Drizzle-libSQL type (`run`/`all`), exactly as `pgLease` takes `{ execute(sql) }`. Apps pass the handle from `createLibsqlDb`, so lock writes take their turn in `@arki/db`'s write queue. `sqliteLease` waits by polling (like `fileStore`): it has no pub/sub dependency.

`@arki/pubsub` is a platform package: its poll backend builds its table with the column kit, and its pg backend uses `listenOnPool`.

## `@arki/db` additions

- **`c.serial(name?)`** (kit kind): an auto-incrementing integer primary key, read as `number`. Postgres `bigserial` (`mode: 'number'`) primary key; SQLite `integer primary key autoincrement`. The poll table needs a monotonic id for its cursor; journal will need it too.
- **`sqliteNowMs`** (`@arki/db/sqlite`): `` sql`(cast(unixepoch('subsec') * 1000 as integer))` ``, the database clock in milliseconds. fs's local copy switches to it.

Tests: a kit type-equality case and a DDL case for `serial` on both dialects (as in `columns.test-d.ts` / `columns.test.ts`).

## `@arki/pubsub`

Created with `turbo gen package` (location `packages`, layer `platform`).

**Contract (`.`):**

```ts
type PubSub = {
  publish(channel: string, payload: string): Promise<void>;
  subscribe(channel: string, onMessage: (payload: string) => void): Promise<Unsubscribe>;
  close(): Promise<void>;
};
type TransactionalPubSub<Tx> = PubSub & {
  /** Sent when `tx` commits; dropped if it rolls back. */
  publishIn(tx: Tx, channel: string, payload: string): Promise<void>;
};
```

- **Semantics, same on every backend (the conformance suite proves it):** best effort, like NOTIFY. A subscriber gets messages published after it subscribed; nothing is replayed; order is kept per channel per publisher. A rolled-back `publishIn` is never delivered.
- **Limits, enforced everywhere so code moves between backends:** a channel is 1–63 characters of `[a-z0-9_]` (a Postgres identifier); a payload is at most 8000 bytes (NOTIFY's limit). A bad one fails at the call with a coded error.
- `subscribe(...)` resolves once the subscription is live. Its callback shape is journal's `WakeListener`, so journal later takes `listen: (fn) => pubsub.subscribe(channel, fn)` with no adapter.

**Backends:**

| Entry | Factory | Transactions | How |
| --- | --- | --- | --- |
| `./memory` | `memoryPubSub()` | no | In-process fan-out. Tests and one-process apps. |
| `./poll` | `pollPubSub({ db, table, intervalMs?, retainMs? })` | yes | `pubsubTable(c)` (column kit) holds messages. Subscribers read `id > cursor` for their channels every `intervalMs` (default 250 ms), starting at the newest id when they subscribe. Rows older than `retainMs` (default 60 s) are deleted by the next publisher. Postgres and SQLite, one query file each. |
| `./pg` | `pgPubSub({ pool })` | yes | `pg_notify` to publish (inside `tx` for `publishIn`); `listenOnPool` per channel to subscribe, so it needs a session pool (`sessionPool` from `@arki/db/dot`, never a transaction pooler). |
| `./redis` | `redisPubSub({ client })` | no | `PUBLISH`, and `SUBSCRIBE` on a duplicated connection. Optional peer `ioredis`, as in `@arki/lock`. |
| `./testing` | `describePubSubContract(name, make)` | — | The conformance suite every backend runs. |

On Postgres the poll backend can miss a row whose transaction committed after a later id was read (ids are taken at insert, not commit). That is within "best effort"; `pgPubSub` is the native path there. On SQLite (one writer) ids commit in order.

**Tests:** the conformance suite on memory, poll (PGlite and libSQL), pg (PGlite has no LISTEN across connections, so a testcontainer leg, gated like other `*.pg.test.ts`), and redis (testcontainer, gated). A type test that `publishIn` does not exist on `memoryPubSub()` / `redisPubSub()`.

## `@arki/lock/sqlite`

- `sqliteLease(db, options)` mirrors `pgLease`'s lease model: one row per key in `arki_lock` (never deleted, so the fence generation survives); acquire is one `INSERT … ON CONFLICT DO UPDATE … RETURNING`; semaphore holders as JSON `text` instead of `jsonb`; time from `sqliteNowMs`-style SQL. Guarantees: lease, fenced, `wait: 'poll'`. DDL helper like `ensureLockTable`.
- Runs `describeStoreContract('sqlite lease', …)` from `@arki/lock/testing` on libSQL. A cross-process case: two clients on one file contend for a key; exactly one holds it. `SQLITE_BUSY` from another process is a "try again", never an error.
- `@arki/schedule`: its lock tests gain a SQLite leg on `sqliteLease`.

## Steps (one commit each)

1. `@arki/db`: `c.serial` + `sqliteNowMs` (+ fs uses it).
2. `@arki/pubsub`: scaffold, contract, memory, testing suite.
3. poll backend (pg + SQLite).
4. pg backend.
5. redis backend.
6. `@arki/lock/sqlite` + schedule SQLite leg.
7. Docs: READMEs, changesets, research design.md Tier 3 row (journal/queue/mail marked pending).

## Verification per step

`bun run typecheck`, `bun run test`, `bun run test:docs` where present, eslint on touched files, `bun run layers` from the root (no findings for touched packages), `test:runtimes` for `@arki/pubsub` (memory and poll entries are portable).
