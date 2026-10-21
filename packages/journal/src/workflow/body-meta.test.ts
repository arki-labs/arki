/**
 * The meta of the commands a workflow body runs. A body's `ctx.run` may leave the meta out: the command then records
 * the `workflowMeta` the app passed to `compose`. A library workflow (generic over the app's meta) has no meta of its
 * own to pass, and the app already chose the runner's actor.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';

import { j, openDb, order, orderId, OrderPlaced, tables } from '../test-support.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_caller' };
const stepActor = { actorId: 'usr_step' };

const place = j.command('test.place', z.object({ n: z.int().positive() }), (input, { write }) =>
  write(order, orderId(input.n), () => [OrderPlaced({ customerId: 'cus_1', total: 10 })]),
);

/** Places one order from a step: with no meta, or with the step's own when `own` is set. */
const placing = j
  .workflow('test.placing', { version: 1, input: z.object({ n: z.int().positive(), own: z.boolean() }) })
  .step('place', async ({ input, run }) => {
    const placed = input.own ? await run(place, { n: input.n }, stepActor) : await run(place, { n: input.n });
    return isFailure(placed) ? placed : 'placed';
  })
  .finish();

const journal = j.compose({ workflows: [placing], workflowMeta });

let db: PgliteDatabase;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openDb());
});
afterAll(() => client.close());

async function settle(limit = 20) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the run did not settle');
}

/** The meta recorded on the order's `OrderPlaced`. */
const placedMeta = async (n: number) => {
  const rows = await db
    .select({ meta: tables.events.meta })
    .from(tables.events)
    .where(and(eq(tables.events.entityId, orderId(n)), eq(tables.events.type, 'OrderPlaced')));
  return rows.map(row => row.meta);
};

describe("a workflow body's commands", () => {
  it("a step's command records the app's workflowMeta when it passes none", async () => {
    const started = orThrow(await journal.run(db, placing.start, { input: { n: 1, own: false } }, caller));
    await settle();
    expect(orThrow(await placing.read(db, started.runId))?.run.state).toBe('completed');
    // Not the caller who started the run: the step runs later, as the runner the app named.
    expect(await placedMeta(1)).toEqual([workflowMeta]);
  });

  it('a step may still pass its own meta', async () => {
    const started = orThrow(await journal.run(db, placing.start, { input: { n: 2, own: true } }, caller));
    await settle();
    expect(orThrow(await placing.read(db, started.runId))?.run.state).toBe('completed');
    expect(await placedMeta(2)).toEqual([stepActor]);
  });
});
