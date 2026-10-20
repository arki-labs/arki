---
'@arki/auth': patch
'@arki/journal': patch
---

`env()`, `resilience()`, `auth()`, `journal()`, `journalProjections()`, `queue()`, `durableScheduler()` and `outboxPlugin()` keep their plugin name in the type, so their handles carry `provider: 'env' | 'resilience' | …` instead of `string` and the feature builder's handle-identity checks apply around them. The three queue plugins gain an overload: with no `name` option the type carries the default name (`'queue'`, `'durable-scheduler'`, `'outbox'`); with `name: 'jobs'` it carries `'jobs'`.
