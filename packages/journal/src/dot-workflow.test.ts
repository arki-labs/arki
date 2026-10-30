/**
 * Workflows in the Dot adapter: `journalHandlers(core, { workflows })` in `.usecases(...)`.
 *
 * Why these tests exist: `workflow.step` is ONE effect shared by every workflow, but a Dot feature's
 * services belong to the feature. A step must get the services of the feature that declared its
 * workflow, even when two features use one need name for two different services, and a missing
 * need must fail the feature's boot, not the first step of a run.
 *
 * Each test builds its own `initJournal()`: a journal composes workflows once.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { defineApp, rename } from '@arki/dot';
import type { DepsOf } from '@arki/dot/feature';
import { defineFeature } from '@arki/dot/feature';
import { infra, service, token } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';

import { journal, journalHandlers, journalWorker, needsOf } from './dot.js';
import { initJournal } from './journal.js';
import { tables } from './test-support.js';
import { openJournalDb } from './testing.js';

const POLL_MS = 20;
const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const apps: Parameters<typeof track>[0][] = [];

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await orThrow(app.stop());
    await orThrow(app.dispose());
  }
});
afterAll(() => client.close());

function track<App extends { stop(): Promise<unknown>; dispose(): Promise<unknown> }>(app: App): App {
  apps.push(app);
  return app;
}

const dbPlugin = () => infra({ name: 'db', provides: { db: () => db } });
const freshJournal = () => initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });

/** What a feature's steps talk to: a provider that has a name. */
type Provider = { readonly name: string };
const providerOf = (name: string) =>
  infra({ name: `${name}-provider`, provides: { provider: (): Provider => ({ name }) } });

/** A feature with a provider, and a workflow that picks it: what the refusal test lists on a feature that lacks one. */
export const withProvider = defineFeature('with-provider').needs({ provider: service<Provider>() });

const newId = () => `wfr_dot_${++counter}`;
const stateOf = async (id: string) =>
  (await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id)))[0]?.state;
const completed = (id: string) =>
  vi.waitFor(async () => expect(await stateOf(id)).toBe('completed'), { timeout: 5000 });

describe('journalHandlers(core, { workflows }) in a feature', () => {
  it("a feature's workflows are composed and started through services.journal", async () => {
    const wj = freshJournal();
    const hello = wj
      .workflow('dot.hello', { version: 1, input: z.object({}) })
      .step('greet', () => 'hi')
      .finish();
    const greeterCore = defineFeature('greeter');
    const greeter = greeterCore.usecases({}, journalHandlers(greeterCore, { workflows: [hello] })).entrypoints();
    const app = track(
      await orThrow(defineApp('wf-compose')
        .infra(dbPlugin())
        .infra(journal({ j: wj, workflowMeta }))
        .features([greeter])
        .entrypoints(journalWorker({ pollMs: POLL_MS }))
        .boot()),
    );
    await orThrow(app.start());
    const id = newId();
    orThrow(await app.services.journal.run(db, hello.start, { input: {}, id }, caller));
    await completed(id);
    expect((await app.services.journal.workflows.run(db, id))?.run.output).toBe('hi');
  });

  it('a workflow step gets the services of the feature that declared it', async () => {
    const wj = freshJournal();
    const seen: string[] = [];
    const ordersCore = defineFeature('orders').needs({ provider: service<Provider>() });
    const flow = wj
      .workflow('dot.needs', { version: 1, input: z.object({}), needs: needsOf((_: DepsOf<typeof ordersCore>) => ['provider']) })
      .step('call', ({ provider }) => void seen.push(provider.name))
      .finish();
    const orders = ordersCore.usecases({}, journalHandlers(ordersCore, { workflows: [flow] })).entrypoints();
    const app = track(
      await orThrow(defineApp('wf-services')
        .infra(dbPlugin())
        .infra(journal({ j: wj, workflowMeta }))
        .infra(providerOf('orders'))
        .features([orders])
        .entrypoints(journalWorker({ pollMs: POLL_MS }))
        .boot()),
    );
    await orThrow(app.start());
    const id = newId();
    orThrow(await app.services.journal.run(db, flow.start, { input: {}, id }, caller));
    await completed(id);
    expect(seen).toEqual(['orders']);
  });

  it("two features' workflows each get their own feature's services", async () => {
    // Why: both workflows read the need `provider`. One flat set would hand both the same service.
    const wj = freshJournal();
    const seen: string[] = [];
    const partsOf = <const Name extends string>(name: Name) => {
      const Token = token<Provider>()(`${name}.provider`);
      return { Token, provider: rename(providerOf(name), { provider: Token.key }) };
    };
    const ordersParts = partsOf('orders');
    const ordersCore = defineFeature('orders').needs({ provider: ordersParts.Token });
    const ordersFlow = wj
      .workflow('dot.orders', { version: 1, input: z.object({}), needs: needsOf((_: DepsOf<typeof ordersCore>) => ['provider']) })
      .step('call', ({ provider }) => void seen.push(`orders:${provider.name}`))
      .finish();
    const orders = {
      ...ordersParts,
      flow: ordersFlow,
      feature: ordersCore.usecases({}, journalHandlers(ordersCore, { workflows: [ordersFlow] })).entrypoints(),
    };
    const billingParts = partsOf('billing');
    const billingCore = defineFeature('billing').needs({ provider: billingParts.Token });
    const billingFlow = wj
      .workflow('dot.billing', { version: 1, input: z.object({}), needs: needsOf((_: DepsOf<typeof billingCore>) => ['provider']) })
      .step('call', ({ provider }) => void seen.push(`billing:${provider.name}`))
      .finish();
    const billing = {
      ...billingParts,
      flow: billingFlow,
      feature: billingCore.usecases({}, journalHandlers(billingCore, { workflows: [billingFlow] })).entrypoints(),
    };
    const app = track(
      await orThrow(defineApp('wf-two-features')
        .infra(dbPlugin())
        .infra(orders.provider)
        .infra(billing.provider)
        .infra(journal({ j: wj, workflowMeta }))
        .features([orders.feature, billing.feature])
        .entrypoints(journalWorker({ pollMs: POLL_MS }))
        .boot()),
    );
    await orThrow(app.start());
    const first = newId();
    const second = newId();
    orThrow(await app.services.journal.run(db, orders.flow.start, { input: {}, id: first }, caller));
    orThrow(await app.services.journal.run(db, billing.flow.start, { input: {}, id: second }, caller));
    await Promise.all([completed(first), completed(second)]);
    expect(seen.toSorted()).toEqual(['billing:billing', 'orders:orders']);
  });

  it('refuses a workflow that two features declare, naming both', async () => {
    const wj = freshJournal();
    const flow = wj
      .workflow('dot.twice', { version: 1, input: z.object({}) })
      .step('a', () => 1)
      .finish();
    const oneCore = defineFeature('one');
    const one = oneCore.usecases({}, journalHandlers(oneCore, { workflows: [flow] })).entrypoints();
    const twoCore = defineFeature('two');
    const two = twoCore.usecases({}, journalHandlers(twoCore, { workflows: [flow] })).entrypoints();
    await expect(
      defineApp('wf-twice')
        .infra(dbPlugin())
        .infra(journal({ j: wj, workflowMeta }))
        .features([one, two])
        .boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: expect.objectContaining({
        message: expect.stringContaining('duplicate workflow name "dot.twice@1" (features "one" and "two")'),
      }),
    });
  });

  it("a missing workflow need fails the feature's boot, not the first step", async () => {
    const wj = freshJournal();
    const flow = wj
      .workflow('dot.missing', { version: 1, input: z.object({}), needs: needsOf((_: DepsOf<typeof withProvider>) => ['provider']) })
      .step('call', ({ provider }) => provider.name)
      .finish();
    // Erased on purpose: what a caller that skips the types would hand over (the types refuse it).
    const erased: Parameters<typeof journalHandlers>[1] = { workflows: [flow] };
    const bareCore = defineFeature('bare');
    const bare = bareCore.usecases({}, journalHandlers(bareCore, erased)).entrypoints();
    await expect(
      defineApp('wf-missing')
        .infra(dbPlugin())
        .infra(journal({ j: wj, workflowMeta }))
        .features([bare])
        .entrypoints(journalWorker({ pollMs: POLL_MS }))
        .boot(),
    ).resolves.toMatchObject({
      code: 'failure.unexpected_defect',
      cause: expect.objectContaining({ message: expect.stringMatching(/provider/) }),
    });
  });

  it("a workflow's action lists its signals in the manifest", () => {
    const wj = freshJournal();
    const approval = z.object({ ok: z.boolean() });
    const flow = wj
      .workflow('dot.approve', { version: 2, input: z.object({}) })
      .waitFor('approval', { signal: 'approved', schema: approval })
      .finish();
    const approvalsCore = defineFeature('approvals');
    const approvals = approvalsCore.usecases({}, journalHandlers(approvalsCore, { workflows: [flow] })).entrypoints();
    const configured = orThrow(defineApp('wf-manifest')
      .infra(dbPlugin())
      .infra(journal({ j: wj, workflowMeta }))
      .features([approvals])
      .configure());
    expect(configured.manifest.actions.filter(action => action.binding === 'journal')).toEqual([
      expect.objectContaining({
        id: 'dot.approve@2.run',
        address: 'dot.approve',
        metaSchema: '@arki/journal/action-meta@1',
        meta: { entities: [], events: [], signals: ['approved'] },
      }),
    ]);
  });
});

describe('a workflow need on an app infra handle', () => {
  it("a step gets the provider the feature's need names, read through needsOf", async () => {
    const wj = freshJournal();
    const seen: string[] = [];
    const refunds = providerOf('refunds');
    const core = defineFeature('refunds').needs({ provider: refunds.provides.provider });
    const flow = wj
      .workflow('dot.chain', { version: 1, input: z.object({}), needs: needsOf((_: DepsOf<typeof core>) => ['provider']) })
      .step('call', ({ provider }) => void seen.push(provider.name))
      .finish();
    const app = track(
      await orThrow(defineApp('wf-chain')
        .infra(dbPlugin(), refunds, journal({ j: wj, workflowMeta }))
        .features([core.usecases({}, journalHandlers(core, { workflows: [flow] })).entrypoints()])
        .entrypoints(journalWorker({ pollMs: POLL_MS }))
        .boot()),
    );
    await orThrow(app.start());
    const id = newId();
    orThrow(await app.services.journal.run(db, flow.start, { input: {}, id }, caller));
    await completed(id);
    expect(seen).toEqual(['refunds']);
  });
});

describe('journalWorker() and workflows', () => {
  it('the worker runs workflow steps and timers like any effect', async () => {
    // Why: the sleep is woken by `workflow.timer`, the steps around it run in `workflow.step`: one worker serves both.
    const wj = freshJournal();
    const order: string[] = [];
    const flow = wj
      .workflow('dot.nap', { version: 1, input: z.object({}) })
      .step('before', () => void order.push('before'))
      .sleep('nap', () => new Date(Date.now() + 100))
      .step('after', () => void order.push('after'))
      .finish();
    const sleepyCore = defineFeature('sleepy');
    const sleepy = sleepyCore.usecases({}, journalHandlers(sleepyCore, { workflows: [flow] })).entrypoints();
    const app = track(
      await orThrow(defineApp('wf-timer')
        .infra(dbPlugin())
        .infra(journal({ j: wj, workflowMeta }))
        .features([sleepy])
        .entrypoints(journalWorker({ pollMs: POLL_MS }))
        .boot()),
    );
    await orThrow(app.start());
    const id = newId();
    orThrow(await app.services.journal.run(db, flow.start, { input: {}, id }, caller));
    await completed(id);
    expect(order).toEqual(['before', 'after']);
  });
});
