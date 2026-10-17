/**
 * T(journal-foreman) — the jobs module on a real journal (PGlite). Why each rule exists:
 *  - an approval is for the job the operator saw: a job that changed since the preview is refused (E001);
 *  - every refusal has a code a UI can match on (E002 to E005), and the HTTP answer is 409 or 400;
 *  - nothing secret leaves: lists carry no payload, errors are redacted, a payload shows only on request;
 *  - the operations audit names the approver and the execution that asked.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Permit } from '@arki/admin/module';

import { attemptId, jobId } from '../id.js';
import { j, meta, openDb, order, orderId, OrderPaid, OrderPlaced, tables } from '../test-support.js';
import { JOURNAL_JOBS_ERROR_CODES, journalJobsModule } from './index.js';
import { foremanHarness } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
let sent = 0;
let next = 5000;

const DAY = 86_400_000;
const NO_CTX = {} as const;

const sendWelcomeMail = j.effect('sendWelcomeMail', order, {
  OrderPaid: () => {
    sent += 1;
  },
});
const journal = j.compose({ tables, effects: [sendWelcomeMail] });
const hidden = () => journalJobsModule({ journal, db });
const redacted = () => journalJobsModule({ journal, db, payload: 'redacted' });

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  sent = 0;
  await db.delete(tables.jobs);
  await db.delete(tables.jobArchive);
  await db.delete(tables.jobOperations);
});

const permit = (expectedRevision: string): Permit => ({
  executionId: 'exe_1',
  expectedRevision,
  approvedBy: 'usr_alice',
});

/** One paid order: one `sendWelcomeMail` job row. */
async function welcomeMailJob(): Promise<string> {
  const id = orderId(++next);
  await db.transaction(tx =>
    journal.write(tx, order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
  );
  const paid = await db.transaction(tx =>
    journal.write(tx, order, id, { meta, events: () => [OrderPaid({ amount: 1 })] }),
  );
  const [row] = await db
    .select()
    .from(tables.jobs)
    .where(eq(tables.jobs.eventSeq, paid.events[0]?.seq ?? -1));
  if (row === undefined) throw new Error('expected a job row');
  return row.id;
}

/** Dies after 8 tries: the hot row is dead and eight attempt rows say why. */
async function kill(id: string, error = 'provider 503 password=hunter2', ageDays = 1): Promise<void> {
  const deadAt = new Date(Date.now() - ageDays * DAY);
  await db.update(tables.jobs).set({ deadAt, attempts: 8, lastError: error }).where(eq(tables.jobs.id, id));
  for (let attempt = 1; attempt <= 8; attempt++) {
    const startedAt = new Date(deadAt.getTime() - (9 - attempt) * 60_000);
    await db.insert(tables.jobAttempts).values({
      id: attemptId(),
      jobId: id,
      attempt,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 1000),
      outcome: attempt === 8 ? 'dead' : 'retry',
      error,
    });
  }
}

type Insert = typeof tables.jobs.$inferInsert;
const queueRow = async (extra?: Partial<Insert>): Promise<string> => {
  const id = jobId();
  await db.insert(tables.jobs).values({ id, kind: 'queue', jobName: 'demo', args: { n: 1 }, ...extra });
  return id;
};
const operations = () => db.select().from(tables.jobOperations);

describe('T(journal-foreman) the worked example', () => {
  it('lists a dead sendWelcomeMail job, shows its error redacted, and retryJob previews, executes and the job runs', async () => {
    const module = hidden();
    const id = await welcomeMailJob();
    await kill(id);

    const counts = await module.reads.jobCounts.run({}, NO_CTX);
    expect(counts.counts).toEqual([
      expect.objectContaining({ kind: 'effect', name: 'sendWelcomeMail', ready: 0, delayed: 0, running: 0, dead: 1 }),
    ]);
    const detail = await module.reads.job.run({ id }, NO_CTX);
    expect(detail.event).toMatchObject({ type: 'OrderPaid' });
    expect(detail.attempts).toHaveLength(8);
    expect(JSON.stringify(detail)).not.toContain('hunter2');
    expect(detail.attempts[0]?.error).toContain('[REDACTED]');
    expect(detail).not.toHaveProperty('payload');

    const preview = await module.actions.retryJob.runPreview({ jobId: id, reason: 'provider outage' }, NO_CTX);
    expect(preview.consequence).toContain('side effects');
    const done = await module.actions.retryJob.runExecute(
      { jobId: id, reason: 'provider outage' },
      NO_CTX,
      permit(preview.revision),
    );
    expect(done.jobId).toBe(id);

    expect(await journal.drain(db)).toBe(1);
    expect(sent).toBe(1);
    expect(await journal.job(db, id)).toBeUndefined();
    expect(await journal.archivedJob(db, id)).toMatchObject({ outcome: 'completed' });
    expect(await operations()).toEqual([
      expect.objectContaining({
        id: done.operationId,
        action: 'retry',
        actor: 'usr_alice',
        executionId: 'exe_1',
        reason: 'provider outage',
        jobIds: [id],
      }),
    ]);
  });
});

describe('T(journal-foreman) approvals are for what the operator saw', () => {
  it('a job that died again after the preview is refused with E001 and stays dead', async () => {
    const module = hidden();
    const id = await welcomeMailJob();
    await kill(id);
    const preview = await module.actions.retryJob.runPreview({ jobId: id }, NO_CTX);
    await db.update(tables.jobs).set({ attempts: 9, deadAt: new Date() }).where(eq(tables.jobs.id, id));

    await expect(
      module.actions.retryJob.runExecute({ jobId: id }, NO_CTX, permit(preview.revision)),
    ).rejects.toMatchObject({ code: JOURNAL_JOBS_ERROR_CODES.staleRevision });
    expect(JOURNAL_JOBS_ERROR_CODES.staleRevision).toBe('ARKI_JOURNAL_E001');
    expect((await journal.job(db, id))?.state).toBe('dead');
    expect(await operations()).toHaveLength(0);
  });

  it('retryDead is all or nothing on the previewed set: one revived job voids the whole approval', async () => {
    const module = hidden();
    const [a, b] = [await welcomeMailJob(), await welcomeMailJob()];
    if (a === undefined || b === undefined) throw new Error('expected two jobs');
    await kill(a);
    await kill(b);
    const input = { ids: [a, b], limit: 100 };
    const preview = await module.actions.retryDead.runPreview(input, NO_CTX);
    expect(preview.count).toBe(2);
    await journal.retry(db, b, { actor: 'someone-else' });

    await expect(module.actions.retryDead.runExecute(input, NO_CTX, permit(preview.revision))).rejects.toMatchObject({
      code: JOURNAL_JOBS_ERROR_CODES.staleRevision,
    });
    expect((await journal.job(db, a))?.state).toBe('dead');
  });

  it('retryDead by filter retries exactly the previewed dead jobs and writes one operation row', async () => {
    const module = hidden();
    const [a, b] = [await welcomeMailJob(), await welcomeMailJob()];
    await kill(a);
    await kill(b);
    const input = { effect: 'sendWelcomeMail', limit: 100, reason: 'outage over' };
    const preview = await module.actions.retryDead.runPreview(input, NO_CTX);
    const done = await module.actions.retryDead.runExecute(input, NO_CTX, permit(preview.revision));
    expect([...done.ids].toSorted()).toEqual([a, b].toSorted());
    expect(await operations()).toEqual([
      expect.objectContaining({ action: 'retryDead', actor: 'usr_alice', count: 2, reason: 'outage over' }),
    ]);
  });

  it('a stale approval comes over the signed protocol as HTTP 409 with its code', async () => {
    const id = await welcomeMailJob();
    await kill(id);
    const { client: foreman, lastStatus, permit: claim } = await foremanHarness(hidden());
    const preview = await foreman.preview('journal.retryJob', { jobId: id }, ['journal:retry']);
    const revision = typeof preview === 'object' && preview !== null && 'revision' in preview ? preview.revision : '';
    await db.update(tables.jobs).set({ attempts: 9 }).where(eq(tables.jobs.id, id));

    await expect(
      foreman.execute(
        'journal.retryJob',
        { jobId: id },
        {
          scopes: ['journal:retry'],
          permit: claim('exe_wire', 'journal.retryJob', typeof revision === 'string' ? revision : ''),
        },
      ),
    ).rejects.toMatchObject({ code: 'ARKI_JOURNAL_E001' });
    expect(lastStatus()).toBe(409);
  });
});

describe('T(journal-foreman) a job must be in the state the action needs', () => {
  it('retryJob and discardJob on a live job are refused with E002 at preview, before anything is approved', async () => {
    const module = hidden();
    const id = await welcomeMailJob();
    await expect(module.actions.retryJob.runPreview({ jobId: id }, NO_CTX)).rejects.toMatchObject({
      code: 'ARKI_JOURNAL_E002',
    });
    await expect(module.actions.discardJob.runPreview({ jobId: id }, NO_CTX)).rejects.toMatchObject({
      code: 'ARKI_JOURNAL_E002',
    });
    await expect(module.actions.retryJob.runPreview({ jobId: 'job_gone' }, NO_CTX)).rejects.toMatchObject({
      code: 'ARKI_JOURNAL_E002',
    });
  });

  it('cancelJob on a leased job is E004 because a worker holds it, and on a waiting job it archives it as cancelled', async () => {
    const module = hidden();
    const running = await queueRow({ leaseToken: 'tok', leaseUntil: new Date(Date.now() + 60_000), attempts: 1 });
    await expect(module.actions.cancelJob.runPreview({ jobId: running }, NO_CTX)).rejects.toMatchObject({
      code: 'ARKI_JOURNAL_E004',
    });

    const waiting = await queueRow();
    const preview = await module.actions.cancelJob.runPreview({ jobId: waiting }, NO_CTX);
    // The lease arrives between preview and execute: the job changed, so the approval is void.
    await db
      .update(tables.jobs)
      .set({ leaseToken: 'tok', leaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(tables.jobs.id, waiting));
    await expect(
      module.actions.cancelJob.runExecute({ jobId: waiting }, NO_CTX, permit(preview.revision)),
    ).rejects.toMatchObject({ code: 'ARKI_JOURNAL_E001' });

    await db.update(tables.jobs).set({ leaseToken: null, leaseUntil: null }).where(eq(tables.jobs.id, waiting));
    const again = await module.actions.cancelJob.runPreview({ jobId: waiting }, NO_CTX);
    await module.actions.cancelJob.runExecute({ jobId: waiting }, NO_CTX, permit(again.revision));
    expect(await journal.archivedJob(db, waiting)).toMatchObject({ outcome: 'cancelled' });
  });

  it('risk and permission follow the plan, so nothing destructive hides under journal:read', () => {
    const module = hidden();
    const actions = Object.values(module.actions).map(action => [action.id, action.permission, action.risk]);
    expect(actions).toEqual(
      expect.arrayContaining([
        ['journal.retryJob', 'journal:retry', 'low'],
        ['journal.retryDead', 'journal:retry', 'medium'],
        ['journal.discardJob', 'journal:delete', 'medium'],
        ['journal.purgeDead', 'journal:delete', 'medium'],
        ['journal.cancelJob', 'journal:delete', 'high'],
        ['journal.replayJob', 'journal:retry', 'high'],
      ]),
    );
    expect(Object.values(module.reads).map(read => read.permission)).toEqual(
      Object.values(module.reads).map(() => 'journal:read'),
    );
  });
});

describe('T(journal-foreman) nothing secret leaves', () => {
  it('lists never carry args or a payload, whatever the payload option says', async () => {
    const secret = { apiKey: 'sk-live-abcdefghijklmnop' };
    const id = await queueRow({ args: secret });
    const other = await queueRow({ args: secret });
    await journal.cancel(db, other, { actor: 'a' });
    for (const module of [hidden(), redacted()]) {
      const lists = JSON.stringify([
        await module.reads.jobs.run({ status: 'all' }, NO_CTX),
        await module.reads.archivedJobs.run({}, NO_CTX),
        await module.reads.jobOperations.run({}, NO_CTX),
      ]);
      expect(lists).toContain(id);
      expect(lists).not.toContain('sk-live');
      expect(lists).not.toContain('"args"');
      expect(lists).not.toContain('"payload"');
    }
  });

  it('archivedJob shows the attempt log redacted and the payload only when the option says so', async () => {
    const id = await queueRow({ args: { to: 'a@b.c', token: 'sk-live-abcdefghijklmnop' } });
    await kill(id, 'smtp://bot:s3cr3t@mail.example.com refused');
    await journal.discard(db, id, { actor: 'alice', reason: 'bad address' });

    const quiet = await hidden().reads.archivedJob.run({ id }, NO_CTX);
    expect(quiet.job.outcome).toBe('discarded');
    expect(quiet.attempts).toHaveLength(8);
    expect(JSON.stringify(quiet)).not.toContain('s3cr3t');
    expect(quiet.attempts[0]?.error).toContain('[REDACTED]');
    expect(quiet).not.toHaveProperty('payload');
    expect(quiet.operations).toEqual([expect.objectContaining({ action: 'discard', actor: 'alice' })]);

    const shown = await redacted().reads.archivedJob.run({ id }, NO_CTX);
    expect(shown.payload).toContain('a@b.c');
    expect(shown.payload).not.toContain('sk-live-abcdefghijklmnop');
    expect(shown.payload).toContain('[REDACTED]');
  });
});

describe('T(journal-foreman) replay and purge', () => {
  it('replayJob is high risk, pins the archived row, and maps JOB_EXISTS to E005', async () => {
    const module = hidden();
    expect(module.actions.replayJob.risk).toBe('high');
    const id = await queueRow({ dedupeKey: 'welcome:1' });
    await journal.cancel(db, id, { actor: 'a' });

    const preview = await module.actions.replayJob.runPreview({ id }, NO_CTX);
    expect(preview.consequence).toContain('new job id');

    // The archived row changed after the preview (it was archived again): the pin no longer matches.
    await db
      .update(tables.jobArchive)
      .set({ archivedAt: new Date(Date.now() + 1000) })
      .where(eq(tables.jobArchive.id, id));
    await expect(module.actions.replayJob.runExecute({ id }, NO_CTX, permit(preview.revision))).rejects.toMatchObject({
      code: 'ARKI_JOURNAL_E001',
    });

    // A live job holds the dedupe key, so the replay is blocked.
    await queueRow({ dedupeKey: 'welcome:1' });
    const blocked = await module.actions.replayJob.runPreview({ id }, NO_CTX);
    await expect(module.actions.replayJob.runExecute({ id }, NO_CTX, permit(blocked.revision))).rejects.toMatchObject({
      code: JOURNAL_JOBS_ERROR_CODES.exists,
    });
    expect(JOURNAL_JOBS_ERROR_CODES.exists).toBe('ARKI_JOURNAL_E005');
  });

  it('replayJob creates a new job that remembers where it came from, and the audit names the approver', async () => {
    const module = hidden();
    const id = await queueRow();
    await journal.cancel(db, id, { actor: 'a' });
    const preview = await module.actions.replayJob.runPreview({ id, reason: 'needed after all' }, NO_CTX);
    const done = await module.actions.replayJob.runExecute(
      { id, reason: 'needed after all' },
      NO_CTX,
      permit(preview.revision),
    );
    expect(done.jobId).not.toBe(id);
    expect(await journal.job(db, done.jobId)).toMatchObject({ replayOf: id, state: 'ready' });
    expect((await operations()).find(row => row.action === 'replay')).toMatchObject({
      actor: 'usr_alice',
      executionId: 'exe_1',
      reason: 'needed after all',
    });
  });

  it('purgeDead refuses a bound shorter than journal.retention.retryableFor with E003', async () => {
    const module = hidden();
    const id = await queueRow();
    await kill(id, 'boom', 60);
    // The default retryableFor is 30 days.
    await expect(module.actions.purgeDead.runPreview({ olderThanDays: 10, limit: 100 }, NO_CTX)).rejects.toMatchObject({
      code: JOURNAL_JOBS_ERROR_CODES.boundTooShort,
    });
    expect(JOURNAL_JOBS_ERROR_CODES.boundTooShort).toBe('ARKI_JOURNAL_E003');
    expect((await journal.job(db, id))?.state).toBe('dead');
  });

  it('purgeDead previews what the policy will do and archives the old dead jobs under the approver', async () => {
    const module = hidden();
    const old = await queueRow();
    const recent = await queueRow();
    await kill(old, 'boom', 60);
    await kill(recent, 'boom', 2);
    const input = { olderThanDays: 31, limit: 100, reason: 'tidy up' };
    const preview = await module.actions.purgeDead.runPreview(input, NO_CTX);
    expect(preview).toMatchObject({ willDo: 'archive', deadJobs: 2 });

    const done = await module.actions.purgeDead.runExecute(input, NO_CTX, permit(preview.revision));
    expect(done).toMatchObject({ archived: 1, deleted: 0 });
    expect(await journal.archivedJob(db, old)).toMatchObject({ outcome: 'dead' });
    expect((await journal.job(db, recent))?.state).toBe('dead');
    expect(await operations()).toEqual([
      expect.objectContaining({ action: 'purgeDead', actor: 'usr_alice', reason: 'tidy up' }),
    ]);
  });
});
