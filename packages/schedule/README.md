# @arki/schedule

In-process schedules for DOT apps that do not have Redis repeatables or
platform cron available.

Use this for single-replica processes by default. For multi-replica
deployments, pass a KV lock handle that supports `setIfNotExists`; each
fire takes a short TTL lock and skips when another replica already ran the
same schedule tick.

Redis-backed `@arki/queue` schedules and platform cron remain preferred
when that infrastructure exists.
