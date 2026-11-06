/**
 * Inside a Dot app, a command run by a usecase opens its `journal.command`
 * span inside the usecase's span, through the command's transaction span. So
 * a trace shows which usecase wrote the events. Real PGlite, real journal,
 * real Dot.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { infra } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';
import { captureSpans } from '@arki/testing/otel';

import type { OrderId } from './test-support.js';
import { journal } from './dot.js';
import { j, meta, openDb, order, orderId, OrderPlaced } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

const placeOrder = j.command(
  'telemetryPlaceOrder',
  z.object({ id: z.templateLiteral(['ord_', z.string()]) }),
  { writes: [OrderPlaced] },
  (input, { write }) => write(order, input.id, () => [OrderPlaced({ customerId: 'c1', total: 1 })]),
);

const dbUnit = infra({ name: 'db', provides: { db: () => db } });
const journalUnit = journal({ j });

const orders = defineFeature('orders')
  .needs({ db: dbUnit.provides.db, journal: journalUnit.provides.journal })
  .usecases({
    place:
      ({ db: database, journal: commands }) =>
      (id: OrderId) =>
        commands.run(database, placeOrder, { id }, meta),
  })
  .entrypoints();

describe('@arki/journal spans inside a Dot app', () => {
  it('nests journal.command under the Dot usecase span, so a trace shows which usecase wrote the events', async () => {
    using spans = captureSpans();
    const app = orThrow(await defineApp('journal-telemetry').infra(dbUnit, journalUnit).features([orders]).start());
    try {
      orThrow(await app.services['orders.usecases'].place(orderId(7001)));
    } finally {
      orThrow(await app.dispose());
    }

    // The command runs inside its transaction, so the chain is usecase → db.transaction.once → journal.command.
    const command = spans.named('journal.command');
    const transaction = spans.named('db.transaction.once');
    expect(command.parent).toBe(transaction);
    expect(transaction.parent).toBe(spans.named('feature.orders.place'));
    expect(command.attributes['journal.command.name']).toBe('telemetryPlaceOrder');
  });
});
