---
'@arki/payments': minor
---

Amounts from Stripe, webhooks and stored JSON are no longer turned into throws. A bad one is returned as the `@arki/money` failure: `StripeProvider.getPlan`, `updatePlan`, `listPlans`, `previewSubscriptionChange`, `getPayment`, `createPayment`, `confirmPayment`, `cancelPayment`, `calculateTax` and `createTaxTransaction`; `TaxService.calculateTax`, `calculateSubscriptionTax`, `calculateOneTimeTax` and `createTaxTransaction`; `TaxReportingService.getCustomerTaxSummary`; `WebhookHandler.processWebhook` (a `payment.refunded` charge with a bad amount is not acknowledged and writes no refund); and the dunning segment and campaign calls that read stored spend ranges. Check `isFailure` before reading the result.
