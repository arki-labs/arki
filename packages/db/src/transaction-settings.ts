/** The Zod check behind `TransactionSettings`, apart so the `transaction` declarations stay free of Zod. */
import { z } from 'zod';

export const transactionSettings = z.strictObject({
  isolation: z.literal('serializable').default('serializable'),
  retries: z.int().min(0).max(10).default(3),
});
