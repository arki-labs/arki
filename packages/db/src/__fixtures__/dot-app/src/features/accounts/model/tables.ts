import { integer, pgTable, text } from 'drizzle-orm/pg-core';

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  balance: integer('balance').notNull(),
});
