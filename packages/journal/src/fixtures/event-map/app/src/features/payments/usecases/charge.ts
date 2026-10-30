import { z } from 'zod';

import { j } from '../../../journal.js';
import { payment, PaymentRefunded, PaymentSettled } from '../model.js';

export const chargePayment = j.command(
  'charge-payment',
  z.object({ id: z.string().min(1), amount: z.int().positive() }),
  { writes: [PaymentSettled] },
  (input, { write }) => write(payment, input.id, () => [PaymentSettled({ amount: input.amount })]),
);

/** A command that only a workflow runs, as the `undo` of the charge node. No procedure imports it. */
export const refundPayment = j.command(
  'refund-payment',
  z.object({ id: z.string().min(1), reason: z.string().min(1) }),
  { writes: [PaymentRefunded] },
  (input, { write }) => write(payment, input.id, () => [PaymentRefunded({ reason: input.reason })]),
);
