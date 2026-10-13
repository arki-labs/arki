/**
 * Shared fixture for the package tests: an in-memory PGlite, the journal
 * tables, and a small `orders` domain. Excluded from the build.
 */
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { initJournal } from './journal.js';
import { journalTables } from './pg.js';
import { openJournalDb } from './testing.js';

export type OrderId = `ord_${string}`;
export const orderId = (n: number): OrderId => `ord_${n}`;

export const orders = pgTable('orders', {
  id: varchar('id', { length: 256 }).primaryKey().$type<OrderId>(),
  customerId: varchar('customer_id', { length: 256 }).notNull(),
  total: integer('total').notNull(),
  status: varchar('status', { enum: ['placed', 'paid', 'cancelled'] }).notNull(),
  note: varchar('note', { length: 256 }).notNull().default('none'),
  version: integer('version').notNull().default(0),
});

export const customerOrderCounts = pgTable('customer_order_counts', {
  customerId: varchar('customer_id', { length: 256 }).primaryKey(),
  placed: integer('placed').notNull().default(0),
});

/** A table whose key is not called `id`. */
export type AccountId = `acc_${string}`;
export const accountId = (n: number): AccountId => `acc_${n}`;

export const profiles = pgTable('profiles', {
  accountId: varchar('account_id', { length: 256 }).primaryKey().$type<AccountId>(),
  nick: varchar('nick', { length: 64 }).notNull(),
  moveCount: integer('move_count').notNull().default(0),
  version: integer('version').notNull().default(0),
});

export const tables = journalTables();

export const j = initJournal({ meta: z.object({ actorId: z.string().min(1) }) });

export const OrderPlaced = j.event(
  'OrderPlaced',
  z.object({ customerId: z.string().min(1), total: z.int().positive() }),
);
export const OrderPaid = j.event('OrderPaid', z.object({ amount: z.int().positive() }));
/** A note is free text a person wrote, so it has an erased form. */
export const OrderNoted = j.event('OrderNoted', z.object({ note: z.string().min(1) }), {
  erased: () => ({ note: '[erased]' }),
});
export const OrderCancelled = j.event('OrderCancelled', z.object({ reason: z.string().min(1) }));
export const Unrelated = j.event('Unrelated', z.object({}));

export const order = j
  .entity('order', orders)
  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))
  // Spread style: still allowed, the patch is merged onto the state.
  .on(OrderPaid, row => ({ ...row, status: 'paid' }))
  // Patch style: only the column that changed.
  .on(OrderNoted, (_row, e) => ({ note: e.data.note }))
  .on(OrderCancelled, () => null);

export const ProfileOpened = j.event('ProfileOpened', z.object({ nick: z.string().min(1) }));
export const ProfileMoved = j.event('ProfileMoved', z.object({}));
export const ProfileClosed = j.event('ProfileClosed', z.object({}));
/** May be the first event of a profile or a later one. */
export const ProfileFlagged = j.event('ProfileFlagged', z.object({ nick: z.string().min(1) }));

export const profile = j
  .entity('profile', profiles, { key: 'accountId' })
  .create(ProfileOpened, e => ({ nick: e.data.nick, moveCount: 0 }))
  .create(ProfileFlagged, e => ({ nick: e.data.nick, moveCount: 0 }))
  // Every create sets `moveCount`, so it is a number here: no `?? 0`.
  .on(ProfileMoved, row => ({ moveCount: row.moveCount + 1 }))
  .on(ProfileFlagged, (_row, e) => ({ nick: e.data.nick }))
  .on(ProfileClosed, () => null);

export const openDb = () => openJournalDb({ ...tables, orders, customerOrderCounts, profiles });

export const meta = { actorId: 'usr_test' };
