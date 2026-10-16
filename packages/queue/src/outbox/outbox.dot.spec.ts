/**
 * The outbox in a Dot app: `outboxPlugin()` provides `schedule`, a `defineFeature` feature needs it
 * and schedules in its own transaction, and `journalWorker({ jobs: outboxJobs(...) })` runs the
 * feature's `jobs(...)` slice from Postgres. Why: one slice must feed both lanes, and the worker
 * must own the consumer side of the manifest, as `queueWorker` does on the Redis lane.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { z } from '@arki/contracts';
import { defineApp } from '@arki/dot';
import { defineFeature } from '@arki/dot/feature';
import { plugin, service } from '@arki/dot/plugin';
import { initJournal } from '@arki/journal';
import { journal, journalWorker } from '@arki/journal/dot';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';

import { jobs, outboxJobs, outboxPlugin } from '../dot.ts';
import { initQueue } from '../init.ts';

const tables = journalTables();
const j = initJournal({ meta: z.object({}) });

let db: PgliteDatabase;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openJournalDb({ ...tables }));
});

afterAll(async () => {
  await db.delete(tables.jobs).where(sql`true`);
  await client.close();
});

const database = plugin({ name: 'db', provides: { db: (): PgliteDatabase => db } });
const scheduling = outboxPlugin({ tables });

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
  .usecases({})
  .provides({
    signups: ({ db: root, schedule }) => ({
      register: (userId: string) => root.transaction(tx => schedule.runAfter(tx, welcome, { userId })),
    }),
  })
  .entrypoints(jobs(q.registry({ welcome })));

describe('outboxPlugin + outboxJobs', () => {
  it('a feature schedules in its transaction and the journal worker runs its jobs slice', async () => {
    const app = await defineApp('outbox-worker')
      .infra(database, scheduling, journal({ j, tables }))
      .features([signup])
      .entrypoints(
        journalWorker({ pollMs: 20, jobs: outboxJobs({ needs: {}, context: ({ db: root }) => ({ tag: typeof root }) }) }),
      )
      .boot();
    await app.start();
    try {
      const ran = new Promise<void>(resolve => {
        delivered = resolve;
      });
      const { id } = await app.services.signups.register('u1');
      await ran;
      expect(mailed).toEqual([{ userId: 'u1', jobId: id, tag: 'object' }]);
    } finally {
      await app.stop();
      await app.dispose();
    }
  });

  it('the worker claims the consumer side of the manifest; the feature only produces', () => {
    const app = defineApp('outbox-explain')
      .infra(database, scheduling, journal({ j, tables }))
      .features([signup])
      .entrypoints(journalWorker({ jobs: outboxJobs({ needs: {}, context: () => ({ tag: 'x' }) }) }))
      .configure();
    const actions = app.manifest.actions.map(action => `${action.plugin}:${action.id}`);
    expect(actions).toContain('journal-worker:mail.welcome.v1.consume');
    expect(actions).toContain('signup:mail.welcome.v1.produce');
  });

  it('an outboxJobs need the app does not provide is a compile error and fails boot', async () => {
    type Mailer = { readonly send: (to: string) => void };
    const source = outboxJobs({ needs: { mailer: service<Mailer>() }, context: ({ mailer }) => ({ tag: typeof mailer }) });
    const configured = defineApp('outbox-missing').infra(database, scheduling, journal({ j, tables })).features([signup]);
    // @ts-expect-error -- the app provides no `mailer`
    await expect(configured.entrypoints(journalWorker({ jobs: source })).boot()).rejects.toThrow(/mailer/);
  });
});
