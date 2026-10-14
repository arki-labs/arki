---
'@arki/payments': minor
---

`@arki/payments/core/security/webhook-security` now re-exports `core/services/webhook-security`. It used to hold a second verifier whose Stripe and Razorpay signature checks always returned `true`, so an app that imported it accepted unsigned webhooks.

Migration: `createWebhookSecurityService(config)` and `new WebhookSecurityService(config)` take a `WebhookSecurityConfig` (`allowedIps`, `replayWindowSeconds`, `maxRetries`). `WebhookSecurityError`, `WebhookSecurityErrorCode` and `WebhookSecurityValidationResult` are removed; `validateWebhook` returns `WebhookValidationResult` and does not throw. `verifyWithProvider`, `checkRateLimit`, `logSecurityEvent` and `getSecurityMetrics` are removed.
