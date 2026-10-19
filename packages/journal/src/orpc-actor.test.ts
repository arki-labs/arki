/**
 * `actorRun(select)`: `context.run`, bound to the request's actor.
 *
 * Why these tests exist: every event a request writes must say who wrote it,
 * and the journal must not guess where the actor lives (a session, an API
 * key, a job). The app says it once, in `select`; the middleware binds the
 * journal's door with it. A procedure that lacks the journal or a database
 * the journal can write through must not compile, or the gap shows up as a
 * runtime crash on the first request.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { call, ORPCError, os } from '@orpc/server';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import { actorRun } from './orpc.js';
import { j, openDb, order, orderId, OrderPlaced, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let next = 7000;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

const journal = j.compose({});
type AppJournal = typeof journal;
type Session = { readonly user: { readonly id: string } } | null;

/** The app's request context after its `bind(core)` put `journal` and `db` on it. */
type HandlerContext = { readonly session: Session; readonly journal: AppJournal; readonly db: PgliteDatabase };

const placeOrder = j.command(
  'placeOrder',
  z.object({ id: z.templateLiteral(['ord_', z.string()]) }),
  (input, { write }) => write(order, input.id, () => [OrderPlaced({ customerId: 'c', total: 1 })]),
);

/** The app's `core/orpc.ts`: who the actor is, decided once. */
const asActor = actorRun((context: { readonly session: Session; readonly journal: AppJournal }) => {
  if (!context.session) throw new ORPCError('UNAUTHORIZED');
  return { actorId: context.session.user.id };
});

const place = os
  .$context<HandlerContext>()
  .use(asActor)
  .input(z.object({ id: z.templateLiteral(['ord_', z.string()]) }))
  .handler(({ context, input }) => {
    expectTypeOf(context.run).toEqualTypeOf<ReturnType<AppJournal['bind']>>();
    return context.run(placeOrder, input);
  });

const eventsOf = (id: string) => db.select().from(tables.events).where(eq(tables.events.entityId, id));

describe('actorRun(select)', () => {
  it('writes as the actor the app selected: the event meta carries it', async () => {
    const id = orderId(++next);
    orThrow(await call(place, { id }, { context: { session: { user: { id: 'usr_ana' } }, journal, db } }));
    const [event] = await eventsOf(id);
    expect(event?.meta).toEqual({ actorId: 'usr_ana' });
  });

  it("answers with the app's own error when there is no actor, and writes nothing", async () => {
    const id = orderId(++next);
    await expect(call(place, { id }, { context: { session: null, journal, db } })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(await eventsOf(id)).toEqual([]);
  });

  it('does not compile on a procedure without the database the journal writes through', () => {
    const refused = () =>
      os
        .$context<{ readonly session: Session; readonly journal: AppJournal }>()
        // @ts-expect-error -- no `db` on this context: the runner would have nowhere to write
        .use(asActor);
    expect(refused).toBeTypeOf('function');
  });

  it("does not compile when `select` returns something that is not the journal's meta", () => {
    // @ts-expect-error -- the meta schema wants `actorId: string`
    const refused = () => actorRun((context: { readonly journal: AppJournal }) => ({ actor: context.journal }));
    expect(refused).toBeTypeOf('function');
  });
});
