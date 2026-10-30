import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TransactionDefect } from '@arki/db/transaction';
import { defineFailure, isFailure, orThrow, UnexpectedDefect } from '@arki/failure';

import { backoff } from './index.js';
import { initJournal } from './journal.js';
import { j, meta, openDb, order, orderId, OrderPlaced, orders, tables } from './test-support.js';

let db: PgliteDatabase;
let client: PGlite;
const journal = j.compose({});

beforeAll(async () => {
  ({ db, client } = await openDb());
});
afterAll(() => client.close());

describe('owned callback defects', () => {
  it.each(['handler', 'authorize', 'events'] as const)(
    '%s defects roll back writes and receipts and keep a private cause',
    async boundary => {
      const id = orderId({ handler: 8001, authorize: 8002, events: 8003 }[boundary]);
      const defect = new Error('private provider detail');
      const fail = () => {
        throw defect;
      };
      const command = j.command(
        `defect.${boundary}`,
        z.object({}),
        {
          writes: [OrderPlaced],
          authorize: async (_input, { tx }) => {
            if (boundary !== 'authorize') return;
            await tx.insert(orders).values({ id, customerId: 'c', total: 1, status: 'placed' });
            fail();
          },
        },
        async (_input, { write }) => {
          orThrow(await write(order, id, () => [OrderPlaced({ customerId: 'c', total: 1 })]));
          if (boundary === 'events') return write(order, id, fail);
          if (boundary === 'handler') fail();
          return { done: true };
        },
      );
      const key = `callback:${boundary}`;
      const result = await journal.run(db, command, {}, meta, { idempotencyKey: key });
      expect(TransactionDefect.is(result)).toBe(true);
      if (!isFailure(result)) throw new Error('expected a typed callback defect');
      expect(result.cause).toBe(defect);
      expect(JSON.stringify(result)).not.toContain('private provider detail');
      expect(await db.select().from(orders).where(eq(orders.id, id))).toEqual([]);
      expect(await db.select().from(tables.events).where(eq(tables.events.entityId, id))).toEqual([]);
      expect(await db.select().from(tables.receipts).where(eq(tables.receipts.key, key))).toEqual([]);
    },
  );
});

describe('owned hook defects', () => {
  it('a command hook failure after next rolls back its successful write and receipt', async () => {
    const hooked = j.compose({});
    const defect = new Error('private audit detail');
    hooked.hooks.command.around(async (_ctx, next) => {
      await next();
      throw defect;
    });
    const id = orderId(8010);
    const command = j.command('hook.defect', z.object({}), { writes: [OrderPlaced] }, async (_input, { write }) => {
      const written = await write(order, id, () => [OrderPlaced({ customerId: 'c', total: 1 })]);
      if (isFailure(written)) return written;
      return { version: written.row?.version };
    });
    const result = await hooked.run(db, command, {}, meta, { idempotencyKey: 'hook:defect' });
    expect(TransactionDefect.is(result)).toBe(true);
    if (!isFailure(result)) throw new Error('expected a typed hook defect');
    expect(result.cause).toBe(defect);
    expect(await db.select().from(orders).where(eq(orders.id, id))).toEqual([]);
    expect(await db.select().from(tables.events).where(eq(tables.events.entityId, id))).toEqual([]);
    expect(await db.select().from(tables.receipts).where(eq(tables.receipts.key, 'hook:defect'))).toEqual([]);
  });

  it('an effect hook failure after the body is retried by the default policy and never acknowledges success', async () => {
    let calls = 0;
    const effect = j.effect('hook.defect.effect', order, {
      OrderPlaced: () => {
        calls += 1;
      },
    });
    const hooked = j.compose({ effects: [effect] });
    hooked.hooks.effect.around(async (_ctx, next) => {
      await next();
      throw new Error('private effect hook detail');
    });
    const id = orderId(8011);
    const command = j.command('hook.effect.place', z.object({}), { writes: [OrderPlaced] }, (_input, { write }) =>
      write(order, id, () => [OrderPlaced({ customerId: 'c', total: 1 })]),
    );
    orThrow(await hooked.run(db, command, {}, meta));
    expect(await hooked.drain(db).then(result => orThrow(result))).toBe(1);
    expect(await hooked.drain(db).then(result => orThrow(result))).toBe(0);
    expect(calls).toBe(1);
    const [job] = await db.select().from(tables.jobs).where(eq(tables.jobs.effect, effect.name));
    // A throw is retried by the default policy: the job waits for its next try, it is not acknowledged.
    expect(job).toMatchObject({ attempts: 1, deadAt: null });
    expect(JSON.parse(job?.lastError ?? 'null')).toMatchObject({ code: UnexpectedDefect.code });
    expect(job?.lastError).not.toContain('private effect hook detail');
    const attempts = await db
      .select()
      .from(tables.jobAttempts)
      .where(eq(tables.jobAttempts.jobId, job?.id ?? ''));
    expect(attempts.map(attempt => attempt.outcome)).toEqual(['retry']);
    const archive = await db
      .select()
      .from(tables.jobArchive)
      .where(eq(tables.jobArchive.id, job?.id ?? ''));
    expect(archive).toEqual([]);
  });
});

it('worker shutdown releases an interrupted workflow for restart without a dead step or success acknowledgment', async () => {
  const init = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
  let enter: (() => void) | undefined;
  const entered = new Promise<void>(resolve => {
    enter = resolve;
  });
  let interrupted = true;
  const keys: string[] = [];
  const flow = init
    .workflow('shutdown.resume', { version: 1, input: z.object({}) })
    .step('work', async ctx => {
      keys.push(ctx.key);
      if (interrupted)
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              const reason: unknown = ctx.signal.reason;
              reject(reason instanceof Error ? reason : new Error('Worker interrupted', { cause: reason }));
            },
            { once: true },
          );
          if (enter === undefined) throw new Error('The step gate is not ready');
          enter();
        });
      return 'done';
    })
    .finish();
  const running = init.compose({ workflows: [flow], workflowMeta: meta });
  const id = 'shutdown_resume';
  orThrow(await running.run(db, flow.start, { input: {}, id }, meta));
  const stop = new AbortController();
  const draining = running.drain(db, { signal: stop.signal }).then(result => orThrow(result));
  await entered;
  stop.abort(new Error('worker shutdown'));
  await draining;
  const [pending] = await db.select().from(tables.jobs).where(eq(tables.jobs.runId, id));
  expect(pending).toMatchObject({ attempts: 1, deadAt: null, leaseToken: null, leaseUntil: null });
  const before = await db.select().from(tables.events).where(eq(tables.events.entityId, id));
  expect(before.map(event => event.type)).toEqual(['RunStarted', 'NodeScheduled']);
  interrupted = false;
  await running.drain(db).then(result => orThrow(result));
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const [finished] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  expect(finished).toMatchObject({ state: 'completed', output: 'done' });
  expect(await db.select().from(tables.jobs).where(eq(tables.jobs.runId, id))).toEqual([]);
});

it('a durable step retries only the explicitly selected returned failure with its original identity', async () => {
  const init = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
  const Refused = defineFailure('test.workflow.selected', { data: z.object({ cause: z.string() }) });
  const refusal = Refused({ cause: 'retry this delivery' });
  const reasons: unknown[] = [];
  let calls = 0;
  const flow = init
    .workflow('failure.selected.retry', { version: 1, input: z.object({}) })
    .step(
      'work',
      () => {
        calls += 1;
        return calls === 1 ? refusal : 'done';
      },
      {
        retry: backoff
          .constant(0)
          .upTo(1)
          .while(reason => {
            reasons.push(reason);
            return Refused.is(reason);
          }),
      },
    )
    .finish();
  const running = init.compose({ workflows: [flow], workflowMeta: meta });
  const id = 'failure_selected_retry';
  orThrow(await running.run(db, flow.start, { input: {}, id }, meta));
  for (let n = 0; n < 10; n++) if ((await running.drain(db).then(result => orThrow(result))) === 0) break;
  expect(calls).toBe(2);
  expect(reasons).toHaveLength(1);
  expect(reasons[0]).toBe(refusal);
  const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  expect(row).toMatchObject({ state: 'completed', output: 'done' });
});

// WHY: a step's retry rule names the faults worth another try, such as a provider's rate limit. If the rule saw the
// defect the journal records instead of the error the body threw, every rule would have to dig the error out first.
describe('a step retry rule judges what the step body did', () => {
  class Transient extends Error {}

  it("a step's retry predicate sees the error its body threw, so it can retry a transient fault without unwrapping", async () => {
    const init = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
    const thrown = new Transient('rate limited');
    const reasons: unknown[] = [];
    let calls = 0;
    const flow = init
      .workflow('failure.thrown.retry', { version: 1, input: z.object({}) })
      .step(
        'work',
        () => {
          calls += 1;
          if (calls === 1) throw thrown;
          return 'done';
        },
        {
          retry: backoff
            .constant(0)
            .upTo(1)
            .while(reason => {
              reasons.push(reason);
              return reason instanceof Transient;
            }),
        },
      )
      .finish();
    const running = init.compose({ workflows: [flow], workflowMeta: meta });
    const id = 'failure_thrown_retry';
    orThrow(await running.run(db, flow.start, { input: {}, id }, meta));
    for (let n = 0; n < 10; n++) if ((await running.drain(db).then(result => orThrow(result))) === 0) break;
    expect(reasons).toEqual([thrown]);
    expect(calls).toBe(2);
    const [row] = await db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
    expect(row).toMatchObject({ state: 'completed', output: 'done' });
  });

  it('a returned Failure is still not retried', async () => {
    const init = initJournal({ tables, meta: z.object({ actorId: z.string() }) });
    const Declined = defineFailure('test.workflow.declined');
    let calls = 0;
    const flow = init
      .workflow('failure.returned.no_retry', { version: 1, input: z.object({}) })
      .step(
        'work',
        () => {
          calls += 1;
          return Declined();
        },
        // A rule without `while` retries throws only: a returned failure is the step's answer, and a retry repeats it.
        { retry: backoff.constant(0).upTo(3) },
      )
      .finish();
    const running = init.compose({ workflows: [flow], workflowMeta: meta });
    const id = 'failure_returned_no_retry';
    orThrow(await running.run(db, flow.start, { input: {}, id }, meta));
    for (let n = 0; n < 10; n++) if ((await running.drain(db).then(result => orThrow(result))) === 0) break;
    expect(calls).toBe(1);
    const [step] = await db.select().from(tables.workflowSteps).where(eq(tables.workflowSteps.runId, id));
    expect(step).toMatchObject({
      path: 'work',
      status: 'failed',
      attempt: 1,
      error: expect.stringContaining(Declined.code),
    });
  });
});

it('runtime metadata invariants are typed before any handler or transaction work', async () => {
  const init = initJournal({ tables, meta: z.object({ actorId: z.string().transform(value => value + '!') }) });
  let calls = 0;
  const command = init.command('metadata.unstable', z.object({}), { writes: [] }, () => {
    calls += 1;
    return 'unreachable';
  });
  const result = await init.compose({}).run(db, command, {}, meta);
  expect(result).toMatchObject({ code: TransactionDefect.code, cause: { code: 'UNSTABLE_SCHEMA' } });
  expect(calls).toBe(0);
});
