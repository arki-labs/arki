/**
 * The journal inside a `defineFeature` feature: projections in `.infra(...)`
 * (`journalProjections`), effects and taps in `.usecases(...)` as an application
 * contribution (`journalHandlers(core, …)`, deps picked with `needsOf`), and the
 * `dot explain --as journal-flow` graph.
 *
 * Why these tests exist: the journal composes BEFORE the features boot, so it
 * must find a feature's handlers in the feature value itself, wherever the
 * layers put them, and fold them into one declaration — or a write runs
 * without its projection, or a job has no owner. An effect is application code (D-8):
 * it must get its feature's private services, which entrypoints never see. And its
 * needs must be checked against the feature where it is listed, not at the first job.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { DepsOf } from '@arki/dot/feature';
import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { infra, rename, service } from '@arki/dot/unit';
import { orThrow, UnexpectedDefect } from '@arki/failure';

import type { JobsSource } from './dot.js';
import type { OrderId } from './test-support.js';
import type { JobRunner } from './types.js';
import { journal, journalHandlers, journalProjections, journalWorker, needsOf } from './dot.js';
import { jobId } from './id.js';
import { initJournal } from './journal.js';
import { project, render } from './projection.js';
import { customerOrderCounts, j, meta, openDb, order, orderId, OrderPlaced, tables } from './test-support.js';

const POLL_MS = 20;

let db: PgliteDatabase;
let client: PGlite;
let next = 9000;
const apps: Parameters<typeof track>[0][] = [];

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await orThrow(app.stop());
    await orThrow(app.dispose());
  }
  await db.delete(tables.jobs).where(sql`true`);
});

afterAll(async () => {
  await client.close();
});

function track<App extends { stop(): Promise<unknown>; dispose(): Promise<unknown> }>(app: App): App {
  apps.push(app);
  return app;
}

const dbPlugin = () => infra({ name: 'db', provides: { db: () => db } });

const placeOrder = j.command(
  'placeOrder',
  z.object({ id: z.templateLiteral(['ord_', z.string()]), customerId: z.string().default('c1') }),
  { writes: [OrderPlaced] },
  (input, { write }) => write(order, input.id, () => [OrderPlaced({ customerId: input.customerId, total: 1 })]),
);

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

/** What the effect talks to: a mailer that records who it mailed. */
type Mailer = { readonly send: (id: OrderId) => void };
const mailerUnit = (send: Mailer['send']) => infra({ name: 'mailer', provides: { mailer: (): Mailer => ({ send }) } });

/** The chain feature: its mailer is private infra; its projection sits in infra, its effect in usecases. */
function ordersFeature(sent: OrderId[], done?: (id: OrderId) => void) {
  const core = defineFeature('orders').infra(
    mailerUnit(id => {
      sent.push(id);
      done?.(id);
    }),
    journalProjections(countPlaced('chain-orders-count', 'chain')),
  );
  // reactions/order-mail.ts: the reaction is a plain value (`import type { Deps }` in a real app).
  const orderMail = j.effect(
    'chain-order-mail',
    order,
    needsOf((_: DepsOf<typeof core>) => ['mailer']),
    {
      OrderPlaced: (e, { mailer }) => mailer.send(e.entityId),
    },
  );
  return core.usecases({}, journalHandlers(core, { effects: [orderMail] })).entrypoints();
}

/** A feature with a mailer, and its effect: what the refusal tests list on a feature that lacks one. */
export const withMailer = defineFeature('with-mailer').infra(
  mailerUnit(() => {
    // Never booted: the refusal tests only list its effect on a feature that lacks a mailer.
  }),
);
const mailOf = (name: string) =>
  j.effect(
    name,
    order,
    needsOf((_: DepsOf<typeof withMailer>) => ['mailer']),
    { OrderPlaced: (e, { mailer }) => mailer.send(e.entityId) },
  );

describe('journalProjections + journalHandlers in a defineFeature feature', () => {
  it('composes the journal from both layers before boot, across features, and runs each part', async () => {
    const sent: OrderId[] = [];
    const delivered = new Map<OrderId, () => void>();
    const orders = ordersFeature(sent, id => delivered.get(id)?.());
    const billing = defineFeature('billing')
      .infra(journalProjections(countPlaced('billing-count', 'billing')))
      .usecases({})
      .entrypoints();

    const app = track(
      await orThrow(
        defineApp('chain-journal')
          .infra(dbPlugin(), journal({ j }))
          .features([orders, billing])
          .entrypoints(journalWorker({ pollMs: POLL_MS }))
          .boot(),
      ),
    );
    await orThrow(app.start());

    // One journal, every feature folded in, in feature order.
    expect(app.services.journal.catalog.projections).toEqual(['chain-orders-count', 'billing-count']);
    expect(app.services.journal.catalog.effects).toEqual(['chain-order-mail']);

    const id = orderId(++next);
    const mailed = new Promise<void>(resolve => delivered.set(id, resolve));
    orThrow(await app.services.journal.run(db, placeOrder, { id, customerId: 'mixed' }, meta));
    // Inline projections ran inside the write, from each feature's infra unit.
    expect(await placedCount('chain:mixed')).toBe(1);
    expect(await placedCount('billing:mixed')).toBe(1);
    // The effect ran in the worker with the feature's PRIVATE mailer, found by its local name.
    await mailed;
    expect(sent).toEqual([id]);
  });

  it('registers a nested child projection once: the parent lists it, the child owns it', async () => {
    const audit = defineFeature('orders.audit')
      .infra(journalProjections(countPlaced('child-audit-count', 'child')))
      .usecases({})
      .entrypoints();
    const orders = defineFeature('orders')
      .infra(journalProjections(countPlaced('parent-orders-count', 'parent')))
      .features(audit)
      .usecases({})
      .entrypoints();
    const app = track(
      await orThrow(defineApp('nested-journal').infra(dbPlugin(), journal({ j })).features([orders]).boot()),
    );
    await orThrow(app.start());
    // Without `ownUnits`, the parent's `plugins()` would list the child's unit too and `audit` would be a duplicate owner.
    expect(app.services.journal.catalog.projections).toEqual(['parent-orders-count', 'child-audit-count']);
    const id = orderId(++next);
    orThrow(await app.services.journal.run(db, placeOrder, { id, customerId: 'nested' }, meta));
    expect(await placedCount('parent:nested')).toBe(1);
    expect(await placedCount('child:nested')).toBe(1);
  });

  it('refuses a duplicate across two features and names both, so a job never has two owners', async () => {
    const chain = defineFeature('chain')
      .infra(journalProjections(countPlaced('twice-count', 'a')))
      .entrypoints();
    const legacy = defineFeature('legacy')
      .infra(journalProjections(countPlaced('twice-count', 'b')))
      .usecases({})
      .entrypoints();

    await expect(
      defineApp('twice').infra(dbPlugin(), journal({ j })).features([chain, legacy]).boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: expect.objectContaining({
        message: expect.stringContaining('duplicate projection name "twice-count" (features "chain" and "legacy")'),
      }),
    });
  });

  it("checks an effect's needs against the core where it is listed, at compile time", () => {
    const bare = defineFeature('bare');
    // @ts-expect-error -- `bare` has no `mailer` need, infra service or domain service
    const picked = () => needsOf((_: DepsOf<typeof bare>) => ['mailer']);
    // @ts-expect-error -- `bare` does not give the effect its `mailer`
    const refused = () => journalHandlers(bare, { effects: [mailOf('needs-mailer')] });
    expect(picked).toBeTypeOf('function');
    expect(refused).toBeTypeOf('function');
  });

  it('fails the feature boot when the types were bypassed and a need is missing', async () => {
    const bare = defineFeature('bare-runtime');
    // Erased on purpose: what a caller that skips the types would hand over.
    const erased: Parameters<typeof journalHandlers>[1] = { effects: [mailOf('bypassed-mailer')] };
    await expect(
      defineApp('bypassed')
        .infra(dbPlugin(), journal({ j }))
        .features([bare.usecases({}, journalHandlers(bare, erased)).entrypoints()])
        .boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: expect.objectContaining({ message: expect.stringMatching(/mailer/) }),
    });
  });
});

describe('dot explain --as journal-flow: the event graph', () => {
  // Why: nothing in the code connects a command to the effect its event starts. The graph is the one place
  // a reader sees, per event, what runs in the write and what runs later, who owns it and what it touches.
  function configuredFlow() {
    return orThrow(
      defineApp('explain')
        .infra(dbPlugin(), journal({ j }))
        .features([ordersFeature([])])
        .entrypoints(journalWorker())
        .configure(),
    );
  }

  it('derives the graph from the declarations before boot: fold, projection, reaction, owner', () => {
    const configured = configuredFlow();
    expect(configured.manifest.projections).toContainEqual(
      expect.objectContaining({ format: 'journal-flow', module: '@arki/journal/projection', plugin: 'journal' }),
    );
    const document = project(configured.manifest);
    expect(document.format).toBe('journal-flow');
    expect(document.nodes).toEqual(
      expect.arrayContaining([
        { id: 'event:OrderPlaced', kind: 'event', name: 'OrderPlaced' },
        { id: 'entity:order', kind: 'entity', name: 'order', table: 'orders' },
        { id: 'projection:chain-orders-count', kind: 'projection', name: 'chain-orders-count', lane: 'inline' },
        {
          id: 'effect:chain-order-mail',
          kind: 'effect',
          name: 'chain-order-mail',
          deps: ['mailer'],
          retry: { policy: 'default', maxRetries: 7 },
        },
        { id: 'feature:orders', kind: 'feature', name: 'orders' },
      ]),
    );
    expect(document.edges).toEqual(
      expect.arrayContaining([
        { kind: 'folds', from: 'entity:order', to: 'event:OrderPlaced', timing: 'same-transaction' },
        {
          kind: 'projects',
          from: 'projection:chain-orders-count',
          to: 'event:OrderPlaced',
          timing: 'same-transaction',
        },
        {
          kind: 'reacts',
          from: 'effect:chain-order-mail',
          to: 'event:OrderPlaced',
          timing: 'after-commit',
          delivery: 'at-least-once',
        },
        { kind: 'owned-by', from: 'effect:chain-order-mail', to: 'feature:orders' },
        { kind: 'owned-by', from: 'projection:chain-orders-count', to: 'feature:orders' },
      ]),
    );
  });

  it('prints each event with its fold first, then its projections, then its reactions', () => {
    const text = render(project(configuredFlow().manifest));
    const placed = text.split('\n\n').find(block => block.startsWith('OrderPlaced'));
    expect(placed?.split('\n')).toEqual([
      'OrderPlaced',
      '  fold order  [same transaction]',
      '  projection chain-orders-count  [same transaction]  owner orders',
      '  effect chain-order-mail  [after commit, at least once]  owner orders; deps mailer; retry default, 7 retries',
    ]);
  });

  // Why: a reader decides from this graph what a rollback undoes. A with-event run goes with the write, an
  // after-commit one does not, and the two look the same in the code that records the event.
  it('draws a with-event start as part of the write, and an after-commit start as a reaction', () => {
    const flows = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
    const started = (name: string, timing: 'after-commit' | 'with-event') =>
      flows.task(
        name,
        {
          version: 1,
          input: z.object({ id: z.string() }),
          startOn: { entity: order, event: OrderPlaced, timing, id: e => e.entityId, input: e => ({ id: e.entityId }) },
        },
        () => null,
      );
    const core = defineFeature('starts');
    const feature = core
      .usecases(
        {},
        journalHandlers(core, { workflows: [started('with-write', 'with-event'), started('later', 'after-commit')] }),
      )
      .entrypoints();
    const document = project(
      orThrow(
        defineApp('starts')
          .infra(dbPlugin())
          .infra(journal({ j: flows, workflowMeta: { actorId: 'system:workflow' } }))
          .features([feature])
          .entrypoints(journalWorker())
          .configure(),
      ).manifest,
    );
    expect(document.edges).toEqual(
      expect.arrayContaining([
        { kind: 'reacts', from: 'workflow:with-write@1', to: 'event:OrderPlaced', timing: 'same-transaction' },
        {
          kind: 'reacts',
          from: 'workflow:later@1',
          to: 'event:OrderPlaced',
          timing: 'after-commit',
          delivery: 'at-least-once',
        },
      ]),
    );
  });
});

describe('journalWorker({ jobs }): queue rows from a job runner', () => {
  // Why: `@arki/queue/dot`'s `outboxJobs()` hands the worker a runner built at boot from
  // the mounted features. Its needs must be checked with the worker's own, at boot, not at
  // the first job; here a hand-made source stands in for it.
  const mailerPlugin = (sent: string[], done: () => void) =>
    infra({
      name: 'jobs-mailer',
      provides: { mailer: (): Mailer => ({ send: id => (sent.push(id), done()) }) },
    });
  const mailerSource = (seen: { features: string[] }): JobsSource<{ mailer: ReturnType<typeof service<Mailer>> }> => ({
    needs: { mailer: service<Mailer>() },
    actions: () => [
      { id: 'welcome.consume', binding: 'queue', direction: 'in', address: 'welcome', summary: 'test runner' },
    ],
    build: (features, { mailer }): JobRunner => {
      seen.features = features.map(f => f.name);
      return {
        names: ['welcome'],
        run: job => {
          mailer.send(orderId(Number(job.args)));
          return Promise.resolve();
        },
        retryDelay: () => undefined,
      };
    },
  });

  it('builds the runner at boot with its needs and runs a queue row in the worker', async () => {
    const sent: string[] = [];
    let done: () => void = () => undefined;
    const ran = new Promise<void>(resolve => {
      done = resolve;
    });
    const seen = { features: [] as string[] };
    const app = track(
      await orThrow(
        defineApp('jobs-worker')
          .infra(
            dbPlugin(),
            journal({ j }),
            mailerPlugin(sent, () => done()),
          )
          .features([ordersFeature([])])
          .entrypoints(journalWorker({ pollMs: POLL_MS, jobs: mailerSource(seen) }))
          .boot(),
      ),
    );
    await orThrow(app.start());
    expect(seen.features).toEqual(['orders']);
    await db.insert(tables.jobs).values({ id: orThrow(jobId()), kind: 'queue', jobName: 'welcome', args: 42 });
    await ran;
    expect(sent).toEqual([orderId(42)]);
  });

  it('a source need the app does not provide fails boot, before any job', async () => {
    const seen = { features: [] as string[] };
    const configured = defineApp('jobs-missing')
      .infra(dbPlugin(), journal({ j }))
      .features([ordersFeature([])]);
    // @ts-expect-error -- the app provides no `mailer`, which the jobs source needs
    const failure = await configured.entrypoints(journalWorker({ jobs: mailerSource(seen) })).boot();
    expect(UnexpectedDefect.is(failure)).toBe(true);
    expect(failure).toMatchObject({ cause: { message: expect.stringMatching(/mailer/) } });
    expect(seen.features).toEqual([]);
  });

  it("adds the source's consumer actions to the worker's manifest", () => {
    const configured = orThrow(
      defineApp('jobs-explain')
        .infra(
          dbPlugin(),
          journal({ j }),
          mailerPlugin([], () => undefined),
        )
        .features([ordersFeature([])])
        .entrypoints(journalWorker({ jobs: mailerSource({ features: [] }) }))
        .configure(),
    );
    expect(configured.manifest.actions).toContainEqual(
      expect.objectContaining({ id: 'welcome.consume', plugin: 'journal-worker' }),
    );
  });
});

describe('feature.instance(): effect names, action ids and job dispatch follow the instance', () => {
  // Why: one declared feature mounted twice would register the same effect name twice. The journal
  // keys jobs, services and dispatch by effect name, so an instance's names carry `#<instance>`
  // while a plain feature's stay exactly as stored.
  const mailerFor = (label: string, sent: string[]) =>
    infra({ name: 'mailer', provides: { mailer: (): Mailer => ({ send: id => void sent.push(`${label}:${id}`) }) } });

  function reportsFeature(sent: string[]) {
    const us = mailerFor('us', sent);
    const eu = rename(mailerFor('eu', sent), { mailer: 'mailerEu' }, 'mailerEu');
    const core = defineFeature('reports').needs({ mailer: us.provides.mailer });
    const sendOnRequest = j.effect(
      'send-on-request',
      order,
      needsOf((_: DepsOf<typeof core>) => ['mailer']),
      {
        OrderPlaced: (e, { mailer }) => mailer.send(e.entityId),
      },
    );
    const reports = core.usecases({}, journalHandlers(core, { effects: [sendOnRequest] })).entrypoints();
    return { reports, us, eu };
  }

  it('qualifies the effects of two instances and runs each on its own rebound need', async () => {
    const sent: string[] = [];
    const { reports, us, eu } = reportsFeature(sent);
    const app = track(
      await orThrow(
        defineApp('instance-effects')
          .infra(dbPlugin(), journal({ j }), us, eu)
          .features([reports.instance('eu', { mailer: eu.provides.mailerEu }), reports.instance('us')])
          .entrypoints(journalWorker({ pollMs: POLL_MS }))
          .boot(),
      ),
    );
    await orThrow(app.start());
    expect(app.services.journal.catalog.effects).toEqual(['send-on-request#eu', 'send-on-request#us']);

    const id = orderId(++next);
    orThrow(await app.services.journal.run(db, placeOrder, { id, customerId: 'instances' }, meta));
    await vi.waitFor(() => expect(sent.toSorted()).toEqual([`eu:${id}`, `us:${id}`]));
  });

  it('names the action of an instance effect after the instance', () => {
    const { reports, us, eu } = reportsFeature([]);
    const configured = orThrow(
      defineApp('instance-actions')
        .infra(dbPlugin(), journal({ j }), us, eu)
        .features([reports.instance('eu', { mailer: eu.provides.mailerEu }), reports.instance('us')])
        .configure(),
    );
    const ids = configured.manifest.actions.filter(action => action.binding === 'journal').map(action => action.id);
    expect(ids.toSorted()).toEqual(['send-on-request#eu.run', 'send-on-request#us.run']);
  });

  it('keeps refusing two plain features that share an effect name, but not two instances', async () => {
    const { reports, us, eu } = reportsFeature([]);
    const rival = defineFeature('rival').needs({ mailer: us.provides.mailer });
    const rivalSend = j.effect(
      'send-on-request',
      order,
      needsOf((_: DepsOf<typeof rival>) => ['mailer']),
      {
        OrderPlaced: (e, { mailer }) => mailer.send(e.entityId),
      },
    );
    const clash = rival.usecases({}, journalHandlers(rival, { effects: [rivalSend] })).entrypoints();
    await expect(
      defineApp('plain-duplicate').infra(dbPlugin(), journal({ j }), us).features([reports, clash]).boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: expect.objectContaining({
        message: expect.stringContaining('duplicate effect name "send-on-request" (features "reports" and "rival")'),
      }),
    });
    const instances = defineApp('instances-ok')
      .infra(dbPlugin(), journal({ j }), us, eu)
      .features([reports.instance('eu', { mailer: eu.provides.mailerEu }), reports.instance('us')]);
    await expect(orThrow(instances.boot()).then(app => track(app))).resolves.toBeDefined();
  });

  it('leaves a plain feature byte-identical: same effect name, same action id', async () => {
    const { reports, us } = reportsFeature([]);
    const app = track(
      await orThrow(
        defineApp('plain-names')
          .infra(dbPlugin(), journal({ j }), us)
          .features([reports])
          .entrypoints(journalWorker({ pollMs: POLL_MS }))
          .boot(),
      ),
    );
    expect(app.services.journal.catalog.effects).toEqual(['send-on-request']);
    expect(app.manifest.actions.filter(action => action.binding === 'journal').map(action => action.id)).toEqual([
      'send-on-request.run',
    ]);
  });
});
