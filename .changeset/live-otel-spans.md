---
"@arki/live": patch
---

`@arki/live` now reports to OpenTelemetry: one `live.stream` span per server stream (how it started, and why it
ended: max age, a revoked grant, a hub gap, the client leaving), one `live.client.connection` span per client
connection (status code and outcome, so retries show), and the `live.streams.active`, `live.streams` and
`live.client.connections` metrics. Never one span per frame, and never a cursor, grant, table name or frame. It uses
`@opentelemetry/api` only (a new dependency), so nothing is exported until the app configures an SDK.

no docs impact: README gains an Observability section; no API changed.
no demo impact: no demo reads live telemetry.
