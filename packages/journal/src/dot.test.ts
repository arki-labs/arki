/**
 * The Dot bridge. `journal(...)` publishes the journal and owns the worker.
 * `journalHandlers(...)` lets a feature hand over its projections and effects.
 *
 * Features here are built by hand with `plugin` and `provide`. That is what
 * `plug(defineFeature(name, { use: [slice] }))` from `@arki/feature` does, so
 * this package needs no dependency on it.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { ActionSource } from '@arki/dot/plugin';
import { bootTestApp, defineApp, rename } from '@arki/dot';
import { plugin, provide, service, token } from '@arki/dot/plugin';

import type { OrderId } from './test-support.js';
import { journal, journalHandlers } from './dot.js';
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
const apps: { stop(): Promise<void>; dispose(): Promise<void> }[] = [];

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.stop();
    await app.dispose();
  }
  // A job left by one test must not reach the next test's worker.
  await db.delete(tables.jobs).where(sql`true`);
});

afterAll(async () => {
  await client.close();
});

/** Remember the app so `afterEach` stops its worker even when the test fails. */
function track<App extends { stop(): Promise<void>; dispose(): Promise<void> }>(app: App): App {
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
const dbPlugin = () => plugin({ name: 'db', boot: () => ({ db }) });

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

/** A feature with no needs: its plugin publishes the slice payload under its `feature.<name>` token. */
function feature<Handlers>(
  name: string,
  slice: {
    readonly key: 'journal';
    readonly actions: readonly ActionSource[];
    readonly resolve: (services: unknown) => Handlers;
  },
) {
  const tok = token<{ readonly journal: Handlers }>()(`feature.${name}`);
  return {
    token: tok,
    plugin: plugin({ name, actions: slice.actions, boot: ctx => provide(tok, { journal: slice.resolve(ctx) }) }),
  };
}

const typed = initJournal
  .tx<AppTx>()
  .db<PgliteDatabase>()
  .create({ meta: z.object({ actorId: z.string().min(1) }) });
const typedJournal = typed.compose({ tables });

describe('journal(...) in direct mode', () => {
  it('publishes a journal built with the typed chain as `services.journal`, so a typed app can mount it', async () => {
    const app = track(
      await defineApp('typed')
        .use(dbPlugin())
        .use(journal({ journal: typedJournal, worker: false }))
        .boot(),
    );

    expectTypeOf(app.services.journal).toEqualTypeOf(typedJournal);
    expect(app.services.journal).toBe(typedJournal);
    // Agents read the manifest before the app boots: the service and its need must be listed.
    expect(app.manifest.services).toContainEqual({ name: 'journal', plugin: 'journal', kind: 'custom' });
    expect(app.manifest.plugins.find(p => p.name === 'journal')).toMatchObject({ dependencies: ['db'] });
  });

  it('accepts a journal from the untyped `initJournal({ meta })`, so small apps need no type steps', async () => {
    const untyped = j.compose({ tables });
    const app = track(
      await defineApp('untyped')
        .use(dbPlugin())
        .use(journal({ journal: untyped, worker: false }))
        .boot(),
    );

    expectTypeOf(app.services.journal).toEqualTypeOf<TestJournal>();
    expect(app.services.journal).toBe(untyped);
  });

  it('refuses a transaction or another database type as `db` at compile time, because the worker must see committed data', () => {
    const withTx = defineApp('tx').use(plugin({ name: 'db', boot: () => ({ db: neverBooted<AppTx>() }) }));
    // @ts-expect-error -- a transaction has `rollback`, so it is not a root database: effects would run before the outer commit.
    withTx.use(journal({ journal: j.compose({ tables }) }));
    // @ts-expect-error -- the same holds when the journal names the app's database type.
    withTx.use(journal({ journal: typedJournal }));

    type ReportsDb = PgliteDatabase & { readonly reports: true };
    const reports = initJournal
      .db<ReportsDb>()
      .create({ meta: z.object({ actorId: z.string() }) })
      .compose({ tables });
    const withPlainDb = defineApp('plain').use(dbPlugin());
    // @ts-expect-error -- this journal's effects read `ctx.db` as a `ReportsDb`; the app publishes another database type.
    withPlainDb.use(journal({ journal: reports }));

    expect(withTx.configure().manifest.plugins.map(p => p.name)).toEqual(['db']);
  });

  it('runs one worker between start and stop, so effects fire without worker code in the app and none runs during shutdown', async () => {
    const mail = recorder('dot-direct-mail');
    const composed = j.compose({ tables, effects: [mail.effect] });
    const app = track(
      await bootTestApp<{ journal: TestJournal }>([dbPlugin(), journal({ journal: composed, pollMs: POLL_MS })]),
    );
    await app.start();

    const first = orderId(++next);
    await app.services.journal.run(db, placeOrder, { id: first }, meta);
    await mail.seen(first);

    await app.stop();
    await app.services.journal.run(db, placeOrder, { id: orderId(++next) }, meta);
    await pause(QUIET_MS);

    expect(mail.handled).toEqual([first]);
    expect(await db.select().from(tables.jobs)).toHaveLength(1);
  });

  it('starts no worker with `worker: false`, so a web-only process leaves the jobs to the worker process', async () => {
    const mail = recorder('dot-no-worker-mail');
    const composed = j.compose({ tables, effects: [mail.effect] });
    const app = track(
      await bootTestApp<{ journal: TestJournal }>([
        dbPlugin(),
        journal({ journal: composed, worker: false, pollMs: POLL_MS }),
      ]),
    );
    await app.start();

    await app.services.journal.run(db, placeOrder, { id: orderId(++next) }, meta);
    await pause(QUIET_MS);

    expect(mail.handled).toEqual([]);
    expect(await db.select().from(tables.jobs)).toHaveLength(1);
  });

  it('mounts a second journal through `rename`, so one app can run two journals without a key collision', async () => {
    const main = j.compose({ tables });
    const reports = j.compose({ tables });
    const app = track(
      await defineApp('two-journals')
        .use(dbPlugin())
        .use(journal({ journal: main, worker: false }))
        .use(rename(journal({ journal: reports, worker: false }), { journal: 'reportsJournal' }, 'reports-journal'))
        .boot(),
    );

    expect(app.services.journal).toBe(main);
    expect(app.services.reportsJournal).toBe(reports);
    expect(app.manifest.plugins.map(p => p.name)).toEqual(['db', 'journal', 'reports-journal']);
  });
});

describe('journal(...) in feature mode', () => {
  it('builds the journal from the feature list alone: one command fires each inline projection and, through the worker, each effect', async () => {
    const ordersMail = recorder('dot-orders-mail');
    const billingMail = recorder('dot-billing-mail');
    const orders = feature(
      'orders',
      journalHandlers({ projections: [countPlaced('dot-orders-count', 'orders')], effects: [ordersMail.effect] }),
    );
    const billing = feature(
      'billing',
      journalHandlers({ projections: [countPlaced('dot-billing-count', 'billing')], effects: [billingMail.effect] }),
    );
    // A feature with no journal slice is allowed: it contributes nothing.
    const Plain = token<{ readonly routes: readonly string[] }>()('feature.plain');
    const plain = plugin({ name: 'plain', boot: () => provide(Plain, { routes: [] }) });

    const app = track(
      await bootTestApp<{ journal: TestJournal }>([
        dbPlugin(),
        orders.plugin,
        billing.plugin,
        plain,
        journal({ j, tables, features: [orders.token, billing.token, Plain], pollMs: POLL_MS }),
      ]),
    );
    await app.start();

    expect(app.services.journal.catalog.projections).toEqual(['dot-orders-count', 'dot-billing-count']);
    expect(app.services.journal.catalog.effects).toEqual(['dot-orders-mail', 'dot-billing-mail']);

    const id = orderId(++next);
    await app.services.journal.run(db, placeOrder, { id, customerId: 'feature-mode' }, meta);
    expect(await placedCount('orders:feature-mode')).toBe(1);
    expect(await placedCount('billing:feature-mode')).toBe(1);
    await Promise.all([ordersMail.seen(id), billingMail.seen(id)]);
    expect(ordersMail.handled).toEqual([id]);
    expect(billingMail.handled).toEqual([id]);
  });

  it('lets an effect declared with `journalHandlers` run a command of another feature through `ctx.run`, so no feature needs the journal that is built after it', async () => {
    // Billing owns the command and hears the payment. Ordering only reacts to its own event.
    const payOrder = j.command(
      'payOrder',
      z.object({ id: z.templateLiteral(['ord_', z.string()]) }),
      (input, { write }) => write(order, input.id, () => [OrderPaid({ amount: 1 })]),
    );
    const paid = signal();
    const ordering = feature(
      'ordering',
      journalHandlers({
        effects: [
          j.effect('dot-pay-on-place', order, {
            OrderPlaced: (e, { run }) => run(payOrder, { id: e.entityId }, { actorId: 'system' }),
          }),
        ],
      }),
    );
    const billing = feature(
      'billing',
      journalHandlers({ effects: [j.effect('dot-paid-receipt', order, { OrderPaid: () => paid.open() })] }),
    );
    const app = track(
      await bootTestApp<{ journal: TestJournal }>([
        dbPlugin(),
        ordering.plugin,
        billing.plugin,
        journal({ j, tables, features: [ordering.token, billing.token], pollMs: POLL_MS }),
      ]),
    );
    await app.start();

    const id = orderId(++next);
    await app.services.journal.run(db, placeOrder, { id }, meta);
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

  it('gives an effects function the booted services, so an effect can use a boot-time service such as a realtime emitter', async () => {
    type Emitter = { emit(id: OrderId): void };
    const emitted: OrderId[] = [];
    const announced = signal();
    const emitter = plugin({
      name: 'emitter',
      boot: (): { emitter: Emitter } => ({
        emitter: {
          emit: id => {
            emitted.push(id);
            announced.open();
          },
        },
      }),
    });

    const slice = journalHandlers({
      effects: (services: { readonly emitter: Emitter }) => [
        j.effect('dot-announce', order, { OrderPlaced: e => services.emitter.emit(e.entityId) }),
      ],
    });
    // The names are not known before boot, so the manifest cannot list these effects.
    expect(slice.actions).toEqual([]);

    const Announce = token<{ readonly journal: ReturnType<typeof slice.resolve> }>()('feature.announce');
    const announce = plugin({
      name: 'announce',
      needs: { emitter: service<Emitter>() },
      boot: ctx => provide(Announce, { journal: slice.resolve(ctx) }),
    });

    const app = track(
      await bootTestApp<{ journal: TestJournal }>([
        dbPlugin(),
        emitter,
        announce,
        journal({ j, tables, features: [Announce], pollMs: POLL_MS }),
      ]),
    );
    await app.start();

    const id = orderId(++next);
    await app.services.journal.run(db, placeOrder, { id }, meta);
    await announced.opened;
    expect(emitted).toEqual([id]);
  });

  it.each([
    { form: 'a list', wrap: <T>(effects: T) => effects },
    {
      form: 'a function',
      wrap:
        <T>(effects: T) =>
        () =>
          effects,
    },
  ])(
    'fails the boot and names the effect and both features when two features declare the same effect name as $form, so a job never has two owners and nobody has to search for the second one',
    async ({ wrap }) => {
      const first = feature('first', journalHandlers({ effects: wrap([recorder('dot-twice').effect]) }));
      const second = feature('second', journalHandlers({ effects: wrap([recorder('dot-twice').effect]) }));

      await expect(
        bootTestApp([
          dbPlugin(),
          first.plugin,
          second.plugin,
          journal({ j, tables, features: [first.token, second.token], worker: false }),
        ]),
      ).rejects.toThrow('duplicate effect name "dot-twice" (features "feature.first" and "feature.second")');
    },
  );

  it('fails the boot and names both features when two features declare the same projection name, so one read model is never written by two handlers', async () => {
    const first = feature('first', journalHandlers({ projections: [countPlaced('dot-count-twice', 'first')] }));
    const second = feature('second', journalHandlers({ projections: [countPlaced('dot-count-twice', 'second')] }));

    await expect(
      bootTestApp([
        dbPlugin(),
        first.plugin,
        second.plugin,
        journal({ j, tables, features: [first.token, second.token], worker: false }),
      ]),
    ).rejects.toThrow('duplicate projection name "dot-count-twice" (features "feature.first" and "feature.second")');
  });

  it('says so when one feature lists the same effect name twice, so the message does not send the reader to a second feature', async () => {
    const only = feature(
      'only',
      journalHandlers({ effects: [recorder('dot-same-feature').effect, recorder('dot-same-feature').effect] }),
    );

    await expect(
      bootTestApp([dbPlugin(), only.plugin, journal({ j, tables, features: [only.token], worker: false })]),
    ).rejects.toThrow('duplicate effect name "dot-same-feature" (feature "feature.only", twice)');
  });

  it('refuses a `journal` slice that `journalHandlers` did not make, so a wiring mistake fails at boot and not inside a write', async () => {
    const Broken = token<{ readonly journal: { readonly effects: string } }>()('feature.broken');
    const broken = plugin({ name: 'broken', boot: () => provide(Broken, { journal: { effects: 'not a list' } }) });

    await expect(
      bootTestApp([dbPlugin(), broken, journal({ j, tables, features: [Broken], worker: false })]),
    ).rejects.toThrow(/feature\.broken/);
  });
});
