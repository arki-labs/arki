---
'@arki/payments': minor
---

No stub, placeholder or fake result is left in the package, and the bugs found by kapodopera's tests are fixed.

- `StripeProvider` implements every method on the `stripe@23` API (customers, plans, subscriptions incl. pause/resume/preview, payments, payment methods, tax transactions and tax settings). `getTaxReport` is removed (Stripe has no report endpoint); `refundPayment(paymentId)` takes our payment id and returns `{ providerRefundId, payment }`; `createTaxTransaction` takes `originalTransactionId` for refunds. The `references` read needs `findPaymentById`.
- Tax: per-jurisdiction tax is stored (`tax_records`) and the customer summary is computed from it; reports, CSV/XML exports, the audit trail (`tax_audit_entries`) and the compliance check come from stored data. `createTaxService(stripeProvider, reads)` takes reads. Exemptions are applied in `calculateTax`, start pending review, are validated (dates, negative rates, tax-ID formats), and a global exemption must be product- or jurisdiction-scoped.
- Refunds: the Stripe refund id is stored on the refund row and `charge.refunded`, `refund.created` and `refund.updated` webhooks reconcile it. Blank rejection reasons and duplicate pending refunds are refused (partial unique index), approval notes are kept (`approval_notes`), and a payment cannot be refunded beyond its amount.
- Dunning: campaign execution and segment queries work in a named schema; `DunningCampaignServiceTables` also needs `customerRiskProfiles`, `customers`, `payments`, `subscriptions`, and the segmentation/integration core tables need `plans`.
- Stats counts are numbers, `paymentResponseSchema` accepts `subscription: null`, and the customers table is unique per `userId` and per `providerCustomerId`.

Migration: new tables `tax_records` and `tax_audit_entries`; new columns and indexes as listed above (`refunds.approval_notes`, `refunds_one_pending_per_payment_idx`, customers unique indexes, `customers_user_id_idx`, `customers_provider_customer_id_idx`).
