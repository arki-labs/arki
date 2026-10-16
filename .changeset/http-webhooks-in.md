---
'@arki/http': minor
'@arki/payments': patch
---

Signed webhooks in. `@arki/http/webhooks` adds `verifyWebhook({ scheme })`, a deriver that checks a request's signature over a clone of its body, and three schemes: `standardWebhooks`, `stripe` and `hmac` (GitHub, Slack, Shopify and most others). Each scheme also has `verify` and `sign`. Several secrets are accepted at once for rotation, the signed time must be within a tolerance, and the event id types as `string` where the scheme always carries one, ready to be a journal idempotency key. New error codes `ARKI_HTTP_E012`, `E413`, `E420`, `E421`, `E422`.

`@arki/payments` checks Stripe signatures through `stripe()` from `@arki/http/webhooks` and now depends on `@arki/http`. Results are unchanged, except that a `t=` that is not Unix seconds now reports `Invalid signature format` instead of a time outside the window.
