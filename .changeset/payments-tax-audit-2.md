---
"@arki/payments": minor
---

Tax writes, tax quotes and the Stripe subscription preset return typed failures instead of throwing on data a caller or Stripe can send.

- Breaking: `TaxJurisdictionRepository.createJurisdiction` now returns `TaxJurisdiction | TaxReferenceNotFound`. A `parentId` that names no jurisdiction returns `payments.tax_reference_not_found` (kind `jurisdiction`) instead of a raw Postgres foreign-key error. `updateJurisdiction` (new `parentId`), `TaxExemptionRepository.createExemption` and `updateExemption` (new `jurisdictionId`) return the same failure. The named jurisdiction is locked until the write, so it cannot be deleted in between.
- Breaking: the `TaxExemptionRepository` constructor takes `{ taxExemptions, taxJurisdictions }`. `createTaxRepositories` passes both.
- `TaxService.calculateTax`, `calculateSubscriptionTax` and `calculateOneTimeTax` return `money.provider_amount` when Stripe answers in another currency than the sale, instead of throwing `CurrencyMismatchError`. They and `createTaxTransaction` return `money.provider_amount` for a currency outside ISO 4217 (a custom currency Stripe cannot price), before Stripe is asked, instead of throwing `UnknownCurrencyError`.
- `projectStripeSubscription` and `createSubscriptionBilling().handleWebhook` return `InvalidInput` (`schema.invalid_input`) for a period, trial or cancel time that is not whole Unix seconds up to year 9999, instead of throwing `RangeError`. Nothing is written.
- `TaxExemptionRepository.findExpiringExemptions(days)` states its precondition: `days` from 1 to 365, as `getExpiringExemptionsInputSchema` allows. Anything else throws `FailureError` (`invariant`) before the query, not `RangeError: Invalid Date`.
- `fromStoredNumber` documents its throws: `NumericRangeError` and `UnknownCurrencyError`.
