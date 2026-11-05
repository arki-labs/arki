---
"@arki/payments-native": patch
---

`getProOffering`, `purchasePackage` and `restorePurchases` each run in a span named like the web `@arki/payments` spans: `payments.revenuecat.get_offerings`, `payments.revenuecat.purchase_package` and `payments.revenuecat.restore_purchases`, with `payments.provider` and `failure.code` on a failure. The three failures are faults, so they set the error status. A cancelled purchase sets `payments.purchase_status: 'cancelled'` and leaves the status unset. Each call counts in `payments.operations` (`operation`, `outcome`). The API key, user id, products and `CustomerInfo` are never recorded. `@opentelemetry/api` is a new dependency; it still runs on Hermes.

Docs: README `## Observability`.
