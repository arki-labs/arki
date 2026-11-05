---
"@arki/kv": minor
---

`redisResponseCache` (`@arki/kv/redis/idempotency`) now spans each call: `kv.idempotency.begin`,
`kv.idempotency.finish` and `kv.idempotency.abandon`, counted in `kv.commands`. Every `kv.*` span now sets the
`failure.code` attribute when a command returns a failure, like the other `@arki/*` packages (an attribute change,
so minor). A broken OpenTelemetry SDK can no longer make a KV command throw: telemetry errors are swallowed. Keys,
values, owners and responses are never recorded.

no docs impact: README gains an Observability section; no API changed.
no demo impact: no demo reads kv telemetry.
