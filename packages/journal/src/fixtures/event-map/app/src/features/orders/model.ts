import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { j } from '../../journal.js';

export const orders = pgTable('orders', {
  id: varchar('id', { length: 64 }).primaryKey(),
  total: integer('total').notNull(),
  status: varchar('status', { enum: ['placed', 'cancelled'] }).notNull(),
  version: integer('version').notNull().default(0),
});

export const OrderPlaced = j.event('OrderPlaced', z.object({ total: z.int().positive() }));
export const OrderCancelled = j.event('OrderCancelled', z.object({ reason: z.string().min(1) }));

export const order = j
  .entity('order', orders)
  .create(OrderPlaced, e => ({ total: e.data.total, status: 'placed' as const }))
  .on(OrderCancelled, row => ({ ...row, status: 'cancelled' as const }));
