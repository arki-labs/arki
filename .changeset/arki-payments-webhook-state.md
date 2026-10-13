---
'@arki/payments': minor
---

The old webhook handler updates subscriptions and payments for six Stripe event types, through journal commands.

Breaking:

- `WebhookHandler` and `createWebhookHandler` take the journal writes as their third argument: `paymentsJournal.writes(run)`.
- `WebhookEventStore` also needs `findSubscriptionByProviderSubscriptionId` and `findPaymentByProviderPaymentId`.
- `completePayment` also accepts a payment in `requires_action` or `failed` (the customer retried and the money was collected). `failPayment` also accepts `requires_action`, and still never a `succeeded` payment.

Also in this release (plans 002 and 008):

- Stripe webhook signatures are checked with a real HMAC over the signed `t.payload`, against the timestamp Stripe signed. An empty or missing webhook secret is refused. PayPal and Square verification fail as not implemented.
- `WebhookHandler` processes events synchronously by default (`enableAsync: false`): a failure returns `retryable: true`, so the provider resends. A delivery that arrives while the same event is still in flight is also retryable. New options: `skipIpValidation`, `processingLeaseMs` (default 5 minutes).
- An event is processed at most once at a time: claimed by `provider_event_id`, and taken over only after a failure or an expired lease.

Added:

- `markPaymentRequiresAction` command and `PaymentRequiresAction` event: the payment waits for the customer (for example 3-D Secure).
