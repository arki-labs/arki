/**
 * The expected ways a refund request or decision is refused, each defined once. `RefundService`
 * returns them, it never throws them: a correct caller must branch on them. Bad input (an empty
 * rejection reason, a refund in another currency) and provider faults are still thrown.
 */
import { z } from '@arki/contracts';
import { defineFailure } from '@arki/failure';

/**
 * No refund has this id.
 *
 * @fix Check the refund id.
 * @verify bun run test -- src/refunds
 */
export const RefundNotFound = defineFailure('payments.refund_not_found', {
  status: 404,
  data: z.object({ refundId: z.string() }),
  message: 'Refund {refundId} not found',
  remediation: 'Check the refund id.',
});

/**
 * The payment to refund does not exist. Nothing was written.
 *
 * @fix Check the payment id.
 * @verify bun run test -- src/refunds
 */
export const TransactionNotFound = defineFailure('payments.transaction_not_found', {
  status: 404,
  data: z.object({ paymentId: z.string() }),
  message: 'Payment {paymentId} not found',
  remediation: 'Check the payment id.',
});

/**
 * The payment already has a refund waiting for a decision. Nothing was written.
 *
 * @fix Approve or reject the pending refund first.
 * @verify bun run test -- src/refunds
 */
export const DuplicatePendingRefund = defineFailure('payments.duplicate_pending_refund', {
  status: 409,
  data: z.object({ paymentId: z.string() }),
  message: 'Payment {paymentId} already has a refund waiting for a decision',
  remediation: 'Approve or reject the pending refund first.',
});

/**
 * The refund was already decided, so it can no longer be approved or rejected. Nothing was written.
 *
 * @fix Read the refund again to see its decision. Only a pending refund can be approved or rejected.
 * @verify bun run test -- src/refunds
 */
export const RefundInvalidState = defineFailure('payments.refund_invalid_state', {
  status: 409,
  data: z.object({ refundId: z.string(), status: z.string().nullable() }),
  message: ({ refundId, status }) => `Invalid refund state for ${refundId}: ${status ?? 'no status'}, not pending`,
  remediation: 'Only a pending refund can be approved or rejected; read the refund again to see its decision.',
});

/**
 * The refund and what the payment already gives back add up to more than was paid. Amounts are
 * decimal text in `currency`, such as `'12.50'`. Nothing was written.
 *
 * @fix Ask for at most the refundable amount.
 * @verify bun run test -- src/refunds
 */
export const RefundAmountExceeded = defineFailure('payments.refund_amount_exceeded', {
  status: 422,
  data: z.object({ paymentId: z.string(), requested: z.string(), refundable: z.string(), currency: z.string() }),
  message: 'Refund amount exceeds payment amount: {requested} {currency} asked, {refundable} {currency} left to refund',
  remediation: 'Ask for at most the refundable amount.',
});

/**
 * The payment is older than the refund window. Nothing was written.
 *
 * @fix Refund it outside this workflow, or not at all. The default window is 90 days (`refundWindowMs`).
 * @verify bun run test -- src/refunds
 */
export const RefundWindowExceeded = defineFailure('payments.refund_window_exceeded', {
  status: 422,
  data: z.object({ paymentId: z.string() }),
  message: 'Refund window exceeded for payment {paymentId}',
  remediation: 'Refund it outside this workflow, or not at all.',
});
