---
"@arki/payments": minor
---

Tax and refunds return typed failures for every value a caller can send that Postgres or the money sums would refuse, and never drop a notification failure.

- New failures: `payments.tax_line_currency_mismatch` (422, a line item in another currency than its sale), `payments.tax_jurisdiction_in_use` (409, `deleteJurisdiction` on a jurisdiction a child or an exemption names), `payments.tax_row_exists` (409, an explicit `id` another row has).
- The tax contracts, the refund command schemas and `refundRejectionReasonSchema` refuse text holding U+0000, text over its `varchar` length and times outside the years 1 to 9999, as `schema.invalid_input`. `taxCalculationInputSchema` refuses a line item in another currency than `currency`.
- Breaking: every tax repository write checks its row (`taxConfigurationRowSchema`, `taxJurisdictionRowSchema`, `taxExemptionRowSchema`, `taxAuditRowSchema`, `taxRecordRowSchema`) and returns `schema.invalid_input` instead of a raw Postgres error: `createConfiguration`, `updateConfiguration`, `createJurisdiction`, `updateJurisdiction`, `createExemption`, `updateExemption`, `approveExemption`, `TaxAuditRepository.record`, `recordMany` (which now returns `SchemaFailure | undefined`). `createConfiguration`, `createJurisdiction`, `createExemption` and `record` return `TaxRowExists` for a taken `id`. Reads given U+0000 find nothing.
- Breaking: `TaxJurisdictionRepository.deleteJurisdiction` returns `TaxJurisdictionInUse | undefined`, and its constructor takes `{ taxJurisdictions, taxExemptions }`. `createTaxRepositories` passes both.
- `TaxService.calculateTax` and `createTaxTransaction` return `TaxLineCurrencyMismatch` instead of throwing `CurrencyMismatchError`. `createTaxTransaction` checks the records before Stripe is asked (`schema.invalid_input`), so Stripe and the records never disagree, and returns `TaxCurrencyMismatch` for a reference recorded earlier in another currency.
- Breaking: `TaxReportingService.generateComplianceReport` and `exportTaxData` return `StoredTaxInvalid` (`other_currency`) for a tax record in another currency than its payment, instead of throwing. `createAuditEntry` returns `schema.invalid_input` or `TaxRowExists`.
- `getUpcomingDeadlines` returns for an `asOf` near the last date a `Date` holds (it looped forever). Both `getCustomerTaxSummary` methods throw `FailureError` (`invariant`) for a year outside 2000 to 2100.
- Refund commands return `CommandNotFound` (`journal.not_found`) for a `requestedBy`, `approvedBy` or `rejectedBy` with no user, instead of `db.transaction_rejected` (23503).
- Breaking: the customer's rejection mail is the `refund-rejection-notice` effect of `createRefundEffects`; `RefundService` and `createRefundService` no longer take a `NotificationService`. A mail the approval or rejection effect could not send is returned, never dropped: `payments.notification_failed` is retried with the journal's default backoff (`refundMailRetry`: 8 tries, 1 s up to 5 minutes), any other failure makes the job dead at once, with it as `lastError`. The `payments.refund` workflow output gains `notificationFailure` when the `notify` mail did not go out.
- `averageTaxRate` in the compliance report leaves out a payment whose tax equals its amount (it was `Infinity`).
- `getRefundMetrics` no longer overflows the call stack on Node with ~150,000 refunds.
