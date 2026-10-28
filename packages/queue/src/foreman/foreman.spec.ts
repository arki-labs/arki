/**
 * T(queue-foreman): the Foreman module on a real runtime-local queue (pg-boss on PGlite).
 * Why it matters: a retry re-runs side effects, so an operator must see the failure they approve,
 * and the same failure must never be retried twice.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Permit } from '@arki/admin/module';
import { redactSecrets as adminRedactSecrets, isModuleError } from '@arki/admin/module';
import { z } from '@arki/contracts';
import { orThrow } from '@arki/failure';
import { backoff } from '@arki/resilience';

import type { QueueInstance } from '../types/builder.ts';
import { createRuntimeLocalQueueInstance, initQueue } from '../runtime-local/index.ts';
import { pgBossFailedJobSource, QUEUE_FOREMAN_ERROR_CODES, queueForemanModule, redactSecrets } from './index.ts';

let pglite: PGlite;
let queue: QueueInstance | undefined;

beforeEach(() => {
  pglite = new PGlite();
});

afterEach(async () => {
  await queue?.stop();
  queue = undefined;
  await pglite.close();
});

async function waitFor(done: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await done()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting');
}

/** Starts a queue whose job always fails, and returns the id of the failed job. */
async function startWithFailedJob(): Promise<{ jobId: string; runs: () => number; release: () => void }> {
  const q = initQueue.context<{ userId: string }>().create();
  let runs = 0;
  // `upTo(0)` allows no retry, so the first throw is final. The operator retry waits here, so it stays in flight.
  let release = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const flaky = q.job
    .name('send-mail')
    .input(z.object({ to: z.string() }))
    .options({ retry: backoff.constant(0).upTo(0) })
    .handler(async () => {
      runs += 1;
      if (runs > 1) return gate;
      throw new Error('SMTP rejected: password=hunter2 for smtp://bot:s3cr3t@mail.example.com');
    });
  const instance = createRuntimeLocalQueueInstance({ pglite, createContext: () => ({ userId: 'u' }) });
  queue = instance;
  await instance.register(q.registry({ flaky }));
  await instance.start();
  orThrow(await flaky.trigger({ to: 'a@b.c' }));
  const failed = async () =>
    (await pglite.query(`select 1 from infra_pg_boss.job where state = 'failed'`)).rows.length === 1;
  await waitFor(failed);
  const rows = await pglite.query<{ id: string }>(
    `select id::text as id from infra_pg_boss.job where state = 'failed'`,
  );
  return { jobId: rows.rows[0]?.id ?? '', runs: () => runs, release };
}

function permit(expectedRevision: string): Permit {
  return { executionId: 'exe_1', expectedRevision, approvedBy: 'usr_1' };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (error_: unknown) => error_,
  );
  expect(isModuleError(error)).toBe(true);
  expect(error).toMatchObject({ code });
}

describe('T(queue-foreman)', () => {
  it('lists a failed job with its secrets redacted', async () => {
    const { jobId } = await startWithFailedJob();
    const module = queueForemanModule({ queues: { main: pgBossFailedJobSource({ pglite }) } });
    const page = await module.reads.failedJobs.run({}, {});
    expect(page.total).toBe(1);
    expect(page.nextOffset).toBeNull();
    const [job] = page.jobs;
    expect(job).toMatchObject({ id: jobId, queue: 'main', name: 'send-mail', attempts: 1 });
    expect(job?.error).toContain('failure.unexpected_defect');
    expect(job?.error).not.toContain('hunter2');
    expect(job?.error).not.toContain('s3cr3t');
  }, 20000);

  it('retries once, and blocks a second retry with the same revision', async () => {
    const { jobId, runs, release } = await startWithFailedJob();
    const module = queueForemanModule({ queues: { main: pgBossFailedJobSource({ pglite }) } });
    const input = { queue: 'main', jobId };
    const preview = await module.actions.retryJob.runPreview(input, {});
    expect(preview.consequence).toMatch(/runs again once/);
    const before = runs();

    const result = await module.actions.retryJob.runExecute(input, {}, permit(preview.revision));
    expect(result).toEqual({ requeued: true, jobId });
    await waitFor(async () => runs() > before); // the worker really picked it up again

    await expectCode(
      module.actions.retryJob.runExecute(input, {}, permit(preview.revision)),
      QUEUE_FOREMAN_ERROR_CODES.notFailed,
    );
    release();
  }, 30000);

  it('rejects a stale revision and writes nothing', async () => {
    const { jobId } = await startWithFailedJob();
    const module = queueForemanModule({ queues: { main: pgBossFailedJobSource({ pglite }) } });
    await expectCode(
      module.actions.retryJob.runExecute({ queue: 'main', jobId }, {}, permit('rev_from_an_older_failure')),
      QUEUE_FOREMAN_ERROR_CODES.staleRevision,
    );
    const state = await pglite.query<{ state: string }>(`select state from infra_pg_boss.job where id::text = $1`, [
      jobId,
    ]);
    expect(state.rows[0]?.state).toBe('failed');
  }, 20000);

  it('rejects an offset past the bound, so one read cannot force an unbounded scan', async () => {
    const module = queueForemanModule({ queues: { main: pgBossFailedJobSource({ pglite }) } });
    await expect(module.reads.failedJobs.run({ offset: 10_001 }, {})).rejects.toMatchObject({
      code: 'ARKI_ADMIN_E004',
    });
  });

  it('rejects an unknown queue key', async () => {
    const module = queueForemanModule({ queues: {} });
    await expectCode(
      module.actions.retryJob.runPreview({ queue: 'nope', jobId: 'x' }, {}),
      QUEUE_FOREMAN_ERROR_CODES.unknownQueue,
    );
  });
});

describe('redactSecrets', () => {
  it('is the same function @arki/admin owns, so existing importers of @arki/queue/foreman keep working', () => {
    expect(redactSecrets).toBe(adminRedactSecrets);
  });
});
