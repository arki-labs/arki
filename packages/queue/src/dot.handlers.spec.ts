/**
 * A feature's job reports to the app's handler observers: `starting`, then `completed` or `failed`,
 * with `feature` = the unit that owns the job and `name` = the job name.
 * Why it matters: observers (`logHandlers()`, `reportErrors()`) see jobs the way they see rpc and http.
 * Watching must not change outcomes: a thrown handler error still reaches the queue's retry, and an
 * app with no observer runs jobs exactly as before. The jobs run from Postgres (`outboxJobs`), which
 * shares the `jobs(...)` slice with the Redis worker, so one wrap covers both lanes.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import type { DotHandlerLifecycleEvent, DotLifecycleEvent } from '@arki/dot';
import { z } from '@arki/contracts';
import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { infra } from '@arki/dot/unit';
import { defineFailure, orThrow } from '@arki/failure';
import { initJournal } from '@arki/journal';
import { journal, journalWorker } from '@arki/journal/dot';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';
import { backoff } from '@arki/resilience';

import { jobs, outboxJobs, outboxPlugin } from './dot.ts';
import { initQueue } from './init.ts';

const tables = journalTables();
const j = initJournal({ tables, meta: z.object({}) });

let db: PgliteDatabase;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openJournalDb({ ...tables }));
});

afterAll(async () => {
  await db.delete(tables.jobs).where(sql`true`);
  await client.close();
});

const database = infra({ name: 'db', provides: { db: (): PgliteDatabase => db } });
const scheduling = outboxPlugin({ tables });

const Declined = defineFailure('queue.handlers_test_declined', { status: 402 });
const q = initQueue.context<Record<string, never>>().create();

const attemptsOf = new Map<string, number>();
const ranKeys: string[] = [];

const charge = q.job
  .name('billing.charge.v1')
  .input(z.object({ key: z.string(), mode: z.enum(['ok', 'refuse', 'flaky']) }))
  .options({ retry: backoff.constant(10).upTo(2) })

  .handler((data): Promise<{ charged: boolean } | ReturnType<typeof Declined>> => {
    const attempt = (attemptsOf.get(data.key) ?? 0) + 1;
    attemptsOf.set(data.key, attempt);
    ranKeys.push(data.key);
    if (data.mode === 'refuse') return Promise.resolve(Declined());
    if (data.mode === 'flaky' && attempt === 1) throw new Error('gateway down');
    return Promise.resolve({ charged: true });
  });

const billing = defineFeature('billing')
  .needs({ schedule: scheduling.provides.schedule, db: database.provides.db })
  .usecases({
    charge:
      ({ db: root, schedule }) =>
      (key: string, mode: 'ok' | 'refuse' | 'flaky') =>
        root.transaction(tx => schedule.runAfter(tx, charge, { key, mode })),
  })
  .provides({ billers: ({ usecases }) => ({ charge: usecases.charge }) })
  .entrypoints(jobs(q.registry({ charge })));

// The slice keeps the registry type the feature declared, so callers infer from it.
const billingRegistry = q.registry({ charge });
expectTypeOf(jobs(billingRegistry).resolve({})).toEqualTypeOf<{
  readonly registry: typeof billingRegistry;
  readonly services: object;
}>();

function isHandlerEvent(event: DotLifecycleEvent): event is DotHandlerLifecycleEvent {
  return event.kind === 'handler';
}

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('The job did not settle within 10 seconds');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function bootBilling(observers: readonly ((event: DotLifecycleEvent) => void)[]) {
  const app = await orThrow(
    defineApp('billing-app', { observers })
      .infra(database, scheduling, journal({ j }))
      .features([billing])
      .entrypoints(journalWorker({ pollMs: 20, jobs: outboxJobs({ needs: {}, context: () => ({}) }) }))
      .boot(),
  );
  await orThrow(app.start());
  return app;
}

describe('job handler events', () => {
  it('emits starting then completed ok, named after the feature and the job', async () => {
    const events: DotHandlerLifecycleEvent[] = [];
    const app = await bootBilling([event => isHandlerEvent(event) && events.push(event)]);
    try {
      orThrow(await app.services.billers.charge('ok-1', 'ok'));
      await until(() => events.some(event => event.status === 'completed'));
      expect(events.map(({ status, transport, feature, name }) => ({ status, transport, feature, name }))).toEqual([
        { status: 'starting', transport: 'job', feature: 'billing', name: 'billing.charge.v1' },
        { status: 'completed', transport: 'job', feature: 'billing', name: 'billing.charge.v1' },
      ]);
      expect(events[1]).toMatchObject({ outcome: 'ok' });
    } finally {
      await orThrow(app.stop());
      await orThrow(app.dispose());
    }
  });

  it('a returned Failure is completed/refused, carries the failure, and is not retried', async () => {
    const events: DotHandlerLifecycleEvent[] = [];
    const app = await bootBilling([event => isHandlerEvent(event) && events.push(event)]);
    try {
      orThrow(await app.services.billers.charge('refuse-1', 'refuse'));
      await until(() => events.some(event => event.status === 'completed'));
      await new Promise(resolve => setTimeout(resolve, 150));
      const completed = events.filter(event => event.status === 'completed');
      expect(completed).toHaveLength(1);
      expect(completed[0]?.outcome).toBe('refused');
      expect(
        completed[0] !== undefined && completed[0].failure !== undefined && Declined.is(completed[0].failure),
      ).toBe(true);
      expect(ranKeys.filter(key => key === 'refuse-1')).toHaveLength(1);
    } finally {
      await orThrow(app.stop());
      await orThrow(app.dispose());
    }
  });

  it('a throw is failed and the job still retries by its backoff', async () => {
    const events: DotHandlerLifecycleEvent[] = [];
    const app = await bootBilling([event => isHandlerEvent(event) && events.push(event)]);
    try {
      orThrow(await app.services.billers.charge('flaky-1', 'flaky'));
      await until(() => events.some(event => event.status === 'completed'));
      expect(events.map(event => event.status)).toEqual(['starting', 'failed', 'starting', 'completed']);
      const failed = events.find(event => event.status === 'failed');
      expect(failed?.error).toEqual(new Error('gateway down'));
      expect(attemptsOf.get('flaky-1')).toBe(2);
    } finally {
      await orThrow(app.stop());
      await orThrow(app.dispose());
    }
  });

  it('with no observer the job runs as before', async () => {
    const app = await bootBilling([]);
    try {
      orThrow(await app.services.billers.charge('plain-1', 'flaky'));
      await until(() => attemptsOf.get('plain-1') === 2);
      expect(attemptsOf.get('plain-1')).toBe(2);
    } finally {
      await orThrow(app.stop());
      await orThrow(app.dispose());
    }
  });
});
