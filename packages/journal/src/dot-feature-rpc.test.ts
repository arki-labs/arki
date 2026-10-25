/**
 * A `defineFeature` feature that writes through the journal, end to end: a contract-first
 * procedure binds the request's actor (`actorRun`), runs a command from the feature's
 * `usecases/` (`context.run(command, input)`), an inline projection in the feature's
 * `.infra(...)` updates in the same transaction, and a read usecase serves the projection.
 *
 * Why these tests exist: this is the shape a Dot app's write path takes, and no single test
 * held all of it. The seams are typed across three packages (Dot binds `journal` and the
 * entrypoint-only `db` onto the handler context, the journal's `actorRun` needs exactly those
 * two, the contract types the command's failure). A break in any one shows up only here: the
 * procedure stops compiling, the event loses its actor, or a refusal reaches the client as a 500.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { oc } from '@orpc/contract';
import { call, ORPCError } from '@orpc/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Provided, ServicesBag } from '@arki/dot/feature';
import { defineApp } from '@arki/dot';
import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { rpc, rpcFor } from '@arki/dot/orpc';
import { infra } from '@arki/dot/unit';
import { defineFailure, orThrow } from '@arki/failure';
import { errorMap, orThrowRpc } from '@arki/failure/orpc';

import { journal, journalProjections } from './dot.js';
import { actorRun } from './orpc.js';
import { customerOrderCounts, j, openDb, order, orderId, OrderPlaced, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 11000;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

/* ---- the app's infra/: the database and the journal, each one unit ---- */

const database = infra({ name: 'db', provides: { db: () => db } });
const journalUnit = journal({ j });

/* ---- the app's entrypoints/middleware.ts: the request context, `implement`, the actor ---- */

type Session = { readonly user: { readonly id: string } } | null;
type RequestContext = { readonly session: Session; readonly services: ServicesBag };

const { implement } = rpcFor<RequestContext>();

/** The journal's type, read off the unit's handle: the app names it once. */
type AppJournal = Provided<typeof journalUnit.provides.journal>;

/** Who the actor is, decided once for the whole app. */
const asActor = actorRun((context: { readonly session: Session; readonly journal: AppJournal }) => {
  if (!context.session) throw new ORPCError('UNAUTHORIZED');
  return { actorId: context.session.user.id };
});

/* ---- features/orders/model/: a failure the command returns ---- */

const OrderRefused = defineFailure('orders.refused', { status: 422, message: 'This customer cannot order.' });

/* ---- features/orders/usecases/place-order.ts: the command ---- */

const placeOrder = j.command(
  'placeOrder',
  z.object({ id: z.templateLiteral(['ord_', z.string()]), customerId: z.string().min(1) }),
  (input, { write }) =>
    input.customerId === 'blocked'
      ? OrderRefused()
      : write(order, input.id, () => [OrderPlaced({ customerId: input.customerId, total: 1 })]),
);

/* ---- features/orders/infra/: the read store and the inline projection ---- */

const store = infra({
  name: 'orders-store',
  needs: { db: database.provides.db },
  provides: {
    counts: ({ db: root }) => ({
      placedBy: async (customerId: string) => {
        const [row] = await root
          .select()
          .from(customerOrderCounts)
          .where(eq(customerOrderCounts.customerId, `rpc:${customerId}`));
        return row?.placed ?? 0;
      },
    }),
  },
});

const countPlaced = j.projection('rpc-orders-count', order, {
  OrderPlaced: async (tx, e) => {
    const key = `rpc:${e.data.customerId}`;
    const [row] = await tx.select().from(customerOrderCounts).where(eq(customerOrderCounts.customerId, key));
    await (row === undefined
      ? tx.insert(customerOrderCounts).values({ customerId: key, placed: 1 })
      : tx.update(customerOrderCounts).set({ placed: row.placed + 1 }).where(eq(customerOrderCounts.customerId, key)));
  },
});

/* ---- features/orders/entrypoints/rpc.ts: the browser-safe contract ---- */

const placeInput = z.object({ id: z.templateLiteral(['ord_', z.string()]), customerId: z.string().min(1) });
const ordersContract = oc.router({
  place: oc
    .input(placeInput)
    .output(z.object({ id: z.string() }))
    .errors(errorMap(OrderRefused)),
  placedBy: oc.input(z.object({ customerId: z.string() })).output(z.number()),
});

/* ---- features/orders/feature.ts: the chain ---- */

const ordersCore = defineFeature('orders')
  .needs({
    // The procedure runs commands through these two; usecases never see them.
    journal: entrypointOnly(journalUnit.provides.journal),
    db: entrypointOnly(database.provides.db),
  })
  .infra(store, journalProjections(countPlaced))
  .usecases({
    placedBy:
      ({ counts }) =>
      (customerId: string) =>
        counts.placedBy(customerId),
  });

const rpcImplementer = implement(ordersContract).with(ordersCore);

/* ---- features/orders/entrypoints/procedures.ts ---- */

const ordersProcedures = (impl: typeof rpcImplementer) => ({
  place: impl.place.use(asActor).handler(async ({ context, input, errors }) => {
    const placed = await orThrowRpc(context.run(placeOrder, input), errors);
    return { id: placed.id };
  }),
  placedBy: impl.placedBy.handler(async ({ context, input }) => orThrow(await context.usecases.placedBy(input.customerId))),
});

const orders = ordersCore.entrypoints(rpc(ordersContract, rpcImplementer, ordersProcedures));

/* ---- the tests ---- */

async function started() {
  return orThrow(await defineApp('orders-rpc').infra(database, journalUnit).features([orders]).start());
}

const router = ordersProcedures(rpcImplementer);
const eventsOf = (id: string) => db.select().from(tables.events).where(eq(tables.events.entityId, id));

describe('a defineFeature feature that writes through the journal', () => {
  it('writes the event as the signed-in actor and updates the projection in the same transaction', async () => {
    const app = await started();
    try {
      const context = { session: { user: { id: 'usr_ana' } }, services: app.services };
      const id = orderId(++next);
      const before = await call(router.placedBy, { customerId: 'c-ana' }, { context });
      expect(await call(router.place, { id, customerId: 'c-ana' }, { context })).toEqual({ id });
      const [event] = await eventsOf(id);
      expect(event?.meta).toEqual({ actorId: 'usr_ana' });
      expect(await call(router.placedBy, { customerId: 'c-ana' }, { context })).toBe(before + 1);
    } finally {
      orThrow(await app.dispose());
    }
  });

  it("answers a command's returned failure as the contract's typed error, and writes nothing", async () => {
    const app = await started();
    try {
      const context = { session: { user: { id: 'usr_ana' } }, services: app.services };
      const id = orderId(++next);
      await expect(call(router.place, { id, customerId: 'blocked' }, { context })).rejects.toMatchObject({
        code: 'orders.refused',
        status: 422,
        defined: true,
      });
      expect(await eventsOf(id)).toEqual([]);
    } finally {
      orThrow(await app.dispose());
    }
  });

  it('refuses a request with no actor before the command runs', async () => {
    const app = await started();
    try {
      const id = orderId(++next);
      await expect(
        call(router.place, { id, customerId: 'c-ana' }, { context: { session: null, services: app.services } }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(await eventsOf(id)).toEqual([]);
    } finally {
      orThrow(await app.dispose());
    }
  });

  it('types the handler context: `run` from the actor, `journal` and `db` only for entrypoints', () => {
    const probe = rpcImplementer.place.use(asActor).handler(({ context }) => {
      expectTypeOf(context).toHaveProperty('run');
      expectTypeOf(context).toHaveProperty('journal');
      expectTypeOf(context).toHaveProperty('db');
      return { id: 'ord_x' };
    });
    expect(probe).toBeDefined();
    // A usecase factory sees the store, never the entrypoint-only journal or db.
    defineFeature('orders-types')
      .needs({ journal: entrypointOnly(journalUnit.provides.journal), db: entrypointOnly(database.provides.db) })
      .infra(store)
      .usecases({
        probe: deps => {
          expectTypeOf(deps).toHaveProperty('counts');
          expectTypeOf(deps).not.toHaveProperty('journal');
          expectTypeOf(deps).not.toHaveProperty('db');
          return () => null;
        },
      });
  });
});


