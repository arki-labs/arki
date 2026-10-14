---
'@arki/payments': minor
---

The Stripe provider and the paths around it no longer stub or swallow.

- `StripeProvider` creates and changes subscriptions and intents for real: `createSubscription`, `updateSubscription` (plan change with `prorationBehavior`, `cancelAtPeriodEnd`), `cancelSubscription` (now, or at period end), `createPaymentIntent` and `createSetupIntent`. They take an optional `idempotencyKey`. The constructor takes a second argument `{ references, httpClient, maxNetworkRetries }`; `references` (a `PaymentRepository` fits) turns our customer, plan and subscription ids into Stripe ids, and a plan needs `metadata.stripePriceId`. Stripe errors become `PaymentProviderError` with a `code` and `retryable`.
- Webhooks record `charge.refunded` (`payment.refunded`) and `charge.dispute.created` (`payment.dispute_created`) on the payment through the new `recordPaymentRefund` and `recordPaymentDispute` journal commands. This needs a migration: two new `webhook_event_type` enum values and the `payments.dispute_id` and `payments.dispute_status` columns.
- `TaxService.calculateTax` rejects when the provider fails. It used to return zero tax.
- `TaxReportingService.getCustomerTaxSummary` is computed from the customer's succeeded payments and the tax recorded in their metadata, plus the exemptions in force that year. Its constructor takes `{ payments, exemptions }` reads, its totals are one `Money` per currency, and exemptions no longer carry an amount.
- `DunningCampaignService.listExecutions` and `getDashboardStats` read the tables. `DunningDashboardStats` money is a `MoneyBag`.
- `PaymentRepository.findPlans`, `findSubscriptions` and `findPayments` take the `PlanQuery`, `SubscriptionQuery` and `PaymentQuery` filters. `PaymentQuery` gains `customerId`.
- `createCampaign` writes the campaign and its templates inside its transaction.
