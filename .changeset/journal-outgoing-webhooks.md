---
'@arki/journal': minor
---

Outgoing webhooks. `@arki/journal/http/webhooks` adds `webhookTables()` and `webhookSender({ tables, webhooks, encryptionKey })`: `subscribe`, `dispatch(tx, …)` (the message and its deliveries commit with the business write), `replay`, `rotateSecret` (both secrets sign during a window), `enable`, `disable`, and a queue `runner` for the journal worker. Deliveries are signed with Standard Webhooks, posted through `publicFetch()` from `@arki/http`, retried and dead-lettered by the worker, appended to `webhook_attempts`, and a subscription is disabled after `disableAfter` dead deliveries in a row. Secrets are sealed at rest with AES-GCM. `@arki/journal` adds `combineRunners(...)`, so one worker runs several queue runners.

Migration: three new tables, `webhook_subscriptions`, `webhook_messages` and `webhook_attempts`. Add `webhookTables()` to the schema and run `drizzle-kit generate` before using the entry.
