# Typed local runtime initialization

`initDbRuntimeLocal()` now returns the database handle or a canonical failure.
Check `isFailure(result)` before using `result.db` or `result.pglite`. The
successful value also exposes `close()`, which returns `undefined` or a
canonical cleanup failure. The `db({ driver: 'pglite', ... })` Dot plugin
propagates these exact failures during boot and disposal.

| Definition                  | Code                                  | Recovery                                                                                |
| --------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------- |
| `DataDirInUse`              | `db.local_data_dir_in_use`            | Close the existing handle or choose another directory; `data.pid` identifies the owner. |
| `OwnerLockContended`        | `db.local_owner_lock_contended`       | Competing openers exhausted the bounded acquisition loop.                               |
| `LocalRuntimeUnavailable`   | `db.local_runtime_unavailable`        | Restore filesystem capacity or availability.                                            |
| `LocalRuntimeRefused`       | `db.local_runtime_refused`            | Correct the path or filesystem permissions.                                             |
| `LocalRuntimeCleanupFailed` | `db.local_runtime_cleanup_failed`     | Resources or ownership may remain; inspect private causes before reopening.             |
| `RandomSourceUnavailable`   | `contracts.random_source_unavailable` | Supply secure platform entropy before opening a file database.                          |
| `UnexpectedDefect`          | `failure.unexpected_defect`           | Inspect the private cause and repair the faulty provider or initialization.             |

`LOCAL_RUNTIME_FAILURES`, `OWNER_LOCK_FAILURES` and
`LOCAL_RUNTIME_CLOSE_FAILURES` are the canonical definition tuples. Their
types derive from those definitions. `SuccessOf<typeof initDbRuntimeLocal>`
derives the successful value; do not copy its object shape into an interface.

The owner ID uses `defineId('', { kind: 'db.owner', format: 'uuid' })`.
Generation preserves UUID v4 bytes and uses the Contracts secure byte fallback.
Stored owner files keep the same JSON shape and accept historical ID strings.
Memory and browser storage bypass file locking and owner entropy.

No filesystem mutation occurs before owner ID generation succeeds. Startup
supervises lock acquisition, PGlite readiness and Drizzle construction. An
already canonical failure keeps its identity when cleanup succeeds. If cleanup
also fails, `LocalRuntimeCleanupFailed` retains both causes privately.

If PGlite readiness rejects before the driver confirms a closed state, startup
cannot prove that extension resources were released. It returns cleanup
uncertainty and retains the file lock. Restart the owning process after fixing
the cause; the next process can reclaim the stale lock. Do not delete the lock
while the owner may still hold resources.

Owned `close()` releases ownership only after the database is confirmed closed.
A failed lock removal can be retried. A failed close that may leave a live
database keeps ownership. Raw `pglite.close()` remains PGlite's foreign
`Promise<void>` API and can reject; use owned `close()` for the Arki contract.

`DbRuntimeLocalError` and `DB_RUNTIME_LOCAL_ERROR_CODES` remain exported for
existing diagnostic integrations; new initialization outcomes use the canonical
definitions above. Tests and terminal process startup may explicitly use
`orThrow`; reusable services should propagate failures.

Default local initialization and close spans remain part of the outstanding
T08 observability work. This migration does not claim new browser, Hermes,
native Deno, Node26 or packed-artifact coverage for local database storage.
