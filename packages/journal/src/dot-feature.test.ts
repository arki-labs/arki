/**
 * The journal inside a `defineFeature` feature: projections in `.infra(...)`
 * (`journalProjections`), effects and taps in `.entrypoints(...)`
 * (`journalEffects`), and `dot explain` edges from event to effect.
 *
 * Why these tests exist: the journal composes BEFORE the features boot, so it
 * must find a feature's handlers in the feature value itself, wherever the
 * layers put them, and fold them into one declaration — or a write runs
 * without its projection, or a job has no owner. While both feature forms
 * exist, one journal must serve both. And an effect's needs must be checked
 * against the feature where the effect is listed, not at the first job.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { defineFeature, feature } from '@arki/dot/feature';
import { plugin, rename, service } from '@arki/dot/plugin';

import type { JobsSource } from './dot.js';
import type { OrderId } from './test-support.js';
import type { JobRunner } from './types.js';
import { journal, journalEffects, journalHandlers, journalProjections, journalWorker } from './dot.js';
import { need } from './handlers.js';
import { jobId } from './id.js';
import { project } from './projection.js';
import { customerOrderCounts, j, meta, openDb, order, orderId, OrderPlaced, tables } from './test-support.js';

const POLL_MS = 20;

let db: PgliteDatabase;
let client: PGlite;
let next = 9000;
const apps: { stop(): Promise<void>; dispose(): Promise<void> }[] = [];

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.stop();
    await app.dispose();
  }
  await db.delete(tables.jobs).where(sql`true`);
});

afterAll(async () => {
  await client.close();
});

function track<App extends { stop(): Promise<void>; dispose(): Promise<void> }>(app: App): App {
  apps.push(app);
  return app;
}

const dbPlugin = () => plugin({ name: 'db', provides: { db: () => db } });

const placeOrder = j.command(
  'placeOrder',
  z.object({ id: z.templateLiteral(['ord_', z.string()]), customerId: z.string().default('c1') }),
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
const mail = (name: string) =>
  j.effect(name, order, { mailer: need<Mailer>() }, { OrderPlaced: (e, { mailer }) => mailer.send(e.entityId) });

/** The chain feature: its mailer is private infra; its projection sits in infra, its effect in entrypoints. */
function ordersFeature(sent: OrderId[], done?: (id: OrderId) => void) {
  const mailer = plugin({
    name: 'mailer',
    provides: {
      mailer: (): Mailer => ({
        send: id => {
          sent.push(id);
          done?.(id);
        },
      }),
    },
  });
  const core = defineFeature('orders')
    .infra(mailer, journalProjections(countPlaced('chain-orders-count', 'chain')))
    .usecases({});
  // entrypoints/journal.ts: a factory over the core (`import type` in a real app).
  const orderEffects = (c: typeof core) => journalEffects(c, { effects: [mail('chain-order-mail')] });
  return core.entrypoints(orderEffects(core));
}

describe('journalProjections + journalEffects in a defineFeature feature', () => {
  it('composes the journal from both layers before boot, next to an object-form feature, and runs each part', async () => {
    const sent: OrderId[] = [];
    const delivered = new Map<OrderId, () => void>();
    const orders = ordersFeature(sent, id => delivered.get(id)?.());
    const billing = feature('billing', {
      use: [journalHandlers({ projections: [countPlaced('legacy-billing-count', 'legacy')] })],
    });

    const app = track(
      await defineApp('chain-journal')
        .infra(dbPlugin(), journal({ j, tables }))
        .features([orders, billing])
        .entrypoints(journalWorker({ pollMs: POLL_MS }))
        .boot(),
    );
    await app.start();

    // One journal, both forms folded in, in feature order.
    expect(app.services.journal.catalog.projections).toEqual(['chain-orders-count', 'legacy-billing-count']);
    expect(app.services.journal.catalog.effects).toEqual(['chain-order-mail']);

    const id = orderId(++next);
    const mailed = new Promise<void>(resolve => delivered.set(id, resolve));
    await app.services.journal.run(db, placeOrder, { id, customerId: 'mixed' }, meta);
    // Inline projections ran inside the write, from the infra unit and the legacy slice alike.
    expect(await placedCount('chain:mixed')).toBe(1);
    expect(await placedCount('legacy:mixed')).toBe(1);
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
      await defineApp('nested-journal').infra(dbPlugin(), journal({ j, tables })).features([orders]).boot(),
    );
    await app.start();
    // Without `ownUnits`, the parent's `plugins()` would list the child's unit too and `audit` would be a duplicate owner.
    expect(app.services.journal.catalog.projections).toEqual(['parent-orders-count', 'child-audit-count']);
    const id = orderId(++next);
    await app.services.journal.run(db, placeOrder, { id, customerId: 'nested' }, meta);
    expect(await placedCount('parent:nested')).toBe(1);
    expect(await placedCount('child:nested')).toBe(1);
  });

  it('refuses a duplicate across the two forms and names both features, so a job never has two owners', async () => {
    const chain = defineFeature('chain')
      .infra(journalProjections(countPlaced('twice-count', 'a')))
      .entrypoints();
    const legacy = feature('legacy', { use: [journalHandlers({ projections: [countPlaced('twice-count', 'b')] })] });

    await expect(
      defineApp('twice').infra(dbPlugin(), journal({ j, tables })).features([chain, legacy]).boot(),
    ).rejects.toThrow('duplicate projection name "twice-count" (features "chain" and "legacy")');
  });

  it("checks an effect's needs against the core where it is listed, at compile time", () => {
    const bare = defineFeature('bare').usecases({});
    // @ts-expect-error -- `bare` has no `mailer` need, infra service or usecase
    const refused = () => journalEffects(bare, { effects: [mail('needs-mailer')] });
    expect(refused).toBeTypeOf('function');
  });

  it('fails the feature boot when the types were bypassed and a need is missing', async () => {
    const bare = defineFeature('bare-runtime').usecases({});
    // Erased on purpose: what a caller that skips the types would hand over.
    const erased: Parameters<typeof journalEffects>[1] = { effects: [mail('bypassed-mailer')] };
    const entry = journalEffects(bare, erased);
    await expect(
      defineApp('bypassed')
        .infra(dbPlugin(), journal({ j, tables }))
        .features([bare.entrypoints(entry)])
        .boot(),
    ).rejects.toThrow(/mailer/);
  });
});

describe('dot explain: event → effect edges', () => {
  it('draws each effect from the events it handles, read from the manifest alone', () => {
    const orders = ordersFeature([]);
    const configured = defineApp('explain')
      .infra(dbPlugin(), journal({ j, tables }))
      .features([orders])
      .entrypoints(journalWorker())
      .configure();

    expect(configured.manifest.projections).toContainEqual(
      expect.objectContaining({ format: 'journal-flow', module: '@arki/journal/projection', plugin: 'journal' }),
    );
    expect(project(configured.manifest)).toEqual({
      format: 'journal-flow',
      edges: [{ event: 'OrderPlaced', effect: 'chain-order-mail', plugin: 'orders', entities: ['order'] }],
    });
  });
});

describe('journalWorker({ jobs }): queue rows from a job runner', () => {
  // Why: `@arki/queue/dot`'s `outboxJobs()` hands the worker a runner built at boot from
  // the mounted features. Its needs must be checked with the worker's own, at boot, not at
  // the first job; here a hand-made source stands in for it.
  const mailerPlugin = (sent: string[], done: () => void) =>
    plugin({
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
      await defineApp('jobs-worker')
        .infra(
          dbPlugin(),
          journal({ j, tables }),
          mailerPlugin(sent, () => done()),
        )
        .features([ordersFeature([])])
        .entrypoints(journalWorker({ pollMs: POLL_MS, jobs: mailerSource(seen) }))
        .boot(),
    );
    await app.start();
    expect(seen.features).toEqual(['orders']);
    await db.insert(tables.jobs).values({ id: jobId(), kind: 'queue', jobName: 'welcome', args: 42 });
    await ran;
    expect(sent).toEqual([orderId(42)]);
  });

  it('a source need the app does not provide fails boot, before any job', async () => {
    const seen = { features: [] as string[] };
    const configured = defineApp('jobs-missing')
      .infra(dbPlugin(), journal({ j, tables }))
      .features([ordersFeature([])]);
    await expect(
      // @ts-expect-error -- the app provides no `mailer`, which the jobs source needs
      configured.entrypoints(journalWorker({ jobs: mailerSource(seen) })).boot(),
    ).rejects.toThrow(/mailer/);
    expect(seen.features).toEqual([]);
  });

  it("adds the source's consumer actions to the worker's manifest", () => {
    const configured = defineApp('jobs-explain')
      .infra(
        dbPlugin(),
        journal({ j, tables }),
        mailerPlugin([], () => undefined),
      )
      .features([ordersFeature([])])
      .entrypoints(journalWorker({ jobs: mailerSource({ features: [] }) }))
      .configure();
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
    plugin({ name: 'mailer', provides: { mailer: (): Mailer => ({ send: id => void sent.push(`${label}:${id}`) }) } });

  function reportsFeature(sent: string[]) {
    const us = mailerFor('us', sent);
    const eu = rename(mailerFor('eu', sent), { mailer: 'mailerEu' }, 'mailerEu');
    const core = defineFeature('reports').needs({ mailer: us.provides.mailer }).usecases({});
    const reports = core.entrypoints(journalEffects(core, { effects: [mail('send-on-request')] }));
    return { reports, us, eu };
  }

  it('qualifies the effects of two instances and runs each on its own rebound need', async () => {
    const sent: string[] = [];
    const { reports, us, eu } = reportsFeature(sent);
    const app = track(
      await defineApp('instance-effects')
        .infra(dbPlugin(), journal({ j, tables }), us, eu)
        .features([reports.instance('eu', { mailer: eu.provides.mailerEu }), reports.instance('us')])
        .entrypoints(journalWorker({ pollMs: POLL_MS }))
        .boot(),
    );
    await app.start();
    expect(app.services.journal.catalog.effects).toEqual(['send-on-request#eu', 'send-on-request#us']);

    const id = orderId(++next);
    await app.services.journal.run(db, placeOrder, { id, customerId: 'instances' }, meta);
    await vi.waitFor(() => expect(sent.toSorted()).toEqual([`eu:${id}`, `us:${id}`]));
  });

  it('names the action of an instance effect after the instance', () => {
    const { reports, us, eu } = reportsFeature([]);
    const configured = defineApp('instance-actions')
      .infra(dbPlugin(), journal({ j, tables }), us, eu)
      .features([reports.instance('eu', { mailer: eu.provides.mailerEu }), reports.instance('us')])
      .configure();
    const ids = configured.manifest.actions.filter(action => action.binding === 'journal').map(action => action.id);
    expect(ids.toSorted()).toEqual(['send-on-request#eu.run', 'send-on-request#us.run']);
  });

  it('keeps refusing two plain features that share an effect name, but not two instances', async () => {
    const { reports, us, eu } = reportsFeature([]);
    const rival = defineFeature('rival').needs({ mailer: us.provides.mailer }).usecases({});
    const clash = rival.entrypoints(journalEffects(rival, { effects: [mail('send-on-request')] }));
    await expect(
      defineApp('plain-duplicate').infra(dbPlugin(), journal({ j, tables }), us).features([reports, clash]).boot(),
    ).rejects.toThrow('duplicate effect name "send-on-request" (features "reports" and "rival")');
    const instances = defineApp('instances-ok')
      .infra(dbPlugin(), journal({ j, tables }), us, eu)
      .features([reports.instance('eu', { mailer: eu.provides.mailerEu }), reports.instance('us')]);
    await expect(instances.boot().then(app => track(app))).resolves.toBeDefined();
  });

  it('leaves a plain feature byte-identical: same effect name, same action id', async () => {
    const { reports, us } = reportsFeature([]);
    const app = track(
      await defineApp('plain-names')
        .infra(dbPlugin(), journal({ j, tables }), us)
        .features([reports])
        .entrypoints(journalWorker({ pollMs: POLL_MS }))
        .boot(),
    );
    expect(app.services.journal.catalog.effects).toEqual(['send-on-request']);
    expect(app.manifest.actions.filter(action => action.binding === 'journal').map(action => action.id)).toEqual([
      'send-on-request.run',
    ]);
  });
});
