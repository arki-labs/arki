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
 * A payment's stored `taxAmount` metadata cannot be added up: it is not `Money` JSON
 * (`problem: 'not_money'`), or it is in another currency than the payment (`'other_currency'`).
 * A wrong total must not pass, so the report stops here.
 *
 * @fix Correct the payment's `metadata.taxAmount` to `Money` JSON in the payment's currency.
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
