import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import type { Failure } from '@arki/failure';
import { defineFailure, isFailure, orThrow } from '@arki/failure';

import type { CommandFailure } from './errors.js';
import type {
  AcceptFailure,
  CommandContext,
  EffectContext,
  JobDetail,
  JobOperationInput,
  JobRetention,
  JobState,
} from './index.js';
import { CommandInvalid, initJournal } from './index.js';
import { j, meta, order, tables } from './test-support.js';

// Compile-time only: tsc checks this file, vitest does not run it.
const journal = j.compose({});
const db = null as unknown as Parameters<typeof journal.jobs>[0];
const op: JobOperationInput = { actor: 'a' };

describe('the job surface, as types', () => {
  it('retention accepts ages and { age, max } and rejects a malformed age', () => {
    expectTypeOf<{ archive: { completed: '30d' } }>().toExtend<JobRetention>();
    expectTypeOf<{ archive: { completed: { age: '30d'; max: 100 } } }>().toExtend<JobRetention>();
    expectTypeOf<{ archive: { completed: 3600 } }>().toExtend<JobRetention>();
    expectTypeOf<{ archive: { completed: '30x' } }>().not.toExtend<JobRetention>();
    initJournal({ tables, retention: { archive: { completed: '30d' } } });
    initJournal({ tables, retention: { archive: { dead: { age: '90d', max: 1000 } } } });
    // @ts-expect-error '30x' is not an age
    initJournal({ tables, retention: { archive: { completed: '30x' } } });
    // @ts-expect-error retention is given once, to initJournal
    j.compose({ retention: { archive: { completed: '30d' } } });
  });

  it('op is required on every verb that changes jobs', () => {
    void journal.retry(db, 'job_1', op).then(result => orThrow(result));
    // @ts-expect-error a mutating verb names who did it
    void journal.retry(db, 'job_1').then(result => orThrow(result));
    // @ts-expect-error a mutating verb names who did it
    void journal.discard(db, 'job_1').then(result => orThrow(result));
    // @ts-expect-error a mutating verb names who did it
    void journal.cancel(db, 'job_1').then(result => orThrow(result));
    // @ts-expect-error a mutating verb names who did it
    void journal.retryDead(db, { ids: ['job_1'] }).then(result => orThrow(result));
    // @ts-expect-error a mutating verb names who did it
    void journal.purgeDead(db, { olderThan: new Date() }).then(result => orThrow(result));
    // @ts-expect-error an actor is required
    void journal.retry(db, 'job_1', {}).then(result => orThrow(result));
  });

  it('withSchedule takes a retention', () => {
    j.effect('mail', order, { OrderPaid: () => {} }).withSchedule({
      retention: { completed: false, dead: '30d', retryableFor: '7d' },
    });
    j.effect('mail', order, { OrderPaid: () => {} }).withSchedule({
      // @ts-expect-error '30x' is not an age
      retention: { completed: '30x' },
    });
  });

  it('jobs returns { jobs, next } with state typed as JobState', async () => {
    const page = await journal.jobs(db, { status: 'dead', limit: 10 });
    expectTypeOf(page.next).toEqualTypeOf<string | null>();
    expectTypeOf(page.jobs[0]?.state).toEqualTypeOf<JobState | undefined>();
    const after = page.next ?? undefined;
    await journal.jobs(db, { after });
    // @ts-expect-error a cursor is the opaque string `next` gave out, not a date and id
    await journal.jobs(db, { after: { at: new Date(), id: 'job_1' } });
    const archive = await journal.archivedJobs(db);
    expectTypeOf(archive.next).toEqualTypeOf<string | null>();
    const operations = await journal.jobOperations(db);
    expectTypeOf(operations.next).toEqualTypeOf<string | null>();
    const detail = await journal.job(db, 'job_1');
    expectTypeOf(detail).toEqualTypeOf<JobDetail | undefined>();
    expectTypeOf(detail?.attemptLog).not.toBeUndefined();
  });

  it('retryDead and purgeDead may report that nothing changed', async () => {
    const retried = orThrow(await journal.retryDead(db, { ids: ['job_1'] }, op));
    expectTypeOf(retried.operationId).toEqualTypeOf<string | null>();
    const purged = orThrow(await journal.purgeDead(db, { olderThan: new Date() }, op));
    expectTypeOf(purged.operationId).toEqualTypeOf<string | null>();
    const single = orThrow(await journal.retry(db, 'job_1', op));
    expectTypeOf(single.operationId).toEqualTypeOf<string>();
  });
});

describe('accept, as types', () => {
  const OutOfStock = defineFailure('stock.out', { status: 409, data: z.object({ sku: z.string() }) });
  type OutOfStock = ReturnType<typeof OutOfStock>;
  const reserve = j.command('reserveTyped', z.object({ qty: z.int() }), { writes: [] }, input => {
    if (input.qty <= 0) return CommandInvalid({ detail: 'Reserve at least one' });
    if (input.qty > 5) return OutOfStock({ sku: 'a' });
    return { reservationId: 'res_1' };
  });
  const placeOrder = j.command(
    'placeOrderTyped',
    z.object({ qty: z.int() }),
    { writes: [] },
    async (input, { run, accept }) => {
      const stock = await run(reserve, input);
      if (OutOfStock.is(stock)) {
        accept(stock);
        return { status: 'backordered' as const };
      }
      if (isFailure(stock)) return stock;
      return { status: 'reserved' as const, reservationId: stock.reservationId };
    },
  );

  it('the check the developer writes drops the accepted code from the inferred result; nothing is restated', async () => {
    const _result = await journal.run(db, placeOrder, { qty: 1 }, meta);
    expectTypeOf<Extract<typeof _result, OutOfStock>>().toBeNever();
    expectTypeOf<Extract<typeof _result, Failure>>().toEqualTypeOf<CommandInvalid | CommandFailure>();
    expectTypeOf<Exclude<typeof _result, Failure>['status']>().toEqualTypeOf<'backordered' | 'reserved'>();
  });

  it('accept takes only a failure', () => {
    j.command('acceptsSuccess', z.object({}), { writes: [] }, (_input, { accept }) => {
      // @ts-expect-error a success is not a refusal
      accept({ status: 'ok' });
      return 'ok';
    });
    expectTypeOf<CommandContext<unknown>['accept']>().toEqualTypeOf<AcceptFailure>();
    expectTypeOf<ReturnType<AcceptFailure>>().toEqualTypeOf<void>();
  });

  it('an effect only reaches out: it has no `run` and nothing to accept, so a command from one does not compile', () => {
    expectTypeOf<keyof EffectContext>().toEqualTypeOf<'jobId' | 'attempt' | 'signal' | 'db'>();
    j.effect('reaches-out', order, {
      OrderPaid: (_event, ctx) => {
        // @ts-expect-error D-11: an event that must run a command is a `j.task` or a `j.workflow` with `startOn`
        void ctx.run;
        // @ts-expect-error nothing to accept: an effect receives no refusal
        void ctx.accept;
      },
    });
  });
});
