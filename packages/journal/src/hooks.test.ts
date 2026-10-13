import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { OrderId } from './test-support.js';
import { j, meta, openDb, order, orderId, OrderPaid, OrderPlaced, orders, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 0;

const orderIdSchema = z.templateLiteral(['ord_', z.string()]);
const placeOrder = j.command('placeOrder', z.object({ orderId: orderIdSchema }), (input, { write }) =>
  write(order, input.orderId, () => [OrderPlaced({ customerId: 'c', total: 1 })]),
);
const payOrder = j.command('payOrder', z.object({ orderId: orderIdSchema }), (input, { write }) =>
  write(order, input.orderId, () => [OrderPaid({ amount: 1 })]),
);
const rowOf = async (id: OrderId) => {
  const rows = await db.select().from(orders).where(eq(orders.id, id));
  return rows[0] ?? null;
};

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

describe('command hooks', () => {
  it('see the run, wrap it in registration order with the first outermost, and cannot change the result', async () => {
    // Why: this is the one extension point. A telemetry or log plugin must be able to trust
    // the order and the context without the app threading anything.
    const journal = j.compose({ tables });
    const trail: string[] = [];
    journal.hooks.command.around(async (ctx, next) => {
      trail.push(`outer:${ctx.name}:${ctx.commandId.slice(0, 4)}:${ctx.correlationId}`);
      expect(ctx.meta).toEqual(meta);
      expect(ctx.input).toEqual({ orderId: id });
      await next();
      trail.push('outer:done');
    });
    journal.hooks.command.around(async (_ctx, next) => {
      trail.push('inner');
      await next();
      trail.push('inner:done');
    });
    const id = orderId(++next);
    const result = await journal.run(db, placeOrder, { orderId: id }, meta, { correlationId: 'req_h' });
    expect(result.row).toMatchObject({ id, version: 1 });
    expect(trail).toEqual(['outer:placeOrder:cmd_:req_h', 'inner', 'inner:done', 'outer:done']);
  });

  it('run inside the transaction: a hook that throws after next rolls the write back, and the caller gets that error', async () => {
    const journal = j.compose({ tables });
    journal.hooks.command.around(async (_ctx, next) => {
      await next();
      throw new Error('audit refused');
    });
    const id = orderId(++next);
    await expect(journal.run(db, placeOrder, { orderId: id }, meta)).rejects.toThrow('audit refused');
    expect(await rowOf(id)).toBeNull();
  });

  it('a hook that throws before next stops the command; nothing runs', async () => {
    const journal = j.compose({ tables });
    journal.hooks.command.around(() => Promise.reject(new Error('not allowed')));
    const id = orderId(++next);
    await expect(journal.run(db, placeOrder, { orderId: id }, meta)).rejects.toThrow('not allowed');
    expect(await rowOf(id)).toBeNull();
  });

  it('cannot swallow a failure, call next twice, or skip next', async () => {
    // Why: a hook that catches the handler error and returns would tell the caller the command
    // succeeded while the transaction rolled back.
    const swallowing = j.compose({ tables });
    swallowing.hooks.command.around(async (_ctx, next) => {
      await next().catch(() => {
        /* swallowed on purpose */
      });
    });
    const unpaid = orderId(++next);
    await expect(swallowing.run(db, payOrder, { orderId: unpaid }, meta)).rejects.toMatchObject({ code: 'NO_ROW' });

    const twice = j.compose({ tables });
    twice.hooks.command.around(async (_ctx, next) => {
      await next();
      await next();
    });
    const id = orderId(++next);
    await expect(twice.run(db, placeOrder, { orderId: id }, meta)).rejects.toThrow('called next twice');
    expect(await rowOf(id), 'the error after next rolled the write back').toBeNull();

    const skipping = j.compose({ tables });
    skipping.hooks.command.around(() => Promise.resolve());
    const skipped = orderId(++next);
    await expect(skipping.run(db, placeOrder, { orderId: skipped }, meta)).rejects.toThrow('without calling next');
    expect(await rowOf(skipped)).toBeNull();
  });

  it('a child run is wrapped too, with its own command id and the same chain', async () => {
    const journal = j.compose({ tables });
    const seen: [string, string][] = [];
    journal.hooks.command.around(async (ctx, next) => {
      seen.push([ctx.name, ctx.correlationId]);
      await next();
    });
    const both = j.command('placeAndPay', z.object({ orderId: orderIdSchema }), async (input, { run }) => {
      await run(placeOrder, input);
      await run(payOrder, input);
    });
    await journal.run(db, both, { orderId: orderId(++next) }, meta, { correlationId: 'req_c' });
    expect(seen).toEqual([
      ['placeAndPay', 'req_c'],
      ['placeOrder', 'req_c'],
      ['payOrder', 'req_c'],
    ]);
  });

  it('registration is frozen once the journal has run a command', async () => {
    const journal = j.compose({ tables });
    await journal.run(db, placeOrder, { orderId: orderId(++next) }, meta);
    expect(() => journal.hooks.command.around(async (_ctx, next) => next())).toThrow(
      expect.objectContaining({ code: 'BAD_DEFINITION' }),
    );
  });
});

describe('effect hooks', () => {
  it('wrap the handler inside the lease with the job, the attempt and the event; a throw fails the job like a handler failure', async () => {
    const ran: string[] = [];
    const mail = j.effect('hooked-mail', order, {
      OrderPaid: e => {
        ran.push(e.entityId);
      },
    });
    const journal = j.compose({ tables, effects: [mail] });
    const seen: { name: string; jobId: string; attempt: number; type: string }[] = [];
    let refuse = true;
    journal.hooks.effect.around(async (ctx, next) => {
      seen.push({ name: ctx.name, jobId: ctx.jobId, attempt: ctx.attempt, type: ctx.event.type });
      if (refuse) throw new Error('circuit open');
      await next();
    });
    const id = orderId(++next);
    await journal.run(db, placeOrder, { orderId: id }, meta);
    await journal.run(db, payOrder, { orderId: id }, meta);

    expect(await journal.drain(db)).toBe(1);
    expect(ran).toEqual([]);
    const [job] = await db.select().from(tables.jobs).where(eq(tables.jobs.effect, 'hooked-mail'));
    expect(job).toMatchObject({ attempts: 1, lastError: expect.stringContaining('circuit open') });
    expect(seen).toEqual([{ name: 'hooked-mail', jobId: job?.id, attempt: 1, type: 'OrderPaid' }]);

    refuse = false;
    await db
      .update(tables.jobs)
      .set({ availableAt: new Date(0) })
      .where(eq(tables.jobs.id, job?.id ?? ''));
    expect(await journal.drain(db)).toBe(1);
    expect(ran).toEqual([id]);
    expect(seen[1]).toMatchObject({ attempt: 2 });
    expect(() => journal.hooks.effect.around(async (_ctx, next) => next())).toThrow(
      expect.objectContaining({ code: 'BAD_DEFINITION' }),
    );
  });
});
