# Migration outcomes

`readMigrations(folder)` still returns synchronously. It now returns
`MigrationReadFailed` when files cannot be read or decoded. `pendingMigrations`
returns the inferred source/state failures or `UnexpectedDefect` for malformed
bookkeeping rows. Successful results remain arrays. `migrateDb` still resolves
to `undefined` on confirmed completion, and now returns source failures or
`MigrationUnconfirmed`. An unexpected preparation fault returns `UnexpectedDefect`
before calling the native migrator.

Handle each returned result before using it. Use the original definition tuples
from `@arki/db/migrate`, or the browser-safe `@arki/db/contract`, for transport
admission. Do not restate their unions. At a process or test assertion boundary,
`orThrow` can turn a refusal into a failed process/test. Service code forwards
the original failure. `dbMigrations` already propagates failures through Dot
factories and boot, so dependent work cannot run after a refused migration.

An apply failure does not prove rollback. Bookkeeping creation can precede a
transaction, and a successful commit can lose its acknowledgement. There is no
automatic retry. Inspect the private cause, actual schema and migration history
before explicitly applying again. A successful `pendingMigrations` query alone
does not certify that every intended schema or external migration effect exists.

Database result rows use source schemas. Paths, SQL and native diagnostics remain
private. Default spans inherit caller context and record canonical codes only;
the application installs any telemetry SDK. Broken, rejected or repeated
reporting cannot repeat migration work or replace its outcome. Native driver
timeouts remain driver configuration; these helpers cannot interrupt an in-flight
migrator and do not claim cancellation after effects may have occurred.
