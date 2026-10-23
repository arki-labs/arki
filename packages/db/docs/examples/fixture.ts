/**
 * The docs fixture of `@arki/db`: the "app" that README blocks import as
 * `./fixture.ts`. A small schema (users, posts, stories, accounts, orders,
 * invoices), its relations, and `db`, an in-memory PGlite database from
 * `@arki/db/runtime-local` with those tables created and a few rows seeded.
 * Every process that imports it gets a fresh database.
 *
 * In your app, these names come from your own `tables.ts`, `relations.ts`
 * and `db.ts`.
 */
import { oc } from '@orpc/contract';
import { integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { TRANSACTION_FAILURES } from '@arki/db/errors';
import { defineRelations, eq, sql } from '@arki/db/orm';
import { initDbRuntimeLocal } from '@arki/db/runtime-local';
import { orThrow } from '@arki/failure';
import { errorMap } from '@arki/failure/orpc';

// Tables: one feature's leaf `tables.ts` each, in an app.
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

export const posts = pgTable('posts', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
});

export const stories = pgTable('stories', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  cents: integer('cents').notNull(),
});

export const orderStatusEnum = pgEnum('order_status', ['open', 'paid']);

export const orders = pgTable('orders', {
  id: text('id').primaryKey(),
  status: orderStatusEnum('status').notNull().default('open'),
});

export const orderItems = pgTable('order_items', {
  id: text('id').primaryKey(),
  orderId: text('order_id').notNull(),
  sku: text('sku').notNull(),
});

export const invoices = pgTable('invoices', {
  id: text('id').primaryKey(),
  cents: integer('cents').notNull(),
});

/** The billing feature's slice, as `composeSchema` takes it. */
export const billingTables = { invoices };

export const schema = { users, posts, stories, accounts, orders, orderItems, orderStatusEnum, invoices };

export const relations = defineRelations(schema, r => ({
  users: { posts: r.many.posts(), stories: r.many.stories() },
  posts: { author: r.one.users({ from: r.posts.userId, to: r.users.id }) },
  stories: { author: r.one.users({ from: r.stories.userId, to: r.users.id }) },
}));

const DDL = `
  CREATE TABLE users (id text PRIMARY KEY, name text NOT NULL);
  CREATE TABLE posts (id text PRIMARY KEY, user_id text NOT NULL, title text NOT NULL);
  CREATE TABLE stories (id text PRIMARY KEY, user_id text NOT NULL, title text NOT NULL, created_at timestamptz NOT NULL);
  CREATE TABLE accounts (id text PRIMARY KEY, cents integer NOT NULL);
  CREATE TYPE order_status AS ENUM ('open', 'paid');
  CREATE TABLE orders (id text PRIMARY KEY, status order_status NOT NULL DEFAULT 'open');
  CREATE TABLE order_items (id text PRIMARY KEY, order_id text NOT NULL, sku text NOT NULL);
  CREATE TABLE invoices (id text PRIMARY KEY, cents integer NOT NULL);
`;

const local = await orThrow(initDbRuntimeLocal({ memory: true }, { relations }));
await local.pglite.exec(DDL);

// Close PGlite when the script is done, as an app does at shutdown. Without
// it, Bun exits with 99 (WASM teardown). The guard timer keeps the process
// alive until `close()` settles; a thrown error still exits non-zero.
process.once('beforeExit', () => {
  const guard = setTimeout(() => {
    throw new Error('the docs fixture: PGlite did not close within 10 s');
  }, 10_000);
  void orThrow(local.close()).finally(() => clearTimeout(guard));
});

/** The app's database: in-memory PGlite, tables created, rows seeded. */
export const db = local.db;
/** What `db.transaction` hands its callback. */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

await db.insert(users).values({ id: 'usr_ada', name: 'Ada' });
await db.insert(accounts).values([
  { id: 'acc_ada', cents: 1000 },
  { id: 'acc_grace', cents: 100 },
]);
await db.insert(stories).values(
  ['first', 'second', 'third'].map((title, day) => ({
    id: `sty_${String(day + 1)}`,
    userId: 'usr_ada',
    title,
    createdAt: new Date(Date.UTC(2026, 0, day + 1)),
  })),
);

/** The orders feature's transaction-scoped repository. */
export const createOrdersTx = (tx: Transaction) => ({
  create: async (id: string) => {
    await tx.insert(orders).values({ id });
  },
});

/** The billing feature's transaction-scoped repository. */
export const createBillingTx = (tx: Transaction) => ({
  charge: async (cents: number) => {
    await tx.insert(invoices).values({ id: `inv_${String(cents)}`, cents });
  },
});

const accountRepository = (tx: Transaction) => ({
  add: async (id: string, cents: number) => {
    await tx
      .update(accounts)
      .set({ cents: sql`${accounts.cents} + ${cents}` })
      .where(eq(accounts.id, id));
  },
});

/** Repositories bound to a transaction, as `transactionalProcedure` takes them. */
export const repositories = {
  withTx: (tx: Transaction) => ({ accounts: accountRepository(tx) }),
};

export const transferInput = z.object({ from: z.string(), to: z.string(), cents: z.number().int().positive() });
export type TransferInput = z.infer<typeof transferInput>;

/** The accounts feature's oRPC contract. */
export const contract = { transfer: oc.errors(errorMap(...TRANSACTION_FAILURES)).input(transferInput) };

/** The usecase: move cents between two accounts, inside the caller's transaction. */
export async function moveMoney(repos: ReturnType<typeof repositories.withTx>, input: TransferInput): Promise<void> {
  await repos.accounts.add(input.from, -input.cents);
  await repos.accounts.add(input.to, input.cents);
}

/** An account's balance in cents, read outside any transaction. */
export async function balance(id: string): Promise<number | undefined> {
  const [row] = await db.select({ cents: accounts.cents }).from(accounts).where(eq(accounts.id, id));
  return row?.cents;
}
