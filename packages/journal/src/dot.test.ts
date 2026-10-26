/**
 * The Dot bridge. `journal(...)` is the infra part: it publishes the journal so
 * features can write through it. `journalWorker(...)` is the entrypoint: it runs
 * the effects, taps and async projections. `journalHandlers(...)` lets a feature
 * hand over its projections, effects and taps.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { EntrypointServicesOf } from '@arki/dot/feature';
import type { EmptyShape, Provided, UnitSourceGuard } from '@arki/dot/unit';
import { defineApp, rename } from '@arki/dot';
import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { infra, service, token } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';

import type { OrderId } from './test-support.js';
import { journal, journalEffects, journalHandlers, journalProjections, journalWorker } from './dot.js';
import { need } from './handlers.js';
import { initJournal } from './journal.js';
import {
  customerOrderCounts,
  j,
  meta,
  openDb,
  order,
  orderId,
  OrderPaid,
  OrderPlaced,
  orders as ordersTable,
  tables,
} from './test-support.js';

type AppTx = Parameters<Parameters<PgliteDatabase['transaction']>[0]>[0];
type TestJournal = ReturnType<typeof j.compose>;

/** Short, so a worker that is still running would pick a job up well inside `QUIET_MS`. */
const POLL_MS = 20;
const QUIET_MS = 200;

let db: PgliteDatabase;
let client: PGlite;
let next = 0;
const apps: Parameters<typeof track>[0][] = [];

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await orThrow(app.stop());
    await orThrow(app.dispose());
  }
  // A job left by one test must not reach the next test's worker.
  await db.delete(tables.jobs).where(sql`true`);
});

afterAll(async () => {
  await client.close();
});

/** Remember the app so `afterEach` stops its worker even when the test fails. */
function track<App extends { stop(): Promise<unknown>; dispose(): Promise<unknown> }>(app: App): App {
  apps.push(app);
  return app;
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A promise the test resolves by hand. */
function signal() {
  const lock: { open?: () => void } = {};
  const opened = new Promise<void>(resolve => {
    lock.open = resolve;
  });
  return { opened, open: () => lock.open?.() };
}

/** Stands in for a service value in a plugin that is type-checked and never booted. */
const neverBooted = <T>(): T => {
  throw new Error('this plugin is only type-checked');
};

/** The app's `db` plugin: it publishes the root database under the `db` key. */
const dbPlugin = () => infra({ name: 'db', provides: { db: () => db } });

const placeOrder = j.command(
  'placeOrder',
  z.object({ id: z.templateLiteral(['ord_', z.string()]), customerId: z.string().default('c1') }),
  (input, { write }) => write(order, input.id, () => [OrderPlaced({ customerId: input.customerId, total: 1 })]),
);

/** An effect on `OrderPlaced` that records the orders it handled. */
function recorder(name: string) {
  const handled: OrderId[] = [];
  const waiting = new Map<OrderId, () => void>();
  const effect = j.effect(name, order, {
    OrderPlaced: e => {
      handled.push(e.entityId);
      waiting.get(e.entityId)?.();
    },
  });
  /** Resolves when the effect has run for this order. */
  const seen = (id: OrderId) =>
    handled.includes(id)
      ? Promise.resolve()
      : new Promise<void>(resolve => {
          waiting.set(id, resolve);
        });
  return { effect, handled, seen };
}

/** An inline projection that counts placed orders per customer, under `prefix`. */
const countPlaced = (name: string, prefix: string) =>
  j.projection(name, order, {
    OrderPlaced: async (tx, e) => {
      await tx
        .insert(customerOrderCounts)
        .values({ customerId: `${prefix}:${e.data.customerId}`, placed: 1 })
        .onConflictDoUpdate({
          target: customerOrderCounts.customerId,
          set: { placed: sql`${customerOrderCounts.placed} + 1` },
        });
    },
  });

const placedCount = async (customerId: string) => {
  const rows = await db.select().from(customerOrderCounts).where(eq(customerOrderCounts.customerId, customerId));
  return rows[0]?.placed ?? 0;
};

const typed = initJournal
  .tx<AppTx>()
  .db<PgliteDatabase>()
  .create({ tables, meta: z.object({ actorId: z.string().min(1) }) });
const typedJournal = typed.compose({});

describe('journal(...) in direct mode', () => {
  it('publishes a journal built with the typed chain as `services.journal`, so a typed app can mount it', async () => {
    const journalUnit = journal({ journal: typedJournal });
    // Public adapters retain their callbacks so mounting can validate the authored lifecycle returns.
    expectTypeOf<UnitSourceGuard<typeof journalUnit>>().toEqualTypeOf<[]>();
    expectTypeOf<UnitSourceGuard<ReturnType<typeof journalProjections>>>().toEqualTypeOf<[]>();
    const app = track(await orThrow(defineApp('typed').infra(dbPlugin()).infra(journalUnit).boot()));

    expectTypeOf(app.services.journal).toEqualTypeOf(typedJournal);
    expect(app.services.journal).toBe(typedJournal);
    // Agents read the manifest before the app boots: the service and its need must be listed.
    expect(app.manifest.services).toContainEqual({ name: 'journal', plugin: 'journal', kind: 'custom' });
    expect(app.manifest.plugins.find(p => p.name === 'journal')).toMatchObject({ dependencies: ['db'] });
  });

  it('accepts a journal from the untyped `initJournal({ tables, meta })`, so small apps need no type steps', async () => {
    const untyped = j.compose({});
    const app = track(
      await orThrow(
        defineApp('untyped')
          .infra(dbPlugin())
          .infra(journal({ journal: untyped }))
          .boot(),
      ),
    );

    expectTypeOf(app.services.journal).toEqualTypeOf<TestJournal>();
    expect(app.services.journal).toBe(untyped);
  });

  it('refuses a transaction or another database type as `db` at compile time, because the worker must see committed data', () => {
    const withTx = defineApp('tx').infra(infra({ name: 'db', provides: { db: () => neverBooted<AppTx>() } }));
    // @ts-expect-error -- a transaction has `rollback`, so it is not a root database: effects would run before the outer commit.
    withTx.infra(journal({ journal: j.compose({}) }));
    // @ts-expect-error -- the same holds when the journal names the app's database type.
    withTx.infra(journal({ journal: typedJournal }));

    type ReportsDb = PgliteDatabase & { readonly reports: true };
    const reports = initJournal
      .db<ReportsDb>()
      .create({ tables, meta: z.object({ actorId: z.string() }) })
      .compose({});
    const withPlainDb = defineApp('plain').infra(dbPlugin());
    // @ts-expect-error -- this journal's effects read `ctx.db` as a `ReportsDb`; the app publishes another database type.
    withPlainDb.infra(journal({ journal: reports }));

    expect(orThrow(withTx.configure()).manifest.plugins.map(p => p.name)).toEqual(['db']);
  });

  it('runs effects only through a served `journalWorker()`, between start and stop, so none runs during shutdown', async () => {
    const mail = recorder('dot-direct-mail');
    const composed = j.compose({ effects: [mail.effect] });
    const app = track(
      await orThrow(
        defineApp('direct-worker')
          .infra(dbPlugin())
          .infra(journal({ journal: composed }))
          .entrypoints(journalWorker({ pollMs: POLL_MS }))
          .boot(),
      ),
    );
    await orThrow(app.start());

    const first = orderId(++next);
    orThrow(await app.services.journal.run(db, placeOrder, { id: first }, meta));
    await mail.seen(first);

    await orThrow(app.stop());
    orThrow(await app.services.journal.run(db, placeOrder, { id: orderId(++next) }, meta));
    await pause(QUIET_MS);

    expect(mail.handled).toEqual([first]);
    expect(await db.select().from(tables.jobs)).toHaveLength(1);
  });

  it('gives each app its own worker when two apps mount one `journalWorker()` value, so stopping one leaves the other running', async () => {
    const mail = recorder('dot-shared-worker-mail');
    const composed = j.compose({ effects: [mail.effect] });
    const worker = journalWorker({ pollMs: POLL_MS });
    const build = (name: string) =>
      defineApp(name)
        .infra(dbPlugin())
        .infra(journal({ journal: composed }))
        .entrypoints(worker)
        .boot();
    const first = track(await orThrow(build('first-worker')));
    const second = track(await orThrow(build('second-worker')));
    await orThrow(first.start());
    await orThrow(second.start());
    await orThrow(first.stop());

    const id = orderId(++next);
    orThrow(await second.services.journal.run(db, placeOrder, { id }, meta));
    await mail.seen(id);

    expect(mail.handled).toEqual([id]);
  });

  it('runs no effect in an app that serves no worker, so a web-only process leaves the jobs to the worker process', async () => {
    const mail = recorder('dot-no-worker-mail');
    const composed = j.compose({ effects: [mail.effect] });
    const app = track(
      await orThrow(
        defineApp('web-only')
          .infra(dbPlugin())
          .infra(journal({ journal: composed }))
          .boot(),
      ),
    );
    await orThrow(app.start());

    orThrow(await app.services.journal.run(db, placeOrder, { id: orderId(++next) }, meta));
    await pause(QUIET_MS);

    expect(mail.handled).toEqual([]);
    expect(await db.select().from(tables.jobs)).toHaveLength(1);
  });

  it('mounts a second journal through `rename`, so one app can run two journals without a key collision', async () => {
    const main = j.compose({});
    const reports = j.compose({});
    const app = track(
      await orThrow(
        defineApp('two-journals')
          .infra(dbPlugin())
          .infra(journal({ journal: main }))
          .infra(rename(journal({ journal: reports }), { journal: 'reportsJournal' }, 'reports-journal'))
          .boot(),
      ),
    );

    expect(app.services.journal).toBe(main);
    expect(app.services.reportsJournal).toBe(reports);
    expect(app.manifest.plugins.map(p => p.name)).toEqual(['db', 'journal', 'reports-journal']);
  });
});

describe('journal({ j }) with features', () => {
  it('has a typed `provides.journal` handle before any app is built, so a feature needs the journal without restating its type', () => {
    type ComposedJournal = ReturnType<typeof j.compose>;
    const appJournal = journal({ j });
    expectTypeOf(appJournal.name).toEqualTypeOf<'journal'>();
    expectTypeOf(appJournal.provides.journal.provider).toEqualTypeOf<'journal'>();
    expectTypeOf<Provided<typeof appJournal.provides.journal>>().toEqualTypeOf<ComposedJournal>();
    const _gateway = defineFeature('gateway').needs({ journal: entrypointOnly(appJournal.provides.journal) });
    expectTypeOf<EntrypointServicesOf<typeof _gateway>['journal']>().toEqualTypeOf<ComposedJournal>();
    // The worker publishes nothing: its worker is per-app state, not a service.
    expectTypeOf(journalWorker().provides).toEqualTypeOf<EmptyShape>();
    expect(appJournal.provides.journal).toMatchObject({ key: 'journal', provider: 'journal' });
  });

  it('builds the journal from the mounted features alone: one command fires each inline projection and, through the worker, each effect', async () => {
    const ordersMail = recorder('dot-orders-mail');
    const billingMail = recorder('dot-billing-mail');
    const ordersCore = defineFeature('orders')
      .infra(journalProjections(countPlaced('dot-orders-count', 'orders')))
      .usecases({});
    const orders = ordersCore.entrypoints(journalEffects(ordersCore, { effects: [ordersMail.effect] }));
    const billingCore = defineFeature('billing')
      .infra(journalProjections(countPlaced('dot-billing-count', 'billing')))
      .usecases({});
    const billing = billingCore.entrypoints(journalEffects(billingCore, { effects: [billingMail.effect] }));
    // A feature with no journal slice is allowed: it contributes nothing.
    const plain = defineFeature('plain').usecases({}).entrypoints();

    // The features are listed once: `journal` and `journalWorker` are both bound to them.
    const app = track(
      await orThrow(
        defineApp('feature-mode')
          .infra(dbPlugin())
          .infra(journal({ j }))
          .features([orders, billing, plain])
          .entrypoints(journalWorker({ pollMs: POLL_MS }))
          .boot(),
      ),
    );
    await orThrow(app.start());

    expect(app.services.journal.catalog.projections).toEqual(['dot-orders-count', 'dot-billing-count']);
    expect(app.services.journal.catalog.effects).toEqual(['dot-orders-mail', 'dot-billing-mail']);
    expect(app.manifest.plugins.map(p => p.name)).toEqual([
      'db',
      'journal',
      // A chain feature's projection is its own infra unit, listed before the feature.
      'orders/journal-projections',
      'orders',
      'billing/journal-projections',
      'billing',
      'plain',
      'journal-worker',
    ]);

    const id = orderId(++next);
    orThrow(await app.services.journal.run(db, placeOrder, { id, customerId: 'feature-mode' }, meta));
    expect(await placedCount('orders:feature-mode')).toBe(1);
    expect(await placedCount('billing:feature-mode')).toBe(1);
    await Promise.all([ordersMail.seen(id), billingMail.seen(id)]);
    expect(ordersMail.handled).toEqual([id]);
    expect(billingMail.handled).toEqual([id]);
  });

  it("lets a feature write through the journal at its own boot, with every feature's projections already in it, because the journal boots before the features", async () => {
    const counting = defineFeature('counting')
      .infra(journalProjections(countPlaced('dot-boot-count', 'boot')))
      .usecases({})
      .entrypoints();
    const id = orderId(++next);
    // A chain feature has no boot hook of its own: its infra unit boots with it.
    const writerBoot = infra({
      name: 'writer-boot',
      needs: { journal: service<TestJournal>(), db: service<PgliteDatabase>() },
      boot: async ctx => {
        orThrow(await ctx.journal.run(ctx.db, placeOrder, { id, customerId: 'at-boot' }, meta));
      },
    });
    // `writer` comes before nothing it needs: `counting` is mounted after it and its projection still runs.
    const writer = defineFeature('writer')
      .needs({ journal: service<TestJournal>(), db: service<PgliteDatabase>() })
      .infra(writerBoot)
      .usecases({})
      .entrypoints();

    track(
      await orThrow(
        defineApp('write-at-boot').infra(dbPlugin()).infra(journal({ j })).features([writer, counting]).boot(),
      ),
    );

    expect(await placedCount('boot:at-boot')).toBe(1);
  });

  it('lets an effect declared with `journalEffects` run a command of another feature through `ctx.run`', async () => {
    // Billing owns the command and hears the payment. Ordering only reacts to its own event.
    const payOrder = j.command(
      'payOrder',
      z.object({ id: z.templateLiteral(['ord_', z.string()]) }),
      (input, { write }) => write(order, input.id, () => [OrderPaid({ amount: 1 })]),
    );
    const paid = signal();
    const orderingCore = defineFeature('ordering').usecases({});
    const ordering = orderingCore.entrypoints(
      journalEffects(orderingCore, {
        effects: [
          j.effect('dot-pay-on-place', order, {
            OrderPlaced: (e, { run }) => run(payOrder, { id: e.entityId }, { actorId: 'system' }),
          }),
        ],
      }),
    );
    const billingCore = defineFeature('billing').usecases({});
    const billing = billingCore.entrypoints(
      journalEffects(billingCore, {
        effects: [j.effect('dot-paid-receipt', order, { OrderPaid: () => paid.open() })],
      }),
    );
    const app = track(
      await orThrow(
        defineApp('cross-feature')
          .infra(dbPlugin())
          .infra(journal({ j }))
          .features([ordering, billing])
          .entrypoints(journalWorker({ pollMs: POLL_MS }))
          .boot(),
      ),
    );
    await orThrow(app.start());

    const id = orderId(++next);
    orThrow(await app.services.journal.run(db, placeOrder, { id }, meta));
    await paid.opened;
    const [row] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
    expect(row?.status).toBe('paid');
    const events = await db.select().from(tables.events).where(eq(tables.events.entityId, id));
    expect(events.find(event => event.type === 'OrderPaid')?.meta).toEqual({ actorId: 'system' });
  });

  it('lists an effect in the feature manifest, so `dot explain` shows which feature owns the async work', () => {
    const mail = recorder('dot-listed-mail');
    const slice = journalHandlers({ effects: [mail.effect] });

    expect(slice.key).toBe('journal');
    expect(slice.actions).toEqual([
      {
        id: 'dot-listed-mail.run',
        binding: 'journal',
        direction: 'in',
        address: 'dot-listed-mail',
        metaSchema: '@arki/journal/action-meta@1',
        meta: { entities: ['order'], events: ['OrderPlaced'] },
      },
    ]);
  });

  type Emitter = { emit(id: OrderId): void };
  /** An effect that needs an emitter. It does not say which one: the feature that lists it does. */
  const announce = (name: string) =>
    j.effect(
      `dot-${name}-announce`,
      order,
      { emitter: need<Emitter>() },
      { OrderPlaced: (e, { emitter }) => emitter.emit(e.entityId) },
    );

  it('gives each effect the services of the feature that listed it, so two features can use one need name for two different services', async () => {
    const heard: { orders: OrderId[]; billing: OrderId[] } = { orders: [], billing: [] };
    const told = { orders: signal(), billing: signal() };
    /** One emitter plugin and its token, for the feature that wires it to its own `emitter` need. */
    const emitterOf = <const Name extends 'orders' | 'billing'>(name: Name) => {
      const EmitterToken = token<Emitter>()(`${name}.emitter`);
      // The handle-first way to publish under a per-instance key: provide locally, rename at mount.
      const emitter = rename(
        infra({
          name: `${name}-emitter`,
          provides: {
            emitter: (): Emitter => ({
              emit: id => {
                heard[name].push(id);
                told[name].open();
              },
            }),
          },
        }),
        { emitter: EmitterToken.key },
      );
      return { emitter, EmitterToken };
    };
    const ordersParts = emitterOf('orders');
    const ordersCore = defineFeature('orders').needs({ emitter: ordersParts.EmitterToken }).usecases({});
    const orders = {
      emitter: ordersParts.emitter,
      feature: ordersCore.entrypoints(journalEffects(ordersCore, { effects: [announce('orders')] })),
    };
    const billingParts = emitterOf('billing');
    const billingCore = defineFeature('billing').needs({ emitter: billingParts.EmitterToken }).usecases({});
    const billing = {
      emitter: billingParts.emitter,
      feature: billingCore.entrypoints(journalEffects(billingCore, { effects: [announce('billing')] })),
    };

    const app = track(
      await orThrow(
        defineApp('per-feature-services')
          .infra(dbPlugin())
          .infra(orders.emitter)
          .infra(billing.emitter)
          .infra(journal({ j }))
          .features([orders.feature, billing.feature])
          .entrypoints(journalWorker({ pollMs: POLL_MS }))
          .boot(),
      ),
    );
    await orThrow(app.start());

    const id = orderId(++next);
    orThrow(await app.services.journal.run(db, placeOrder, { id }, meta));
    await Promise.all([told.orders.opened, told.billing.opened]);
    expect(heard).toEqual({ orders: [id], billing: [id] });
  });

  it('lists an effect with needs in the feature manifest like any other, so `dot explain` never misses async work', () => {
    expect(journalHandlers({ effects: [announce('listed')] }).actions).toEqual([
      {
        id: 'dot-listed-announce.run',
        binding: 'journal',
        direction: 'in',
        address: 'dot-listed-announce',
        metaSchema: '@arki/journal/action-meta@1',
        meta: { entities: ['order'], events: ['OrderPlaced'] },
      },
    ]);
  });

  it('makes the feature declare what its effects need, so a forgotten service is a compile error, and a boot error when the types were bypassed', () => {
    const slice = journalHandlers({ effects: [recorder('dot-needs-nothing').effect, announce('typed')] });
    expectTypeOf(slice.resolve).parameter(0).toEqualTypeOf<{ readonly emitter: Emitter }>();
    // A feature whose effects need nothing asks its services for nothing.
    expectTypeOf(journalHandlers({ effects: [recorder('dot-plain').effect] }).resolve)
      .parameter(0)
      .toBeUnknown();
    const forgetful = defineFeature('forgetful').usecases({});
    // @ts-expect-error -- this feature needs no `emitter`, so it cannot list the effect
    forgetful.entrypoints(journalEffects(forgetful, { effects: [announce('typed')] }));

    expect(() =>
      // @ts-expect-error -- type test: these services have no `emitter`, so they do not fit the slice
      slice.resolve({}),
    ).toThrow(
      'journal: effect "dot-typed-announce" needs "emitter", but no service with that name was given; pass it as j.compose({ services: { emitter } }), or in a Dot app add it to the `needs` of the feature that lists this effect',
    );
  });

  it('fails the boot and names the effect and both features when two features declare the same effect name, so a job never has two owners and nobody has to search for the second one', async () => {
    const firstCore = defineFeature('first').usecases({});
    const first = firstCore.entrypoints(journalEffects(firstCore, { effects: [recorder('dot-twice').effect] }));
    const secondCore = defineFeature('second').usecases({});
    const second = secondCore.entrypoints(journalEffects(secondCore, { effects: [recorder('dot-twice').effect] }));

    await expect(
      defineApp('twice').infra(dbPlugin()).infra(journal({ j })).features([first, second]).boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: expect.objectContaining({
        message: expect.stringContaining('duplicate effect name "dot-twice" (features "first" and "second")'),
      }),
    });
  });

  it('fails the boot and names both features when two features declare the same projection name, so one read model is never written by two handlers', async () => {
    const first = defineFeature('first')
      .infra(journalProjections(countPlaced('dot-count-twice', 'first')))
      .usecases({})
      .entrypoints();
    const second = defineFeature('second')
      .infra(journalProjections(countPlaced('dot-count-twice', 'second')))
      .usecases({})
      .entrypoints();

    await expect(
      defineApp('twice').infra(dbPlugin()).infra(journal({ j })).features([first, second]).boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: expect.objectContaining({
        message: expect.stringContaining('duplicate projection name "dot-count-twice" (features "first" and "second")'),
      }),
    });
  });

  it('says so when one feature lists the same effect name twice, so the message does not send the reader to a second feature', async () => {
    const onlyCore = defineFeature('only').usecases({});
    const only = onlyCore.entrypoints(
      journalEffects(onlyCore, { effects: [recorder('dot-same-feature').effect, recorder('dot-same-feature').effect] }),
    );

    await expect(
      defineApp('once').infra(dbPlugin()).infra(journal({ j })).features([only]).boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: expect.objectContaining({
        message: expect.stringContaining('duplicate effect name "dot-same-feature" (feature "only", twice)'),
      }),
    });
  });

  it('refuses a `journal` slice that `journalHandlers` did not make, so a wiring mistake fails at boot and not inside a write', async () => {
    const broken = defineFeature('broken')
      .usecases({})
      .entrypoints({ kind: 'journal', key: 'journal', actions: [], resolve: () => ({}) });

    await expect(
      defineApp('broken').infra(dbPlugin()).infra(journal({ j })).features([broken]).boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: expect.objectContaining({ message: expect.stringMatching(/feature "broken"/) }),
    });
  });
});
