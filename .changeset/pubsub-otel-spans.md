---
"@arki/pubsub": patch
---

`@arki/pubsub` now reports to OpenTelemetry: a `pubsub.publish` or `pubsub.publish_in` span per publish, a
`pubsub.deliver` span per message per subscriber, a `pubsub.sqlite.poll` span for each SQLite poll that read rows
or failed, and the `pubsub.operations` counter. Spans carry the backend name and, on a failure, `error.type`; never
a channel name or a payload. It uses `@opentelemetry/api` only, so nothing is exported until the app configures an SDK.

no docs impact: README gains an Observability section; no API changed.
no demo impact: no demo reads pubsub telemetry.
