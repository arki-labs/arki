/**
 * T(queue-foreman-bullmq): the Foreman module on a real BullMQ queue (real Redis).
 * Why it matters: a retry re-runs side effects, so an operator must see the failure they approve,
 * and the same failure must never be retried twice.
 */
import type { StartedTestContainer } from 'testcontainers';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Permit } from '@arki/admin/module';
import { isModuleError } from '@arki/admin/module';
import { z } from '@arki/contracts';
import { backoff } from '@arki/resilience';

import type { BullMQQueueInstance } from '../types/builder.ts';
import { initQueue } from '../init.ts';
import { bullmqFailedJobSource, QUEUE_FOREMAN_ERROR_CODES, queueForemanModule } from './index.ts';

let redisContainer: StartedTestContainer;
let redisUrl: string;
let instance: BullMQQueueInstance | undefined;

beforeAll(async () => {
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
}, 60_000);

afterEach(async () => {
  await instance?.stop();
  instance = undefined;
});

afterAll(async () => {
  await redisContainer?.stop();
}, 30_000);

async function waitFor(done: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await done()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting');
}

/** Two queues. `send-mail` fails on every run until `release()`; `other` is an unrelated queue. */
async function start() {
  const q = initQueue.context<{ userId: string }>().create();
  let runs = 0;
  let open = false;
  const sendMail = q.job
    .name(`send-mail-${crypto.randomUUID()}`)
    .input(z.object({ to: z.string() }))
    .options({ retry: backoff.constant(0).upTo(0) })
    .handler(() => {
      runs += 1;
      if (open) return Promise.resolve('sent');
      throw new Error('SMTP rejected: password=hunter2 for smtp://bot:s3cr3t@mail.example.com');
    });
  const other = q.job
    .name(`other-${crypto.randomUUID()}`)
    .input(z.object({ n: z.number() }))
    .options({ retry: backoff.constant(0).upTo(0) })
    .handler(() => {
      throw new Error('other failed');
    });
  const created = q.createQueue({
    connection: redisUrl,
    keyPrefix: `t-${crypto.randomUUID()}:`,
    createContext: () => ({ userId: 'u' }),
  });
  instance = created;
  await created.register(q.registry({ sendMail, other }));
  await created.start();

  const queues = created.queues();
  const mailQueue = queues.get(sendMail._internal.name);
  const otherQueue = queues.get(other._internal.name);
  if (!mailQueue || !otherQueue) throw new Error('queues() did not expose the registered queues');

  const failedCount = async (queue: typeof mailQueue) => queue.getFailedCount();
  const mail = await sendMail.trigger({ to: 'a@b.c' });
  const otherJob = await other.trigger({ n: 1 });
  await waitFor(async () => (await failedCount(mailQueue)) === 1 && (await failedCount(otherQueue)) === 1);

  const module = queueForemanModule({
    queues: {
      mail: bullmqFailedJobSource({ queue: mailQueue }),
      other: bullmqFailedJobSource({ queue: () => otherQueue }),
    },
  });
  return {
    module,
    mailId: String(mail),
    otherId: String(otherJob),
    runs: () => runs,
    openGate: () => {
      open = true;
    },
  };
}

function permit(expectedRevision: string): Permit {
  return { executionId: 'exe_1', expectedRevision, approvedBy: 'usr_1' };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => null,
    (error_: unknown) => error_,
  );
  if (!isModuleError(error)) throw new Error(`expected a ModuleError, got ${String(error)}`);
  return error.code;
}

describe('T(queue-foreman-bullmq)', () => {
  it('exposes the BullMQ queues by name through queues()', async () => {
    const { module } = await start();
    expect([...(instance?.queues().keys() ?? [])]).toHaveLength(2);
    expect(module.id).toBe('@arki/queue');
  }, 60_000);

  it('lists a failed job with its secrets redacted', async () => {
    const { module, mailId } = await start();
    const page = await module.reads.failedJobs.run({ queue: 'mail' }, {});
    expect(page.total).toBe(1);
    const [job] = page.jobs;
    expect(job).toMatchObject({ id: mailId, queue: 'mail', attempts: 1 });
    expect(job?.error).toContain('failure.unexpected_defect');
    expect(job?.error).not.toContain('hunter2');
    expect(job?.error).not.toContain('s3cr3t');
    const all = await module.reads.failedJobs.run({}, {});
    expect(all.total).toBe(2);
  }, 60_000);

  it('retries once, and blocks a second retry with the same revision', async () => {
    const { module, mailId, runs, openGate } = await start();
    openGate();
    const input = { queue: 'mail', jobId: mailId };
    const preview = await module.actions.retryJob.runPreview(input, {});
    const before = runs();
    expect(await module.actions.retryJob.runExecute(input, {}, permit(preview.revision))).toEqual({
      requeued: true,
      jobId: mailId,
    });
    await waitFor(() => runs() > before);
    expect(await codeOf(module.actions.retryJob.runExecute(input, {}, permit(preview.revision)))).toBe(
      QUEUE_FOREMAN_ERROR_CODES.notFailed,
    );
  }, 60_000);

  it('rejects a stale revision and leaves the job failed', async () => {
    const { module, mailId } = await start();
    const code = await codeOf(
      module.actions.retryJob.runExecute({ queue: 'mail', jobId: mailId }, {}, permit('rev_from_an_older_failure')),
    );
    expect(code).toBe(QUEUE_FOREMAN_ERROR_CODES.staleRevision);
    expect((await module.reads.failedJobs.run({ queue: 'mail' }, {})).total).toBe(1);
  }, 60_000);

  it('attack: a job id from another queue, and a revision from another job, change nothing', async () => {
    const { module, mailId, otherId } = await start();
    // The id of the `other` job aimed at the `mail` queue (ids are per queue, so this id may not exist there).
    const forged = await module.actions.retryJob.runPreview({ queue: 'mail', jobId: `${otherId}-x` }, {}).then(
      () => 'ok',
      (error: unknown) => (isModuleError(error) ? error.code : 'other'),
    );
    expect(forged).toBe(QUEUE_FOREMAN_ERROR_CODES.notFailed);
    // BullMQ keeps its own bookkeeping under the same key prefix, so a hostile id such as "meta" must not read as a job.
    for (const jobId of ['meta', 'id', 'failed', 'stalled-check', 'a:b']) {
      expect(await codeOf(module.actions.retryJob.runPreview({ queue: 'mail', jobId }, {}))).toBe(
        QUEUE_FOREMAN_ERROR_CODES.notFailed,
      );
    }
    // A revision approved for the `other` job is stale for the `mail` job, even when the job ids match.
    const otherPreview = await module.actions.retryJob.runPreview({ queue: 'other', jobId: otherId }, {});
    expect(
      await codeOf(
        module.actions.retryJob.runExecute({ queue: 'mail', jobId: mailId }, {}, permit(otherPreview.revision)),
      ),
    ).toBe(QUEUE_FOREMAN_ERROR_CODES.staleRevision);
    expect((await module.reads.failedJobs.run({}, {})).total).toBe(2);
  }, 60_000);

  it('attack: two concurrent retries re-queue the job exactly once', async () => {
    const { module, mailId, runs, openGate } = await start();
    openGate();
    const input = { queue: 'mail', jobId: mailId };
    const preview = await module.actions.retryJob.runPreview(input, {});
    const before = runs();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => module.actions.retryJob.runExecute(input, {}, permit(preview.revision))),
    );
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await waitFor(() => runs() > before);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(runs()).toBe(before + 1);
  }, 60_000);
});
