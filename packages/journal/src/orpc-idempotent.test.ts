/**
 * `idempotent()` + `actorRun`: a repeated oRPC request must not write twice.
 *
 * Why: a client retries after a timeout and cannot know whether the first try committed.
 * The header becomes a key scoped to the caller; every command of the procedure gets its own
 * receipt under `${key}:${commandName}`, so a procedure with two commands replays both.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { call, ORPCError, os } from '@orpc/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import { actorRun, idempotent } from './orpc.js';
import { j, openDb, order, orderId, OrderPaid, OrderPlaced, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 9000;

beforeAll(async () => {
  ({ db, client } = await openDb());
});
afterAll(async () => {
  await client.close();
});

const journal = j.compose({});
type Session = { readonly user: { readonly id: string } } | null;
type Ctx = {
  readonly headers: Headers;
  readonly session: Session;
  readonly journal: typeof journal;
  readonly db: PgliteDatabase;
};

const idInput = z.object({ id: z.templateLiteral(['ord_', z.string()]) });
const placeOrder = j.command('placeOrder', idInput, (input, { write }) =>
  write(order, input.id, () => [OrderPlaced({ customerId: 'c', total: 1 })]).then(() => ({ id: input.id })),
);
const payOrder = j.command('payOrder', idInput, (input, { write }) =>
  write(order, input.id, () => [OrderPaid({ amount: 1 })]).then(() => ({ id: input.id })),
);

const keyed = (required = false) =>
  os
    .$context<Ctx>()
    .use(idempotent({ scope: context => context.session?.user.id, required }))
    .use(
      actorRun((context: { readonly session: Session; readonly journal: typeof journal }) => {
        if (!context.session) throw new ORPCError('UNAUTHORIZED');
        return { actorId: context.session.user.id };
      }),
    );

const placeAndPay = keyed()
  .input(idInput)
  .handler(async ({ context, input }) => {
    orThrow(await context.run(placeOrder, input));
    return context.run(payOrder, input);
  });

const ana: Session = { user: { id: 'usr_ana' } };
const context = (headers: Record<string, string>, session: Session = ana): Ctx => ({
  headers: new Headers(headers),
  session,
  journal,
  db,
});
const events = (id: string) => db.select().from(tables.events).where(eq(tables.events.entityId, id));

describe('idempotent() with actorRun', () => {
  it('a repeat with the same key replays both commands and writes nothing more', async () => {
    const id = orderId(++next);
    const ctx = context({ 'idempotency-key': 'req-1' });
    const first = await call(placeAndPay, { id }, { context: ctx });
    const again = await call(placeAndPay, { id }, { context: ctx });
    expect(again).toEqual(first);
    expect(await events(id)).toHaveLength(2);
    const keys = await db.select({ key: tables.receipts.key }).from(tables.receipts);
    expect(keys.map(row => row.key)).toEqual(
      expect.arrayContaining(['7:usr_ana:req-1:placeOrder', '7:usr_ana:req-1:payOrder']),
    );
  });

  it('scopes the key to the caller: another user with the same header runs on their own', async () => {
    const a = orderId(++next);
    const b = orderId(++next);
    orThrow(await call(placeAndPay, { id: a }, { context: context({ 'idempotency-key': 'same' }) }));
    orThrow(
      await call(
        placeAndPay,
        { id: b },
        { context: context({ 'idempotency-key': 'same' }, { user: { id: 'usr_bo' } }) },
      ),
    );
    expect(await events(a)).toHaveLength(2);
    expect(await events(b)).toHaveLength(2);
  });

  it('a key with colons cannot reach another scope: user "a" + key "b:x" and user "a:b" + key "x" stay apart', async () => {
    const a = orderId(++next);
    const b = orderId(++next);
    orThrow(
      await call(placeAndPay, { id: a }, { context: context({ 'idempotency-key': 'b:x' }, { user: { id: 'a' } }) }),
    );
    // Joined without the length, both would be "a:b:x:…" and the second call, with another input,
    // would hit the first one's receipt.
    orThrow(
      await call(placeAndPay, { id: b }, { context: context({ 'idempotency-key': 'x' }, { user: { id: 'a:b' } }) }),
    );
    expect(await events(a)).toHaveLength(2);
    expect(await events(b)).toHaveLength(2);
  });

  it('without the header it runs as before, and with required it is refused', async () => {
    const id = orderId(++next);
    orThrow(await call(placeAndPay, { id }, { context: context({}) }));
    expect(await events(id)).toHaveLength(2);
    const strict = keyed(true)
      .input(idInput)
      .handler(({ context: ctx, input }) => ctx.run(placeOrder, input));
    await expect(call(strict, { id: orderId(++next) }, { context: context({}) })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('the same key with another input is a conflict, not a second write', async () => {
    const ctx = context({ 'idempotency-key': 'req-2' });
    orThrow(await call(placeAndPay, { id: orderId(++next) }, { context: ctx }));
    await expect(call(placeAndPay, { id: orderId(++next) }, { context: ctx })).rejects.toThrow();
  });
});
