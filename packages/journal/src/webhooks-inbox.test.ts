/**
 * A verified webhook as an inbox: the handler runs a journal command keyed by the event id.
 *
 * Why: senders deliver at least once and resend after a timeout. Using the event id as the
 * idempotency key commits the receipt and the domain write together, so a resent event changes
 * nothing, and there is no separate "seen events" table to drift from the data.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildEngine, route, routes } from '@arki/http';
import { standardWebhooks, verifyWebhook } from '@arki/http/webhooks';

import { j, openDb, order, OrderPlaced, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openDb());
});
afterAll(async () => {
  await client.close();
});

const journal = j.compose({ tables });
const placeOrder = j.command(
  'placeOrder',
  z.object({ id: z.templateLiteral(['ord_', z.string()]), total: z.int().positive() }),
  (input, { write }) =>
    write(order, input.id, () => [OrderPlaced({ customerId: 'c', total: input.total })]).then(() => ({ id: input.id })),
);

const scheme = standardWebhooks({ secrets: ['whsec_c2VjcmV0LWtleS1vbmU='] });
const orderPlaced = route.post('/hooks/orders', {
  id: 'hooks.orders',
  body: z.object({ id: z.templateLiteral(['ord_', z.string()]), total: z.int().positive() }),
});
const engine = buildEngine([
  routes()
    .derive('webhook', verifyWebhook({ scheme }))
    .bind(orderPlaced, async ({ body }, { webhook }) => {
      await journal.run(db, placeOrder, body, { actorId: 'partner' }, { idempotencyKey: `hook:${webhook.id}` });
    }),
]);

const deliver = async (eventId: string, payload: unknown): Promise<Response> => {
  const body = JSON.stringify(payload);
  const headers = await scheme.sign(body, { id: eventId });
  headers.set('content-type', 'application/json');
  return engine.fetch(new Request('http://test.local/hooks/orders', { method: 'POST', headers, body }));
};
const events = (id: string) => db.select().from(tables.events).where(eq(tables.events.entityId, id));

describe('webhook inbox on journal receipts', () => {
  it('a resent event commits nothing the second time', async () => {
    const first = await deliver('msg_1', { id: 'ord_w1', total: 5 });
    const again = await deliver('msg_1', { id: 'ord_w1', total: 5 });
    expect([first.status, again.status]).toEqual([204, 204]);
    expect(await events('ord_w1')).toHaveLength(1);
    const receipts = await db.select().from(tables.receipts).where(eq(tables.receipts.key, 'hook:msg_1'));
    expect(receipts).toHaveLength(1);
  });

  it('a new event id is a new write', async () => {
    await deliver('msg_2', { id: 'ord_w2', total: 5 });
    await deliver('msg_3', { id: 'ord_w2b', total: 7 });
    expect(await events('ord_w2')).toHaveLength(1);
    expect(await events('ord_w2b')).toHaveLength(1);
  });

  it('an unsigned request never reaches the journal', async () => {
    const res = await engine.fetch(
      new Request('http://test.local/hooks/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'ord_w3', total: 5 }),
      }),
    );
    expect(res.status).toBe(401);
    expect(await events('ord_w3')).toHaveLength(0);
  });
});
