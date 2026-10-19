/**
 * Type tests for `@arki/queue/outbox`. Checked by `tsc` (listed in `tsconfig.json` `files`);
 * the functions below are never called, they only have to compile.
 */
import type { Job as BullMQJob } from 'bullmq';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { AsyncSchemaFailure } from '@arki/failure';
import type { JobRunner } from '@arki/journal';
import { z } from '@arki/contracts';
import { orThrow } from '@arki/failure';
import { journalTables } from '@arki/journal/pg';

import type { FlowDefinition } from '../types/builder.ts';
import type { JobLike } from '../types/job.ts';
import type { OutboxTx, Scheduled } from './outbox.ts';
import { initQueue } from '../init.ts';
import { outbox } from './outbox.ts';
import { outboxRunner } from './runner.ts';

const q = initQueue.context<{ readonly tag: string }>().create();
const welcome = q.job
  .name('mail.welcome.v1')
  .input(z.object({ userId: z.string(), locale: z.enum(['en', 'ro']).optional() }))
  .handler(async () => ({ sent: true }));
const schedule = outbox({ tables: journalTables() });

declare const flow: FlowDefinition;

const compileOnly = async (db: PgliteDatabase) => {
  await db.transaction(async tx => {
    // args is the job's input
    expectTypeOf(schedule.runAfter(tx, welcome, { userId: 'u1' })).resolves.toEqualTypeOf<
      Scheduled | AsyncSchemaFailure
    >();
    orThrow(
      await schedule.runAfter(tx, welcome, { userId: 'u1', locale: 'ro' }, { delayMs: 1000, key: 'k', priority: 1 }),
    );
    orThrow(await schedule.runAt(tx, welcome, { userId: 'u1' }, new Date(), { key: 'k' }));
    // @ts-expect-error -- a wrong field
    orThrow(await schedule.runAfter(tx, welcome, { user: 'u1' }));
    // @ts-expect-error -- a missing field
    orThrow(await schedule.runAfter(tx, welcome, {}));
    // @ts-expect-error -- priority is a QueuePriority, not any number
    orThrow(await schedule.runAfter(tx, welcome, { userId: 'u1' }, { priority: 2 }));
    // @ts-expect-error -- runAt takes no delayMs
    orThrow(await schedule.runAt(tx, welcome, { userId: 'u1' }, new Date(), { delayMs: 5 }));
    // @ts-expect-error -- a flow is not a job: flows stay on the Redis lane
    orThrow(await schedule.runAfter(tx, flow, {}));
    // A savepoint fits too
    orThrow(await tx.transaction(savepoint => schedule.runAfter(savepoint, welcome, { userId: 'u1' })));
    await schedule.cancel(tx, 'job_1');
  });
  // @ts-expect-error -- a root database gives no atomicity, so it is refused
  orThrow(await schedule.runAfter(db, welcome, { userId: 'u1' }));
};

describe('outbox types', () => {
  it('compile-time checks hold (see tsc)', () => {
    expect(typeof compileOnly).toBe('function');
  });

  it('a transaction fits OutboxTx and a root database does not', () => {
    type Tx = Parameters<Parameters<PgliteDatabase['transaction']>[0]>[0];
    expectTypeOf<Tx>().toExtend<OutboxTx>();
    expectTypeOf<PgliteDatabase>().not.toExtend<OutboxTx>();
  });

  it('a BullMQ Job is a JobLike, so middleware and handlers run on both lanes', () => {
    expectTypeOf<BullMQJob>().toExtend<JobLike>();
  });

  it('outboxRunner is a JobRunner the journal worker takes', () => {
    const runner = outboxRunner({ registry: q.registry({ welcome }), context: () => ({ tag: 't' }) });
    expectTypeOf(runner).toEqualTypeOf<JobRunner>();
    expectTypeOf<JobRunner<PgliteDatabase>['run']>().parameter(1).toEqualTypeOf<{
      readonly db: PgliteDatabase;
      readonly signal: AbortSignal;
    }>();
  });
});
