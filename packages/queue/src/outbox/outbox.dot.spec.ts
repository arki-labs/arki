/**
 * The outbox in a Dot app: `outboxPlugin()` provides `schedule`, a `defineFeature` feature needs it
 * and schedules in its own transaction, and `journalWorker({ jobs: outboxJobs(...) })` runs the
 * feature's `jobs(...)` slice from Postgres. Why: one slice must feed both lanes, and the worker
 * must own the consumer side of the manifest, as `queueWorker` does on the Redis lane.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { z } from '@arki/contracts';
import { defineApp } from '@arki/dot';
import { defineFeature, entrypointOnly } from '@arki/dot/feature';
import { infra, rename, service } from '@arki/dot/unit';
import { orThrow, UnexpectedDefect } from '@arki/failure';
import { initJournal } from '@arki/journal';
import { journal, journalWorker } from '@arki/journal/dot';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';

import type { FeatureJobContext, OutboxProducer } from '../dot.ts';
import type { Outbox } from './outbox.ts';
import { jobs, outboxJobs, outboxPlugin, outboxProducers } from '../dot.ts';
import { initQueue } from '../init.ts';

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
const _namedScheduling = outboxPlugin({ tables, name: 'mail-outbox' });
expectTypeOf(scheduling.provides.schedule.provider).toEqualTypeOf<'outbox'>();
expectTypeOf(_namedScheduling.provides.schedule.provider).toEqualTypeOf<'mail-outbox'>();
expectTypeOf<typeof scheduling.factories>().toEqualTypeOf<{
  readonly schedule: (ctx: never) => Outbox;
}>();

type Mailed = { readonly userId: string; readonly jobId: string | undefined; readonly tag: string };
const mailed: Mailed[] = [];
let delivered: () => void = () => {
  // replaced by each test before it schedules
};

const q = initQueue.context<{ readonly tag: string }>().create();
const welcome = q.job
  .name('mail.welcome.v1')
  .input(z.object({ userId: z.string() }))
  .handler((data, ctx) => {
    mailed.push({ userId: data.userId, jobId: ctx.job.id, tag: ctx.tag });
    delivered();
    return Promise.resolve({ sent: true });
  });

const signup = defineFeature('signup')
  .needs({ db: database.provides.db, schedule: scheduling.provides.schedule })
  .usecases({
    register:
      ({ db: root, schedule }) =>
      (userId: string) =>
        root.transaction(tx => schedule.runAfter(tx, welcome, { userId })),
  })
  .provides({ signups: ({ usecases }) => ({ register: usecases.register }) })
  .entrypoints(jobs(q.registry({ welcome })));

// Two copies of one feature, each on its own region: the copy's rows must carry its name and run its job.
const regionOf = (region: string) => infra({ name: 'region', provides: { region: () => region } });
const regionUs = regionOf('us');
const regionEu = rename(regionOf('eu'), { region: 'regionEu' }, 'regionEu');
const rq = initQueue.context<FeatureJobContext<{ readonly region: string }>>().create();
const reminded: string[] = [];
let remindedOne: () => void = () => {
  // replaced by the test before it schedules
};
const remind = rq.job
  .name('mail.remind.v1')
  .input(z.object({ userId: z.string() }))
  .handler((data, ctx) => {
    reminded.push(`${ctx.services.region}:${ctx.job.name}:${data.userId}`);
    remindedOne();
    return Promise.resolve({ sent: true });
  });
const reminders = defineFeature('reminders')
  .needs({ db: database.provides.db, schedule: scheduling.provides.schedule, region: entrypointOnly(regionUs.provides.region) })
  .infra(outboxProducers({ remind }))
  .usecases({
    remind:
      ({ db: root, jobs: producers }) =>
      (userId: string) =>
        root.transaction(tx => producers.remind.runAfter(tx, { userId })),
  })
  .provides({ reminder: ({ usecases }) => usecases })
  .entrypoints(jobs(rq.registry({ remind })));

describe('outboxPlugin + outboxJobs', () => {
  it('keeps the full outbox outcome through a feature producer when entropy is unavailable', async () => {
    expectTypeOf<ReturnType<OutboxProducer<{ userId: string }>['runAfter']>>().toEqualTypeOf<
      ReturnType<Outbox['runAfter']>
    >();
    expectTypeOf<ReturnType<OutboxProducer<{ userId: string }>['runAt']>>().toEqualTypeOf<
      ReturnType<Outbox['runAt']>
    >();
    const app = await orThrow(
      defineApp('outbox-entropy').infra(database, scheduling, regionUs).features([reminders]).boot(),
    );
    expectTypeOf<Awaited<ReturnType<typeof app.services.reminder.remind>>>().toEqualTypeOf<
      Awaited<ReturnType<Outbox['runAfter']>>
    >();
    const before = await db.select({ id: tables.jobs.id }).from(tables.jobs);
    let result: unknown;
    vi.stubGlobal('crypto', null);
    try {
      result = await app.services.reminder.remind('u-no-entropy');
    } finally {
      vi.unstubAllGlobals();
      await orThrow(app.dispose());
    }
    expect(result).toMatchObject({ code: 'contracts.random_source_unavailable', status: 500 });
    expect(await db.select({ id: tables.jobs.id }).from(tables.jobs)).toEqual(before);
  });
  it('a feature schedules in its transaction and the journal worker runs its jobs slice', async () => {
    const app = await orThrow(
      defineApp('outbox-worker')
        .infra(database, scheduling, journal({ j }))
        .features([signup])
        .entrypoints(
          journalWorker({
            pollMs: 20,
            jobs: outboxJobs({ needs: {}, context: ({ db: root }) => ({ tag: typeof root }) }),
          }),
        )
        .boot(),
    );
    await orThrow(app.start());
    try {
      const ran = new Promise<void>(resolve => {
        delivered = resolve;
      });
      const { id } = orThrow(await app.services.signups.register('u1'));
      await ran;
      expect(mailed).toEqual([{ userId: 'u1', jobId: id, tag: 'object' }]);
    } finally {
      await orThrow(app.stop());
      await orThrow(app.dispose());
    }
  });

  it('the worker claims the consumer side of the manifest; the feature only produces', () => {
    const app = orThrow(
      defineApp('outbox-explain')
        .infra(database, scheduling, journal({ j }))
        .features([signup])
        .entrypoints(journalWorker({ jobs: outboxJobs({ needs: {}, context: () => ({ tag: 'x' }) }) }))
        .configure(),
    );
    const actions = app.manifest.actions.map(action => `${action.plugin}:${action.id}`);
    expect(actions).toContain('journal-worker:mail.welcome.v1.consume');
    expect(actions).toContain('signup:mail.welcome.v1.produce');
  });

  it("an instance's row carries its instance and runs that instance's job, with its rebound need", async () => {
    const app = await orThrow(
      defineApp('outbox-regions')
        .infra(database, scheduling, regionUs, regionEu, journal({ j }))
        .features([reminders.instance('eu', { region: regionEu.provides.regionEu }), reminders.instance('us')])
        .entrypoints(
          journalWorker({ pollMs: 20, jobs: outboxJobs({ needs: {}, context: () => ({ tag: 'regions' }) }) }),
        )
        .boot(),
    );
    await orThrow(app.start());
    try {
      const ran = new Promise<void>(resolve => {
        remindedOne = resolve;
      });
      const { id } = orThrow(await app.services['reminders#eu.reminder'].remind('u2'));
      const [row] = await db.select({ jobName: tables.jobs.jobName }).from(tables.jobs).where(eq(tables.jobs.id, id));
      expect(row?.jobName).toBe('mail.remind.v1#eu');
      await ran;
      expect(reminded).toEqual(['eu:mail.remind.v1#eu:u2']);
    } finally {
      await orThrow(app.stop());
      await orThrow(app.dispose());
    }
  });

  it('an outboxJobs need the app does not provide is a compile error and fails boot', async () => {
    type Mailer = { readonly send: (to: string) => void };
    const source = outboxJobs({
      needs: { mailer: service<Mailer>() },
      context: ({ mailer }) => ({ tag: typeof mailer }),
    });
    const configured = defineApp('outbox-missing').infra(database, scheduling, journal({ j })).features([signup]);
    // @ts-expect-error -- the app provides no `mailer`
    const failure = await configured.entrypoints(journalWorker({ jobs: source })).boot();
    expect(UnexpectedDefect.is(failure)).toBe(true);
    expect(failure).toMatchObject({ cause: { message: expect.stringMatching(/mailer/) } });
  });
});
