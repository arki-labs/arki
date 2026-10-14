/**
 * T(queue-foreman): the Foreman module on a real runtime-local queue (pg-boss on PGlite).
 * Why it matters: a retry re-runs side effects, so an operator must see the failure they approve,
 * and the same failure must never be retried twice.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Permit } from '@arki/admin/module';
import { z } from '@arki/contracts';

import type { QueueInstance } from '../types/builder.ts';
import { createRuntimeLocalQueueInstance, initQueue } from '../runtime-local/index.ts';
import {
  pgBossFailedJobSource,
  QUEUE_FOREMAN_ERROR_CODES,
  QueueForemanError,
  queueForemanModule,
  redactSecrets,
} from './index.ts';

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
  // pg-boss runs a job 3 times before it is failed. The run after a retry waits here, so the retried job stays in flight.
  let release = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const flaky = q.job
    .name('send-mail')
    .input(z.object({ to: z.string() }))
    .handler(async () => {
      runs += 1;
      if (runs > 3) return gate;
      throw new Error('SMTP rejected: password=hunter2 for smtp://bot:s3cr3t@mail.example.com');
    });
  const instance = createRuntimeLocalQueueInstance({ pglite, createContext: () => ({ userId: 'u' }) });
  queue = instance;
  await instance.register(q.registry({ flaky }));
  await instance.start();
  await flaky.trigger({ to: 'a@b.c' });
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
  expect(error).toBeInstanceOf(QueueForemanError);
  if (!(error instanceof QueueForemanError)) throw new Error('unreachable');
  expect(error.code).toBe(code);
}

describe('T(queue-foreman)', () => {
  it('lists a failed job with its secrets redacted', async () => {
    const { jobId } = await startWithFailedJob();
    const module = queueForemanModule({ queues: { main: pgBossFailedJobSource({ pglite }) } });
    const page = await module.reads.failedJobs.run({}, {});
    expect(page.total).toBe(1);
    expect(page.nextOffset).toBeNull();
    const [job] = page.jobs;
    expect(job).toMatchObject({ id: jobId, queue: 'main', name: 'send-mail', attempts: 3 });
    expect(job?.error).toContain('SMTP rejected');
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

  it('rejects an unknown queue key', async () => {
    const module = queueForemanModule({ queues: {} });
    await expectCode(
      module.actions.retryJob.runPreview({ queue: 'nope', jobId: 'x' }, {}),
      QUEUE_FOREMAN_ERROR_CODES.unknownQueue,
    );
  });
});

describe('redactSecrets', () => {
  it('removes credentials and caps length', () => {
    expect(redactSecrets('auth failed: Bearer abcdefghijklmnop')).toBe('auth failed: Bearer [REDACTED]');
    expect(redactSecrets('{"api_key":"sk-live-abcdef123456"}')).not.toContain('abcdef123456');
    expect(redactSecrets('x'.repeat(2000)).length).toBeLessThan(510);
  });
});
