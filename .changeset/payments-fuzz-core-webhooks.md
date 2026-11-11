---
'@arki/payments': minor
---

Webhook and notification services return bad config instead of throwing. Breaking: `WebhookHandler`, `WebhookSecurityService`, `WebhookAnalyticsService`, `EmailNotificationService` and `SlackNotificationService` have a private constructor and a `static create(...)` that returns the service or `payments.configuration_invalid`; `createWebhookHandler`, `createWebhookSecurityService`, `createWebhookAnalyticsService` and `createNotificationService` return the same. `allowedIps` and `adminEmails` take at most 1,000 items. `sendRefundStatusUpdate` answers `ReferenceNotFound` for a payment id holding U+0000. See `docs/upgrades/0.5.0-to-0.6.0.md`.
