/**
 * The expected ways a tax operation is refused, each defined once. The tax repositories, `TaxService`
 * and `TaxReportingService` return them, they never throw them: a correct caller must branch on them.
 */
import { z } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

/**
 * No tax configuration, jurisdiction or exemption has this id. Nothing was written.
 *
 * @fix Check the id. Read the row first if it may have been deleted.
 * @verify bun run test -- src/tax
 */
export const TaxReferenceNotFound = /* @__PURE__ */ defineFailure('payments.tax_reference_not_found', {
  status: 404,
  data: z.object({ kind: z.enum(['configuration', 'jurisdiction', 'exemption']), id: z.string() }),
  message: 'Tax {kind} {id} not found',
  remediation: 'Check the id.',
});

/**
 * A tax line is in another currency than the transaction it belongs to. Nothing was recorded and
 * the provider was not called.
 *
 * @fix Pass the breakdown that `calculateTax` returned for this transaction, in its currency.
 * @verify bun run test -- src/tax
 */
export const TaxCurrencyMismatch = /* @__PURE__ */ defineFailure('payments.tax_currency_mismatch', {
  status: 422,
  data: z.object({
    reference: z.string(),
    jurisdiction: z.string(),
    taxCurrency: z.string(),
    transactionCurrency: z.string(),
  }),
  message: 'Tax for {jurisdiction} is in {taxCurrency}, but the transaction {reference} is in {transactionCurrency}',
  remediation: 'Pass the breakdown that calculateTax returned for this transaction.',
});

/**
 * A line item is in another currency than the sale or refund it belongs to. Nothing was read or
 * recorded, and the provider was not called.
 *
 * @fix Price every line item in the transaction's `currency`.
 * @verify bun run test -- src/tax
 */
export const TaxLineCurrencyMismatch = /* @__PURE__ */ defineFailure('payments.tax_line_currency_mismatch', {
  status: 422,
  data: z.object({ lineReference: z.string(), lineCurrency: z.string(), transactionCurrency: z.string() }),
  message: 'Line {lineReference} is in {lineCurrency}, but the transaction is in {transactionCurrency}',
  remediation: "Price every line item in the transaction's currency.",
});

/**
 * A tax jurisdiction cannot be deleted while another row points at it: a child jurisdiction
 * (`usedBy: 'jurisdiction'`) or an exemption (`usedBy: 'exemption'`). Nothing was deleted.
 *
 * @fix Delete or move the row named by `usedById` first, or deactivate the jurisdiction (`isActive: false`).
 * @verify bun run test -- src/tax
 */
export const TaxJurisdictionInUse = /* @__PURE__ */ defineFailure('payments.tax_jurisdiction_in_use', {
  status: 409,
  data: z.object({ id: z.string(), usedBy: z.enum(['jurisdiction', 'exemption']), usedById: z.string() }),
  message: 'Tax jurisdiction {id} is still used by {usedBy} {usedById}',
  remediation: 'Delete or move that row first, or set isActive to false instead.',
});

/**
 * A new tax row was given an `id` that another row already has. Nothing was written.
 *
 * @fix Leave `id` out, so the repository makes a new one.
 * @verify bun run test -- src/tax
 */
export const TaxRowExists = /* @__PURE__ */ defineFailure('payments.tax_row_exists', {
  status: 409,
  data: z.object({ kind: z.enum(['configuration', 'jurisdiction', 'exemption', 'audit_entry']), id: z.string() }),
  message: 'Tax {kind} {id} already exists',
  remediation: 'Leave id out, so a new one is made.',
});

/**
 * A tax refund names no recorded sale to reverse: `originalReference` is missing (`null` here), or
 * no sale was recorded under it. Nothing was recorded and the provider was not called.
 *
 * @fix Record the sale first, and pass its `reference` as `originalReference`.
 * @verify bun run test -- src/tax
 */
export const TaxRefundSaleNotFound = /* @__PURE__ */ defineFailure('payments.tax_refund_sale_not_found', {
  status: 422,
  data: z.object({ reference: z.string(), originalReference: z.string().nullable() }),
  message: ({ reference, originalReference }) =>
    originalReference === null
      ? `Refund ${reference} needs originalReference: the reference of the sale it reverses`
      : `Refund ${reference} reverses sale ${originalReference}, which was never recorded`,
  remediation: 'Record the sale first, and pass its reference as originalReference.',
});

/**
 * The tax stored for a payment cannot be added up: its `taxAmount` metadata is not `Money` JSON
 * (`problem: 'not_money'`), or that metadata or a tax record under its id is in another currency
 * than the payment (`'other_currency'`). A wrong total must not pass, so the report stops here.
 *
 * @fix Correct the payment's `metadata.taxAmount` to `Money` JSON in the payment's currency, or the
 * tax records under its id (`tax_records.payment_id`) to the payment's currency.
 * @verify bun run test -- src/tax
 */
export const StoredTaxInvalid = /* @__PURE__ */ defineFailure('payments.stored_tax_invalid', {
  status: 500,
  data: z.object({
    paymentId: z.string(),
    problem: z.enum(['not_money', 'other_currency']),
    paymentCurrency: z.string(),
    /** The currency the stored tax names; `null` when it is not money */
    taxCurrency: z.string().nullable(),
  }),
  message: ({ paymentId, problem, paymentCurrency, taxCurrency }) =>
    problem === 'not_money'
      ? `Payment ${paymentId} has a taxAmount that is not money`
      : `Payment ${paymentId} is in ${paymentCurrency} but records tax in ${taxCurrency ?? 'another currency'}`,
  remediation: "Correct the payment's metadata.taxAmount to Money JSON in the payment's currency.",
});
