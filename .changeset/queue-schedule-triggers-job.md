---
'@arki/queue': minor
---

A schedule now triggers its job instead of running it, and middleware now wraps the handler.

- `q.schedule.<kind>(...).job(someJob).data(d)` adds `d` to `someJob`'s own queue on each tick, the same as `someJob.trigger(d)`. The job's own worker runs it, with the job's input check, middleware, retries and concurrency. The schedule creates no queue or worker of its own. The BullMQ scheduler id is `schedule:<name>`, so several schedules can target one job. The runtime-local (pg-boss) queue does the same, keying each `boss.schedule(...)` by the schedule name.
- A schedule has no middleware of its own. `.use()` followed by `.job()` is a compile error, and a `QueueDefinitionError` (`ARKI_QUEUE_E012`) for plain JS. The inline form (`.use(mw).name(n).input(s).handler(fn)`) is an anonymous job named after the schedule; its `.use()` chain is that job's middleware.
- `.name()` now works with `.job()`: `cron(...).name('x').job(j).data(d)` compiles. `.handler()` still needs `.input()` first.
- `start()` prunes schedules removed from code: on each registered job's queue it removes `schedule:<name>` schedulers (runtime-local: keyed pg-boss schedules) that no registered schedule owns, so a renamed or deleted schedule stops ticking. Other keys on a job's queue are never touched. The md5-keyed BullMQ 5 leftover cleanup now runs only on an inline schedule's own queue, which only this package writes to.
- A duplicate schedule name now throws `QueueDefinitionError` (`ARKI_QUEUE_E013`) at `register()`, instead of logging a warning and skipping.
- Middleware wraps the handler (onion). The handler runs inside the last middleware's `next()`, so `await next()` resolves after the handler finishes, rejects with its error, and carries its return value as `output`. `try { return await next() } finally { ... }` now surrounds the handler. Both the BullMQ and the runtime-local queue use this one chain.
- Flows have no `.use()` any more. It stored middleware that nothing ran; each step runs in its own job's worker, with that job's middleware.
- A timeout schedule's delayed job id is now `schedule-<name>`: BullMQ refused the old `schedule:<name>` id.
- runtime-local `job.trigger()` no longer sends `priority: undefined`, which pg-boss rejected.
- runtime-local `start()` now bootstraps the pg-boss schema only on a fresh database; a restart on a persisted PGlite failed with "type job_state already exists".
- `job._internal._worker` is now set to the job's BullMQ worker (it was declared but never set).
- `CronPatterns` time helpers (`daily`, `weekdays`, `weekly`, `monthly`, ...) now emit normalized numbers (`'09:05'` gives `5 9 * * *`, not `05 09 * * *`) and reject non-digit text such as `'9am'` or `'12:34:56'`, which used to pass straight into the cron expression.
- A retry `maxDelay` of `0` now caps every delay at 0; it was treated as no cap.

Breaking, so a minor bump while the package is below 1.0. Schedules that wrapped a job ran the schedule's middleware and skipped the job's; they now run the job's. Code that called `.use()` before `.job()` on a schedule, or `.use()` on a flow, no longer compiles. Code after `await next()` in a middleware now runs after the handler, not before it. Schedules that wrapped a job under an older version keep their old entries on their old schedule-named queue (a BullMQ job scheduler, or a pg-boss schedule with no key). No worker reads that orphaned queue any more and pruning does not reach it; remove those entries by hand.
