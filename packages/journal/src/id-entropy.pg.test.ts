/** Real Postgres proves refusal rolls back the event, entity, receipt and durable claim together. */
import { errorMap } from '@arki/failure/orpc';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import type { IdGenerationFailure } from '@arki/contracts';
import { ID_GENERATION_FAILURES, RandomSourceUnavailable } from '@arki/contracts';
import { TransactionDefect } from '@arki/db/transaction';
import { orThrow, UnexpectedDefect } from '@arki/failure';

import { COMMAND_FAILURES } from './errors.js';
import * as ids from './id.js';
import { initJournal } from './journal.js';
import { j, meta, order, orderId, OrderPlaced, orders, tables } from './test-support.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: NodePgDatabase;
let next = 9000;
const journal = j.compose({});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  db = drizzle({ client: pool });
  const schema = await pushSchema({ ...tables, orders }, db);
  await schema.apply();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

const input = { meta, events: () => [OrderPlaced({ customerId: 'entropy', total: 1 })] };
const history = (id: string) => db.select().from(tables.events).where(eq(tables.events.entityId, id));

describe('entropy ownership', () => {
  it('keeps canonical generation definitions in the command contract', () => {
    for (const definition of ID_GENERATION_FAILURES) expect(COMMAND_FAILURES).toContain(definition);
    // Consumers construct an RPC map from this tuple; repeated shared definitions must not crash app boot.
    expect(Object.keys(errorMap(...COMMAND_FAILURES))).toHaveLength(COMMAND_FAILURES.length);
  });

  it.each([false, true])('refuses before the command handler (provider throws: %s)', async throws => {
    vi.stubGlobal(
      'crypto',
      throws
        ? {
            getRandomValues: () => {
              throw new Error('private entropy defect');
            },
          }
        : undefined,
    );
    const handler = vi.fn(() => 'committed');
    const command = j.command('entropy-before-handler', z.object({}), handler);
    const result = await journal.run(db, command, {}, meta);
    expect(throws ? UnexpectedDefect.is(result) : RandomSourceUnavailable.is(result)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves a command-ID refusal with an existing correlation ID', async () => {
    const refused = RandomSourceUnavailable();
    vi.spyOn(ids, 'commandId').mockReturnValue(refused);
    const handler = vi.fn(() => 'wrong success');
    const command = j.command('entropy-command-id', z.object({}), handler);
    expect(await journal.run(db, command, {}, meta, { correlationId: 'cor_existing' })).toBe(refused);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns workflow run and signal entropy failures before their rows or jobs commit', async () => {
    const local = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
    const workflow = local
      .workflow('entropy-workflow', { version: 1, input: z.object({}) })
      .waitFor('ready', { signal: 'ready', schema: z.object({}) })
      .finish();
    const withWorkflow = local.compose({ workflows: [workflow], workflowMeta: meta });
    const refused = RandomSourceUnavailable();
    const runFactory = vi.spyOn(ids, 'workflowRunId').mockReturnValue(refused);
    expect(await withWorkflow.run(db, workflow.start, { input: {} }, meta)).toBe(refused);
    expect(await db.select().from(tables.workflowRuns)).toEqual([]);
    runFactory.mockRestore();
    const runId = `wfr_entropy_${++next}`;
    orThrow(await withWorkflow.run(db, workflow.start, { id: runId, input: {} }, meta));
    const prior = await history(runId);
    vi.spyOn(ids, 'workflowSignalId').mockReturnValue(refused);
    expect(
      await withWorkflow.run(db, workflow.signal('ready'), { runId, deliveryId: 'delivery', payload: {} }, meta),
    ).toBe(refused);
    expect(await db.select().from(tables.workflowSignals).where(eq(tables.workflowSignals.runId, runId))).toEqual([]);
    expect(await history(runId)).toEqual(prior);
  });

  it('returns the identical event failure and rolls back earlier handler writes and receipt', async () => {
    const id = orderId(++next);
    const refused = RandomSourceUnavailable();
    vi.spyOn(ids, 'eventId').mockReturnValue(refused);
    const target = orderId(++next);
    const writeCommand = j.command('entropy-atomic', z.object({}), async (_input, context) => {
      await context.tx.insert(orders).values({ id, customerId: 'entropy', total: 1, status: 'placed' });
      return context.write(order, target, input.events);
    });
    const result = await journal.run(db, writeCommand, {}, meta, { idempotencyKey: target });
    expect(result).toBe(refused);
    expect(await db.select().from(orders).where(eq(orders.id, id))).toEqual([]);
    expect(await history(target)).toEqual([]);
    expect(await db.select().from(tables.receipts).where(eq(tables.receipts.key, target))).toEqual([]);
  });

  it('rolls back when a handler ignores an entropy refusal', async () => {
    const id = orderId(++next);
    vi.spyOn(ids, 'eventId').mockReturnValue(RandomSourceUnavailable());
    const command = j.command('entropy-ignored', z.object({}), async (_input, context) => {
      // eslint-disable-next-line failure/must-use -- Prove the owner rolls back a handler that ignores entropy refusal.
      await context.write(order, id, input.events);
      return 'wrong success';
    });
    expect(TransactionDefect.is(await journal.run(db, command, {}, meta))).toBe(true);
    expect(await history(id)).toEqual([]);
  });

  it('rolls back entity and events when the effect job ID fails after the write', async () => {
    const id = orderId(++next);
    const refused = UnexpectedDefect({ cause: new Error('private random fault') });
    vi.spyOn(ids, 'jobId').mockReturnValue(refused);
    const effect = j.effect('entropy-effect', order, {
      OrderPlaced: () => {
        throw new Error('must never run');
      },
    });
    const withEffect = j.compose({ effects: [effect] });
    const result = await db.transaction(tx => withEffect.write(tx, order, id, input));
    expectTypeOf<Extract<typeof result, IdGenerationFailure>>().toEqualTypeOf<IdGenerationFailure>();
    expect(result).toBe(refused);
    expect(await history(id)).toEqual([]);
    expect(await db.select().from(orders).where(eq(orders.id, id))).toEqual([]);
  });

  it('refuses adopt without changing the imported row', async () => {
    const id = orderId(++next);
    await db.insert(orders).values({ id, customerId: 'entropy', total: 1, status: 'placed' });
    const refused = RandomSourceUnavailable();
    vi.spyOn(ids, 'correlationId').mockReturnValue(refused);
    expect(await journal.adopt(db, order, id, input)).toBe(refused);
    expect(await history(id)).toEqual([]);
    const imported = await db.select().from(orders).where(eq(orders.id, id));
    expect(imported[0]?.version).toBe(0);
  });

  it.each(['leaseToken', 'attemptId'] as const)(
    'refuses %s before a claim, attempt or effect can commit',
    async factory => {
      const id = `job_entropy_${++next}`;
      await db.insert(tables.jobs).values({ id, kind: 'queue', jobName: id, args: {} });
      const refused = RandomSourceUnavailable();
      vi.spyOn(ids, factory).mockReturnValue(refused);
      const run = vi.fn(() => Promise.resolve());
      const result = await journal.drain(db, {
        jobs: {
          names: [id],
          run,
          retryDelay: () => {
            return;
          },
        },
      });
      expect(result).toBe(refused);
      expect(run).not.toHaveBeenCalled();
      const storedJobs = await db.select().from(tables.jobs).where(eq(tables.jobs.id, id));
      expect(storedJobs[0]).toMatchObject({
        leaseToken: null,
        leaseUntil: null,
        attempts: 0,
      });
      expect(await db.select().from(tables.jobAttempts).where(eq(tables.jobAttempts.jobId, id))).toEqual([]);
    },
  );

  it('refuses workflow cancellation when its job audit ID cannot be generated', async () => {
    const local = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
    const workflow = local
      .workflow('entropy-cancel', { version: 1, input: z.object({}) })
      .step('work', () => 'done')
      .finish();
    const withWorkflow = local.compose({ workflows: [workflow], workflowMeta: meta });
    const runId = `wfr_entropy_${++next}`;
    orThrow(await withWorkflow.run(db, workflow.start, { id: runId, input: {} }, meta));
    const before = await history(runId);
    const refused = RandomSourceUnavailable();
    vi.spyOn(ids, 'operationId').mockReturnValue(refused);
    expect(await withWorkflow.run(db, workflow.cancel, { runId, reason: 'stop' }, meta)).toBe(refused);
    expect(await history(runId)).toEqual(before);
    const runs = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, runId));
    expect(runs[0]?.state).toBe('running');
    expect(await db.select().from(tables.jobs).where(eq(tables.jobs.runId, runId))).toHaveLength(1);
  });

  it('refuses archive export before calling an external sink when audit entropy fails', async () => {
    const id = `job_entropy_${++next}`;
    await db.insert(tables.jobs).values({ id, kind: 'queue', jobName: id, args: {}, deadAt: new Date() });
    orThrow(await journal.discard(db, id, { actor: 'entropy-test' }));
    const write = vi.fn(() => Promise.resolve());
    const exporting = initJournal({
      tables,
      meta: z.object({ actorId: z.string() }),
      retention: { archive: { sink: { name: 'entropy-sink', write } } },
    }).compose({});
    const refused = RandomSourceUnavailable();
    vi.spyOn(ids, 'operationId').mockReturnValue(refused);
    expect(await exporting.exportArchive(db)).toBe(refused);
    expect(write).not.toHaveBeenCalled();
    const archived = await db.select().from(tables.jobArchive).where(eq(tables.jobArchive.id, id));
    expect(archived[0]?.exportedAt).toBeNull();
  });

  it('rolls an operator mutation back when its audit ID fails', async () => {
    const id = `job_entropy_${++next}`;
    await db.insert(tables.jobs).values({ id, kind: 'queue', jobName: id, args: {}, deadAt: new Date() });
    const refused = RandomSourceUnavailable();
    vi.spyOn(ids, 'operationId').mockReturnValue(refused);
    expect(await journal.retry(db, id, { actor: 'entropy-test' })).toBe(refused);
    const jobs = await db.select().from(tables.jobs).where(eq(tables.jobs.id, id));
    expect(jobs[0]?.deadAt).toBeInstanceOf(Date);
    const operations = await db.select().from(tables.jobOperations);
    expect(operations.some(operation => operation.jobIds.includes(id))).toBe(false);
  });
});
