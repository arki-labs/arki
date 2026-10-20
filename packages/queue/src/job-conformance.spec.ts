/** Shared real-backend assertions: delivery acknowledgement must not hide business refusal. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StartedTestContainer } from 'testcontainers';
import { PGlite } from '@electric-sql/pglite';
import { context } from '@opentelemetry/api';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { FailureOf } from '@arki/failure';
import { Cancelled, Deadline } from '@arki/async';
import { z } from '@arki/contracts';
import { defineFailure, InvalidInput, orThrow, UnexpectedDefect } from '@arki/failure';
import { configure } from '@arki/log';
import { backoff } from '@arki/resilience';

import type { JobExecutionFailure } from './job-outcome.ts';
import type { BullMQQueueInstance, QueueInstance } from './types/builder.ts';
import type { AnyJobDefinition } from './types/job.ts';
import { bullmqFailedJobSource } from './foreman/bullmq-source.ts';
import { pgBossFailedJobSource } from './foreman/pg-boss-source.ts';
import { initQueue } from './init.ts';
import { executeJob } from './job-outcome.ts';
import { createRuntimeLocalQueueInstance } from './runtime-local/create-queue.ts';
import { pgBossJobId } from './runtime-local/identity.ts';

const Refused = defineFailure('queue.test_refused', { status: 409, data: z.object({ key: z.string() }) });
const Transient = defineFailure('queue.test_transient', { status: 503 });
const schema = z.object({ n: z.number().min(0) });
const q = initQueue.context<Record<string, never>>().create();
let redis: StartedTestContainer;
let redisUrl: string;

beforeAll(async () => {
  redis = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
}, 60_000);
afterAll(async () => {
  await redis?.stop();
}, 30_000);

async function until<Value>(read: () => Promise<Value | undefined>): Promise<Value> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Delivery did not settle within 15 seconds');
}

type StoredOutcome = { state: string; output: unknown; attempts: number };

describe.each(['bullmq', 'pg-boss'] as const)('job outcome conformance: %s', { timeout: 30_000 }, backend => {
  let instance: QueueInstance | undefined;
  let bull: BullMQQueueInstance | undefined;
  let db: PGlite | undefined;
  let name: string;
  const prefix = `conformance-${crypto.randomUUID()}`;

  afterEach(async () => {
    await instance?.stop();
    await db?.close();
    instance = undefined;
    bull = undefined;
    db = undefined;
  });

  async function start(job: AnyJobDefinition): Promise<void> {
    name = job._internal.name;
    if (backend === 'bullmq') {
      bull = q.createQueue({ connection: redisUrl, keyPrefix: prefix, createContext: () => ({}) });
      instance = bull;
    } else {
      db ??= new PGlite();
      instance = createRuntimeLocalQueueInstance({ pglite: db, createContext: () => ({}) });
    }
    await instance.register({ job });
    await instance.start();
  }

  async function stored(id: string): Promise<StoredOutcome | undefined> {
    if (bull !== undefined) {
      const queue = bull.queues().get(name);
      const state = await queue?.getJobState(id);
      if (state !== 'completed' && state !== 'failed') return;
      const job = await queue?.getJob(id);
      if (job === undefined) return;
      return {
        state,
        output: state === 'failed' ? JSON.parse(job.failedReason) : job.returnvalue,
        attempts: job.attemptsMade,
      };
    }
    if (db === undefined) throw new Error('Missing database');
    const result = await db.query<{ state: string; output: unknown; retry_count: number }>(
      `select state, output, retry_count from infra_pg_boss.job where coalesce(data->>'key',id::text) = $1 and name = $2 and state in ('completed','failed')`,
      [id, name],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : { state: row.state, output: row.output, attempts: row.retry_count + 1 };
  }

  function source() {
    if (bull !== undefined) {
      const queue = bull.queues().get(name);
      if (queue === undefined) throw new Error('Missing queue');
      return bullmqFailedJobSource({ queue });
    }
    if (db === undefined) throw new Error('Missing database');
    return pgBossFailedJobSource({ pglite: db, name });
  }

  it('persists success as completed with the original output', async () => {
    const job = q.job
      .name(`success-${crypto.randomUUID()}`)
      .input(schema)
      .handler(async () => ({ done: true }));
    await start(job);
    const id = orThrow(await job.trigger({ n: 1 }));
    expect(await until(() => stored(id))).toMatchObject({ state: 'completed', attempts: 1, output: { done: true } });
  });

  it('refuses once by default, preserving code/data in stored output and operator views', async () => {
    let runs = 0;
    const job = q.job
      .name(`refused-${crypto.randomUUID()}`)
      .input(schema)
      .handler(async () => {
        runs++;
        return Refused({ key: 'invoice-17' });
      });
    await start(job);
    const id = orThrow(await job.trigger({ n: 1 }, { jobId: `invoice-key-${crypto.randomUUID()}` }));
    const outcome = await until(() => stored(id));
    expect(outcome).toMatchObject({
      state: 'failed',
      attempts: 1,
      output: { code: Refused.code, data: { key: 'invoice-17' } },
    });
    expect(runs).toBe(1);
    const record = await source().getFailed(id);
    expect(record?.id).toBe(id);
    expect(JSON.parse(record?.error ?? 'null')).toMatchObject({ code: Refused.code, data: { key: 'invoice-17' } });
  });

  it('retries only selected definitions with the same attempt counts and millisecond delay lower bound', async () => {
    const attempts: number[] = [];
    const times: number[] = [];
    const job = q.job
      .name(`retry-${crypto.randomUUID()}`)
      .input(schema)
      .options({ retry: backoff.constant(125).upTo(2).while(Transient) })
      .handler(async (_data, ctx) => {
        attempts.push(ctx.job.attemptsMade);
        times.push(Date.now());
        return attempts.length < 3 ? Transient() : { done: true };
      });
    await start(job);
    const id = orThrow(await job.trigger({ n: 1 }));
    const outcome = await until(() => stored(id));
    expect(outcome).toMatchObject({ state: 'completed', attempts: 3, output: { done: true } });
    expect(attempts).toEqual([0, 1, 2]);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(125);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(125);
  });

  it('rejects malformed producer input and malformed persisted input before the handler', async () => {
    let runs = 0;
    const job = q.job
      .name(`invalid-${crypto.randomUUID()}`)
      .input(schema)
      .handler(async () => {
        runs++;
      });
    await start(job);
    expect(InvalidInput.is(await job.trigger({ n: -1 }))).toBe(true);
    const id = orThrow(await job.trigger({ n: 1 }, { delay: 800 }));
    if (bull !== undefined) {
      const storedJob = await bull.queues().get(name)?.getJob(id);
      await storedJob?.updateData({ n: -1 });
    } else if (db !== undefined) {
      await db.query(
        `update infra_pg_boss.job set data = $2 where coalesce(data->>'key',id::text) = $1 and name = $3`,
        [id, { version: 1, input: { n: -1 }, key: id }, name],
      );
    }
    expect(await until(() => stored(id))).toMatchObject({
      state: 'failed',
      attempts: 1,
      output: { code: InvalidInput.code },
    });
    expect(runs).toBe(0);
  });

  it('normalizes a thrown defect and never retries it by default', async () => {
    let runs = 0;
    const job = q.job
      .name(`defect-${crypto.randomUUID()}`)
      .input(schema)
      .handler(async () => {
        runs++;
        throw new Error('private credential');
      });
    await start(job);
    const id = orThrow(await job.trigger({ n: 1 }));
    const outcome = await until(() => stored(id));
    expect(outcome).toMatchObject({ state: 'failed', attempts: 1, output: { code: UnexpectedDefect.code } });
    expect(JSON.stringify(outcome)).not.toContain('private credential');
    expect(runs).toBe(1);
  });

  it('owns the deadline signal and waits for settlement before marking the delivery failed', async () => {
    let settled = false;
    const job = q.job
      .name(`deadline-${crypto.randomUUID()}`)
      .input(schema)
      .options({ timeoutMs: 20 })
      .handler(async (_data, ctx) => {
        await new Promise<void>(resolve => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
        await new Promise(resolve => setTimeout(resolve, 20));
        settled = true;
        return { done: true };
      });
    await start(job);
    const id = orThrow(await job.trigger({ n: 1 }));
    expect(await until(() => stored(id))).toMatchObject({
      state: 'failed',
      attempts: 1,
      output: { code: Deadline.code },
    });
    expect(settled).toBe(true);
  });

  it('preserves a middleware refusal without invoking the handler', async () => {
    let calls = 0;
    const refuse = q.middleware(async () => Refused({ key: 'middleware' }));
    const job = q.job
      .use(refuse)
      .name(`middleware-${crypto.randomUUID()}`)
      .input(schema)
      .handler(async () => {
        calls++;
        return { done: true };
      });
    await start(job);
    const id = orThrow(await job.trigger({ n: 1 }));
    expect(await until(() => stored(id))).toMatchObject({
      state: 'failed',
      attempts: 1,
      output: { code: Refused.code, data: { key: 'middleware' } },
    });
    expect(calls).toBe(0);
  });

  it('recovers a killed worker with the same delivery id and exposes at-least-once side effects', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'queue-worker-'));
    const id = `sync-sample-${crypto.randomUUID()}`;
    const env = {
      ...process.env,
      QUEUE_BACKEND: backend,
      QUEUE_NAME: `death-${crypto.randomUUID()}`,
      QUEUE_JOB_ID: id,
      QUEUE_PREFIX: prefix,
      QUEUE_REDIS_URL: redisUrl,
      QUEUE_DB_PATH: path.join(directory, 'db'),
      QUEUE_EFFECT_PATH: path.join(directory, 'effects'),
    };
    const children: ReturnType<typeof spawn>[] = [];
    const launch = (mode: string, status: string) => {
      const child = spawn('bun', [fileURLToPath(new URL('worker.fixture.ts', import.meta.url))], {
        env: { ...env, QUEUE_MODE: mode },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      let stderr = '';
      child.stderr?.on('data', chunk => {
        stderr = (stderr + String(chunk)).slice(-4096);
      });
      const exit = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code =>
          code === 0 || code === null ? resolve() : reject(new Error(`Worker exited ${code}: ${stderr}`)),
        );
      });
      // Observe rejection immediately while the protocol message is awaited.
      void exit.catch(() => {
        /* The protocol promise reports early child termination below. */
      });
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Worker did not report ${status}`)), 25_000);
        child.on('message', message => {
          if (typeof message === 'object' && message !== null && 'status' in message && message.status === status) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once('exit', code => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error(`Worker died before ${status}: ${stderr}`));
        });
      });
      return { child, ready, exit };
    };
    try {
      const first = launch('crash', 'active');
      await first.ready;
      // This exact ChildProcess owns the saved PID; never match another worker by a process name.
      first.child.kill('SIGKILL');
      await first.exit;
      const recovered = launch('recover', 'completed');
      await recovered.ready;
      await recovered.exit;
      const effects = await readFile(env.QUEUE_EFFECT_PATH, 'utf8');
      expect(effects.trim().split('\n')).toEqual([id, id]);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);

  it('suppresses duplicate delivery ids while retaining the stable handler id', async () => {
    const seen: (string | undefined)[] = [];
    const job = q.job
      .name(`duplicate-${crypto.randomUUID()}`)
      .input(schema)
      .handler(async (_data, ctx) => {
        seen.push(ctx.job.id);
        return { done: true };
      });
    await start(job);
    const id = `sync-sample-${crypto.randomUUID()}`;
    const ids = await Promise.all([job.trigger({ n: 1 }, { jobId: id }), job.trigger({ n: 1 }, { jobId: id })]);
    expect(ids).toEqual([id, id]);
    expect(await until(() => stored(id))).toMatchObject({ state: 'completed', attempts: 1 });
    expect(seen).toEqual([id]);
  });

  it('reuses an autogenerated delivery id before and after restart without duplicating work or operator identity', async () => {
    const seen: (string | undefined)[] = [];
    const job = q.job
      .name(`generated-id-${crypto.randomUUID()}`)
      .input(schema)
      .handler((_data, ctx) => {
        seen.push(ctx.job.id);
        return Promise.resolve(Refused({ key: 'generated-id' }));
      });
    await start(job);
    const id = orThrow(await job.trigger({ n: 1 }));
    expect(await until(() => stored(id))).toMatchObject({ state: 'failed', attempts: 1 });
    const original = await source().getFailed(id);
    expect(original?.id).toBe(id);

    for (const restart of [false, true]) {
      if (restart) {
        await instance?.stop();
        await start(job);
      }
      expect(orThrow(await job.trigger({ n: 1 }, { jobId: id }))).toBe(id);
      // Give both providers a full poll to expose an accidentally submitted second delivery.
      await new Promise(resolve => setTimeout(resolve, 650));
      expect(seen).toEqual([id]);
      const failed = await source().listFailed({ limit: 10, offset: 0 });
      expect(failed.total).toBe(1);
      expect(failed.jobs).toEqual([original]);
      if (bull !== undefined) {
        expect(await bull.queues().get(name)?.getJobCounts()).toMatchObject({ failed: 1 });
      } else if (db !== undefined) {
        const rows = await db.query<{ id: string; key: string }>(
          `select id, data->>'key' as key from infra_pg_boss.job where name = $1`,
          [name],
        );
        expect(rows.rows).toEqual([{ id: pgBossJobId(name, id), key: id }]);
      }
    }
  });
});

it('retains exact returned failures in the public executor type and canonical cancellation', async () => {
  const job = q.job
    .name('exact-type')
    .input(schema)
    .handler(async () => (Math.random() > 0.5 ? { done: true } : Refused({ key: 'a' })));
  const controller = new AbortController();
  controller.abort('private');
  const result = executeJob(
    job._internal,
    {
      name: 'exact-type',
      data: { n: 1 },
      attemptsMade: 0,
      updateProgress: () => Promise.resolve(),
      log: () => Promise.resolve(),
    },
    () => ({}),
    undefined,
    controller.signal,
  );
  expectTypeOf(result).toEqualTypeOf<Promise<{ done: boolean } | FailureOf<typeof Refused> | JobExecutionFailure>>();
  expect(Cancelled.is(await result)).toBe(true);
});

it('infers middleware refusal once, preserves success types, and rejects malformed protocol', async () => {
  const refuse = q.middleware(async () => Refused({ key: 'policy' }));
  const job = q.job
    .use(refuse)
    .name('middleware-type')
    .input(schema)
    .handler(async () => ({ done: true }));
  expectTypeOf<Awaited<ReturnType<typeof job._internal.handler>>>().toEqualTypeOf<
    { done: boolean } | FailureOf<typeof Refused>
  >();
  const result = await executeJob(
    job._internal,
    {
      name: 'middleware-type',
      data: { n: 1 },
      attemptsMade: 0,
      updateProgress: () => Promise.resolve(),
      log: () => Promise.resolve(),
    },
    () => ({}),
  );
  expect(Refused.is(result)).toBe(true);
  // @ts-expect-error Middleware returns its declared protocol or a defined failure, never a scalar.
  q.middleware(async () => 42);
});

it('keeps one execution when an app context manager throws after invoking the callback', async () => {
  let calls = 0;
  const job = q.job
    .name('broken-context')
    .input(schema)
    .handler(async () => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 1));
      return { done: true };
    });
  const broken = vi.spyOn(context, 'with').mockImplementation((_context, callback) => {
    callback();
    throw new Error('Broken application telemetry');
  });
  try {
    expect(
      await executeJob(
        job._internal,
        {
          name: 'broken-context',
          data: { n: 1 },
          attemptsMade: 0,
          updateProgress: () => Promise.resolve(),
          log: () => Promise.resolve(),
        },
        () => ({}),
      ),
    ).toEqual({ done: true });
    expect(calls).toBe(1);
  } finally {
    broken.mockRestore();
  }
});

it('normalizes malformed middleware and prevents invoking the handler twice', async () => {
  const malformed = q.middleware(async ({ ctx }) => ({ ctx }));
  Object.defineProperty(malformed, '_fn', { value: async () => 42 });
  const broken = q.job
    .use(malformed)
    .name('invalid-middleware')
    .input(schema)
    .handler(async () => ({ done: true }));
  const wireJob = {
    name: 'middleware',
    data: { n: 1 },
    attemptsMade: 0,
    updateProgress: () => Promise.resolve(),
    log: () => Promise.resolve(),
  };
  expect(UnexpectedDefect.is(await executeJob(broken._internal, wireJob, () => ({})))).toBe(true);
  let calls = 0;
  const twice = q.middleware(async ({ next }) => {
    await next();
    return next();
  });
  const guarded = q.job
    .use(twice)
    .name('twice-middleware')
    .input(schema)
    .handler(async () => {
      calls++;
      return { done: true };
    });
  expect(UnexpectedDefect.is(await executeJob(guarded._internal, wireJob, () => ({})))).toBe(true);
  expect(calls).toBe(1);
});

it('keeps logger trace-source failures from blocking or replacing a handler outcome', async () => {
  let calls = 0;
  const job = q.job
    .name('broken-logging')
    .input(schema)
    .handler(async () => {
      calls++;
      return { done: true };
    });
  const wire = {
    name: 'broken-logging',
    data: { n: 1 },
    attemptsMade: 0,
    updateProgress: () => Promise.resolve(),
    log: () => Promise.resolve(),
  };
  const configured = configure({
    channels: {
      debug: {
        write(record) {
          void record;
        },
      },
    },
    default: { channels: ['debug'], level: 'debug' },
    trace() {
      throw new Error('observer-down');
    },
  });
  try {
    expect(await executeJob(job._internal, wire, () => ({}))).toEqual({ done: true });
    expect(calls).toBe(1);
    const refused = q.job
      .name('broken-logging-refused')
      .input(schema)
      .handler(async () => Refused({ key: 'kept' }));
    expect(Refused.is(await executeJob(refused._internal, wire, () => ({})))).toBe(true);
  } finally {
    await configured.close();
  }
});

it('rejects substituted next output instead of silently swallowing a refusal', async () => {
  const substitute = q.middleware(async ({ next }) => ({
    ...(await next()),
    output: Refused({ key: 'illegal-substitution' }),
  }));
  const job = q.job
    .use(substitute)
    .name('substituted-output')
    .input(schema)
    .handler(async () => ({ done: true }));
  const wire = {
    name: 'substituted-output',
    data: { n: 1 },
    attemptsMade: 0,
    updateProgress: () => Promise.resolve(),
    log: () => Promise.resolve(),
  };
  expect(UnexpectedDefect.is(await executeJob(job._internal, wire, () => ({})))).toBe(true);
});

it('scopes deterministic native UUIDs by queue and external key', () => {
  expect(pgBossJobId('queue-a', 'sync-sample-17')).toBe(pgBossJobId('queue-a', 'sync-sample-17'));
  expect(pgBossJobId('queue-a', 'sync-sample-17')).not.toBe(pgBossJobId('queue-b', 'sync-sample-17'));
});
