import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { j } from '../../journal.js';

export const payments = pgTable('payments', {
  id: varchar('id', { length: 64 }).primaryKey(),
  amount: integer('amount').notNull(),
  state: varchar('state', { enum: ['settled', 'refunded'] }).notNull(),
  version: integer('version').notNull().default(0),
});

export const PaymentSettled = j.event('PaymentSettled', z.object({ amount: z.int().positive() }));
export const PaymentRefunded = j.event('PaymentRefunded', z.object({ reason: z.string().min(1) }));

export const payment = j
  .entity('payment', payments, { events: 'stored' })
  .create(PaymentSettled, e => ({ amount: e.data.amount, state: 'settled' as const }))
  .on(PaymentRefunded, row => ({ ...row, state: 'refunded' as const }));
