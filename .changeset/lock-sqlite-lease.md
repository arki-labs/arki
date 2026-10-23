---
'@arki/lock': minor
---

New entry `@arki/lock/sqlite`: `sqliteLease(db, { ttl, table? })`, a lease store on SQLite with the `pgLease` model. Pass the `db` from `createLibsqlDb` (`@arki/db/libsql`) as it is; lock writes then take their turn in its write queue.

- One row per key in `arki_lock`, never deleted, so the fence only grows. An acquire is one `INSERT … ON CONFLICT DO UPDATE … RETURNING`. Times are integer milliseconds from SQLite's clock.
- Mutex and semaphore (holders in a JSON `text` column), `extend`, owner-checked `release`. Guarantees: lease, cluster, `fence: 'durable'`, `wait: 'poll'`.
- `SQLITE_BUSY` from another process is "held right now" on acquire, never an error.
- `ensureLockTable(db, table?)`, `LEASE_TABLE_SQL` and `leaseTableSql(name)` for the table.
