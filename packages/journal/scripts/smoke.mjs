// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node and Bun,
// and as a browser-target bundle under Deno and headless Chromium, via
// `bun run test:runtimes`. Deno gets the bundle because it resolves bare
// imports through package.json and cannot read `catalog:` versions.
// No database here: it proves the core module loads and the pure parts work.

import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { CommandNotFound, initJournal, isJournalError, JournalError, need } from '../dist/index.js';
import { journalTables } from '../dist/pg.js';

const j = initJournal({ meta: z.object({ actorId: z.string() }) });
const OrderPlaced = j.event('OrderPlaced', z.object({ total: z.int().positive() }));
const OrderPaid = j.event('OrderPaid', z.object({ amount: z.int().positive() }));
const orders = pgTable('orders', {
  id: varchar('id').primaryKey(),
  total: integer('total').notNull(),
  status: varchar('status').notNull(),
  version: integer('version').notNull().default(0),
});
const order = j
  .entity('order', orders)
  .create(OrderPlaced, e => ({ total: e.data.total, status: 'placed' }))
  .on(OrderPaid, row => ({ ...row, status: 'paid' }));
const mail = j.effect('order-mail', order, {
  OrderPaid: () => {
    /* smoke only */
  },
});
const pushed = [];
const push = j.effect(
  'order-push',
  order,
  { push: need() },
  {
    OrderPaid: (e, ctx) => ctx.push(e.entityId),
  },
);
const journal = j.compose({
  tables: journalTables(),
  effects: [mail, push],
  services: { push: id => pushed.push(id) },
});

let rejected = false;
try {
  OrderPaid({ amount: -1 });
} catch {
  rejected = true;
}

const checks = [
  ['event validates', JSON.stringify(OrderPlaced({ total: 5 })), '{"type":"OrderPlaced","data":{"total":5}}'],
  ['event rejects bad data', rejected, true],
  ['entity declares events', [...order.events.keys()].join(','), 'OrderPlaced,OrderPaid'],
  ['effect declares types', [...mail.types].join(','), 'OrderPaid'],
  ['effect declares needs', Object.keys(push.needs).join(','), 'push'],
  ['journal lists both effects', journal.catalog.effects.join(','), 'order-mail,order-push'],
  [
    'catalog',
    JSON.stringify(journal.catalog.entities[0]),
    '{"kind":"order","table":"orders","events":["OrderPlaced","OrderPaid"]}',
  ],
  ['error code', isJournalError(new JournalError('NO_ROW', 'order', 'x'), 'NO_ROW'), true],
  [
    'returned refusal',
    JSON.stringify(CommandNotFound({ detail: 'Order not found' })),
    '{"code":"journal.not_found","message":"Order not found","data":{"detail":"Order not found"},"status":404}',
  ],
  ['the door binds without a database call', typeof journal.bind({}, { actorId: 'system' }), 'function'],
  [
    'tables',
    Object.keys(journalTables()).join(','),
    'events,jobs,jobAttempts,jobArchive,jobOperations,receipts,cursors',
  ],
];

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed += 1;
    console.log(`FAIL ${name}: expected ${String(expected)}, got ${String(actual)}`);
  }
}
if (failed > 0) throw new Error(`${failed} smoke checks failed`);
console.log(`${checks.length} smoke checks passed`);
