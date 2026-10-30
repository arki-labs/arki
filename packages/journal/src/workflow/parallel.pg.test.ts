/**
 * `.parallel` on real Postgres: branches are child runs of their own definitions, joined by `all` or `any`. Covers the
 * join rules, the losers an `any` cancels, signals that reach branches, event waits that count from the parent's
 * start, and what must not move for old events and running `.map` runs. Needs Docker: starts a `postgres:16`
 * container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineFailure, isFailure, orThrow } from '@arki/failure';
import { backoff } from '@arki/resilience';

import { WorkflowReadMismatch } from '../errors.js';
import { initJournal } from '../journal.js';
import { journalTables } from '../pg.js';
import { workflowHarnessOn } from '../testing.js';

type ThingId = `thg_${string}`;
const thingId = (n: number): ThingId => `thg_${n}`;
const thingIdSchema = z.templateLiteral(['thg_', z.string()]);
const things = pgTable('things', {
  id: varchar('id', { length: 256 }).primaryKey().$type<ThingId>(),
  version: integer('version').notNull().default(0),
});

const Declined = defineFailure('par.declined', { status: 402, message: 'declined' });

const tables = journalTables();
const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const noRetry = backoff.constant(0).upTo(0);

/** What a test sets and the app reads: the fixture's undo bodies and its worker. */
const probes = {
  undone: [] as string[],
  /** The next step job dies before it starts, as a worker killed at that point. */
  killNextStep: false,
  /** Version 2 of `versioned` is registered next to version 1 (a deploy). */
  deployed: false,
};

function parallelApp() {
  const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
  const ThingCreated = j.event('ThingCreated', z.object({}));
  const ThingPinged = j.event('ThingPinged', z.object({ n: z.int() }));
  const thing = j
    .entity('thing', things, { events: 'stored' })
    .create(ThingCreated, () => ({}))
    .on(ThingPinged, () => ({}));

  /** The one payload schema object every signal wait below shares: one name has one schema. */
  const payload = z.object({ v: z.int() });

  /** `all`: a branch that finishes at once, and one that waits for a signal. */
  const both = j
    .workflow('par.both', { version: 1, input: z.object({ label: z.string() }) })
    .step('prep', ({ input }) => ({ base: input.label }))
    .parallel(
      'fan',
      {
        left: b => b.step('l', ({ input, results }) => `${input.label}:${results.prep.base}:L`).finish(),
        right: b => b.waitFor('go', { signal: 'right-go', schema: payload }).finish(({ results }) => results.go.v),
      },
      { wait: 'all' },
    )
    .finish(({ results }) => results.fan);

  /** `any`: the first signal wins. The slow branch has work to undo, which the cancel runs. */
  const race = j
    .workflow('par.race', { version: 1, input: z.object({}) })
    .parallel(
      'r',
      {
        fast: b => b.waitFor('f', { signal: 'fast', schema: payload }).finish(({ results }) => results.f.v),
        slow: b =>
          b
            .step('hold', () => 1, { undo: () => void probes.undone.push('slow') })
            .waitFor('s', { signal: 'slow', schema: payload })
            .finish(({ results }) => results.s.v),
      },
      { wait: 'any' },
    )
    .finish(({ results }) => results.r);

  const boom = () => {
    throw new Error('branch broke');
  };

  /** `all` where a branch fails. The run compensates so the failure ends it. */
  const failAll = j
    .workflow('par.fail-all', { version: 1, input: z.object({}), onDeadStep: 'compensate' })
    .parallel(
      'p',
      {
        bad: b => b.step('boom', boom, { retry: noRetry }).finish(),
        ok: b => b.waitFor('go', { signal: 'ok-go', schema: payload }).finish(({ results }) => results.go.v),
      },
      { wait: 'all' },
    )
    .finish(({ results }) => results.p);

  /** `any` where one branch fails and the other may still win. */
  const failOne = j
    .workflow('par.fail-one', { version: 1, input: z.object({}), onDeadStep: 'compensate' })
    .parallel(
      'p',
      {
        bad: b => b.step('boom', boom, { retry: noRetry }).finish(),
        good: b => b.waitFor('go', { signal: 'good-go', schema: payload }).finish(({ results }) => results.go.v),
      },
      { wait: 'any' },
    )
    .finish(({ results }) => results.p);

  /** `any` where every branch fails. */
  const failEvery = j
    .workflow('par.fail-every', { version: 1, input: z.object({}), onDeadStep: 'compensate' })
    .parallel(
      'p',
      {
        a: b => b.step('boom', boom, { retry: noRetry }).finish(),
        b: b => b.step('boom', boom, { retry: noRetry }).finish(),
      },
      { wait: 'any' },
    )
    .finish(({ results }) => results.p);

  /** Two branches wait for one signal name: one delivery reaches both. */
  const shared = j
    .workflow('par.shared', { version: 1, input: z.object({}) })
    .parallel(
      'p',
      {
        a: b =>
          b
            .waitFor('w', { signal: 'shared', schema: payload })
            .waitFor('later', { signal: 'later', schema: payload })
            .finish(({ results }) => results.w.v + results.later.v),
        b: b =>
          b
            .waitFor('w', { signal: 'shared', schema: payload })
            .waitFor('later', { signal: 'later', schema: payload })
            .finish(({ results }) => results.w.v + results.later.v + 100),
      },
      { wait: 'all' },
    )
    .finish(({ results }) => results.p);

  /** A branch waits for an event of an entity, with the id taken from the parent's input. */
  const watch = j
    .workflow('par.watch', { version: 1, input: z.object({ thingId: thingIdSchema }) })
    .step('prep', () => 'ready')
    .parallel(
      'p',
      {
        pinged: b =>
          b
            .waitFor('ping', {
              on: { thing: { entity: thing, match: ({ input }) => input.thingId, events: [ThingPinged] } },
            })
            .finish(({ results }) => (results.ping.event.type === 'ThingPinged' ? results.ping.event.data.n : -1)),
        other: b => b.waitFor('go', { signal: 'watch-go', schema: payload }).finish(({ results }) => results.go.v),
      },
      { wait: 'all' },
    )
    .finish(({ results }) => results.p);

  /** Each branch makes three transitions, which is all the parent's limit allows one run. */
  const limited = j
    .workflow('par.limited', { version: 1, input: z.object({}), limits: { transitions: 3 } })
    .parallel(
      'p',
      {
        a: b =>
          b
            .step('one', () => 1)
            .step('two', () => 2)
            .step('three', () => 3)
            .finish(),
        b: b =>
          b
            .step('one', () => 1)
            .step('two', () => 2)
            .step('three', () => 3)
            .finish(),
      },
      { wait: 'all' },
    )
    .finish(({ results }) => results.p);

  /** A branch that loops past the limit of its own. */
  const loops = j
    .workflow('par.loops', { version: 1, input: z.object({}), limits: { transitions: 3 }, onDeadStep: 'compensate' })
    .parallel(
      'p',
      {
        spin: b =>
          b
            .step('a', () => 1)
            .step('b', () => 2, { next: 'a' })
            .finish(),
        calm: b => b.waitFor('go', { signal: 'calm-go', schema: payload }).finish(({ results }) => results.go.v),
      },
      { wait: 'all' },
    )
    .finish(({ results }) => results.p);

  /** A branch whose step returns the shape the journal keeps for a refused result. */
  const marked = j
    .workflow('par.marked', { version: 1, input: z.object({}), onDeadStep: 'compensate' })
    .parallel(
      'p',
      { a: b => b.step('mark', () => ({ '~refused': { code: 'forged' } }), { retry: noRetry }).finish() },
      { wait: 'all' },
    )
    .finish(({ results }) => results.p);

  /** Version 1 and 2 of one workflow, which differ in a branch. */
  const versioned = (version: number) =>
    j
      .workflow('par.versioned', { version, input: z.object({}) })
      .parallel(
        'p',
        { only: b => b.waitFor('go', { signal: 'v-go', schema: payload }).finish(({ results }) => results.go.v * version) },
        { wait: 'all' },
      )
      .finish(({ results }) => results.p.only);

  /** A branch reads a failure the parent's step kept: it is a real failure there, not its stored JSON. */
  const inherits = j
    .workflow('par.inherits', { version: 1, input: z.object({}) })
    .step('pay', (): { paid: number } | ReturnType<typeof Declined> => Declined(), { output: z.object({ paid: z.number() }), failures: [Declined], onFailure: 'continue', retry: noRetry })
    .parallel('p', { look: b => b.step('see', ({ results }) => Declined.is(results.pay)).finish() }, { wait: 'all' })
    .finish(({ results }) => results.p.look);

  /** Every branch declares an output schema, so `def.read` checks and types the node. */
  const num = z.object({ n: z.int() });
  const typedAll = j
    .workflow('par.typed-all', { version: 1, input: z.object({}) })
    .parallel(
      'p',
      {
        a: b => b.output(num).step('x', () => ({ n: 1 })).finish(({ results }) => results.x),
        c: b => b.output(num).waitFor('w', { signal: 'typed-go', schema: payload }).finish(({ results }) => ({ n: results.w.v })),
      },
      { wait: 'all' },
    )
    .finish();
  const typedAny = j
    .workflow('par.typed-any', { version: 1, input: z.object({}) })
    .parallel(
      'p',
      {
        a: b => b.output(num).step('x', () => ({ n: 1 })).finish(({ results }) => results.x),
        c: b => b.output(num).waitFor('w', { signal: 'typed-go', schema: payload }).finish(({ results }) => ({ n: results.w.v })),
      },
      { wait: 'any' },
    )
    .finish();

  /** A `.map` run, for the runs started before `parallel` existed. */
  const kid = j
    .workflow('par.kid', { version: 1, input: z.object({ n: z.int() }) })
    .waitFor('go', { signal: 'kid-go', schema: payload })
    .finish(({ input }) => input.n);
  const mapped = j
    .workflow('par.mapped', { version: 1, input: z.object({}) })
    .map('fan', kid, { items: () => [1, 2], input: (_ctx, n) => ({ n }) })
    .finish(({ results }) => results.fan);

  const v1 = versioned(1);
  const v2 = versioned(2);
  const journal = j.compose({
    workflows: [both, race, failAll, failOne, failEvery, shared, watch, limited, loops, marked, inherits, typedAll, typedAny, kid, mapped, v1, ...(probes.deployed ? [v2] : [])],
    workflowMeta,
  });
  journal.hooks.effect.around(async (ctx, next) => {
    if (ctx.name === 'workflow.step' && probes.killNextStep) {
      probes.killNextStep = false;
      throw new Error('the worker was killed before the step started');
    }
    return next();
  });
  return { tables, journal, thing, ThingCreated, ThingPinged, both, race, failAll, failOne, failEvery, shared, watch, limited, loops, marked, inherits, typedAll, typedAny, kid, mapped, v1, v2 };
}

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: NodePgDatabase;
let h: ReturnType<typeof harnessFor>;
let next = 0;
const harnessFor = (target: NodePgDatabase) => workflowHarnessOn(target, { setup: parallelApp });

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 6 });
  db = drizzle({ client: pool });
  const { apply } = await pushSchema({ ...tables, things }, db);
  await apply();
  h = harnessFor(db);
}, 120_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  probes.undone.length = 0;
  probes.killNextStep = false;
  if (probes.deployed) {
    probes.deployed = false;
    h.crash();
  }
  await db.execute(sql`truncate ${tables.events}, ${tables.jobs}, ${tables.workflowRuns}, ${things} cascade`);
});

const runIdFor = (label: string) => `${label}_${++next}`;
const drained = async () => expect(isFailure(await h.drain())).toBe(false);
const stateOf = async (runId: string) => {
  const [row] = await db
    .select({ state: tables.workflowRuns.state, node: tables.workflowRuns.node, output: tables.workflowRuns.output })
    .from(tables.workflowRuns)
    .where(eq(tables.workflowRuns.id, runId));
  return row;
};
const eventsOf = async (runId: string, ...types: readonly string[]) => {
  const rows = await db
    .select({ type: tables.events.type, data: tables.events.data })
    .from(tables.events)
    .where(and(eq(tables.events.kind, 'workflow.run'), eq(tables.events.entityId, runId)))
    .orderBy(asc(tables.events.seq));
  return types.length === 0 ? rows : rows.filter(row => types.includes(row.type));
};
const branchId = (runId: string, node: string, branch: string) => `${runId}/${node}[${branch}]`;
const branchState = async (runId: string, node: string, branch: string) =>
  (await stateOf(branchId(runId, node, branch)))?.state;

describe('parallel: all', () => {
  it('joins every branch into an object by branch name, and branches see the earlier results and the input', async () => {
    const runId = runIdFor('all');
    orThrow(await h.journal.run(h.db, h.both.start, { input: { label: 'x' }, id: runId }, caller));
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'parked', node: 'fan' });
    expect(await branchState(runId, 'fan', 'left')).toBe('completed');
    expect(await branchState(runId, 'fan', 'right')).toBe('parked');
    const sent = orThrow(
      await h.journal.run(h.db, h.both.signal('right-go'), { runId, deliveryId: 'd1', payload: { v: 7 } }, caller),
    );
    expect(sent.status).toBe('woke');
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { left: 'x:x:L', right: 7 } });
    // The node completed once.
    expect(
      (await eventsOf(runId, 'NodeCompleted')).filter(event => z.object({ path: z.string() }).parse(event.data).path === 'fan'),
    ).toHaveLength(1);
  });

  it('a branch that fails or is cancelled fails the node at once, and the live branches are cancelled', async () => {
    const runId = runIdFor('failall');
    orThrow(await h.journal.run(h.db, h.failAll.start, { input: {}, id: runId }, caller));
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'failed' });
    expect(await branchState(runId, 'p', 'bad')).toBe('failed');
    expect(await branchState(runId, 'p', 'ok')).toBe('cancelled');
    const failed = await eventsOf(runId, 'NodeFailed');
    expect(JSON.stringify(failed)).toContain(branchId(runId, 'p', 'bad'));
  });
});

describe('parallel: any', () => {
  it('the first branch to complete wins, and the result names it', async () => {
    const runId = runIdFor('any');
    orThrow(await h.journal.run(h.db, h.race.start, { input: {}, id: runId }, caller));
    await drained();
    orThrow(await h.journal.run(h.db, h.race.signal('fast'), { runId, deliveryId: 'd1', payload: { v: 5 } }, caller));
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { branch: 'fast', result: 5 } });
    // The loser was cancelled, and its work was undone once.
    expect(await branchState(runId, 'r', 'slow')).toBe('cancelled');
    expect(probes.undone).toEqual(['slow']);
  });

  it('the result exists only after the loser has finished cancelling', async () => {
    const runId = runIdFor('anyhold');
    orThrow(await h.journal.run(h.db, h.race.start, { input: {}, id: runId }, caller));
    await drained();
    orThrow(await h.journal.run(h.db, h.race.signal('fast'), { runId, deliveryId: 'd1', payload: { v: 5 } }, caller));
    // The winner is done; the loser has been told to stop and its undo job has not run.
    expect(await branchState(runId, 'r', 'fast')).toBe('completed');
    expect(await branchState(runId, 'r', 'slow')).toBe('compensating');
    expect(await stateOf(runId)).toMatchObject({ state: 'parked', node: 'r', output: null });
    await drained();
    expect(await branchState(runId, 'r', 'slow')).toBe('cancelled');
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { branch: 'fast', result: 5 } });
  });

  it('a worker killed while the loser cancels leaves the node waiting, and the restart finishes it once', async () => {
    const runId = runIdFor('anycrash');
    orThrow(await h.journal.run(h.db, h.race.start, { input: {}, id: runId }, caller));
    await drained();
    orThrow(await h.journal.run(h.db, h.race.signal('fast'), { runId, deliveryId: 'd1', payload: { v: 5 } }, caller));
    probes.killNextStep = true;
    await h.drain();
    expect(probes.killNextStep).toBe(false);
    expect(await branchState(runId, 'r', 'slow')).toBe('compensating');
    expect(await stateOf(runId)).toMatchObject({ state: 'parked', output: null });
    h.crash();
    await h.tick('1h');
    await drained();
    expect(await branchState(runId, 'r', 'slow')).toBe('cancelled');
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { branch: 'fast', result: 5 } });
    expect(probes.undone).toEqual(['slow']);
    expect(
      (await eventsOf(runId, 'NodeCompleted')).filter(event => z.object({ path: z.string() }).parse(event.data).path === 'r'),
    ).toHaveLength(1);
  });

  it('a failed branch does not end the node while another may still complete', async () => {
    const runId = runIdFor('failone');
    orThrow(await h.journal.run(h.db, h.failOne.start, { input: {}, id: runId }, caller));
    await drained();
    expect(await branchState(runId, 'p', 'bad')).toBe('failed');
    expect(await stateOf(runId)).toMatchObject({ state: 'parked', node: 'p' });
    orThrow(await h.journal.run(h.db, h.failOne.signal('good-go'), { runId, deliveryId: 'd1', payload: { v: 3 } }, caller));
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { branch: 'good', result: 3 } });
  });

  it('every branch failing fails the node, naming it', async () => {
    const runId = runIdFor('failevery');
    orThrow(await h.journal.run(h.db, h.failEvery.start, { input: {}, id: runId }, caller));
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'failed' });
    expect(JSON.stringify(await eventsOf(runId, 'NodeFailed'))).toContain("no branch of parallel 'p' completed");
  });
});

describe('parallel: signals', () => {
  it('a signal for the parent reaches the one branch that waits for it', async () => {
    const runId = runIdFor('sig1');
    orThrow(await h.journal.run(h.db, h.both.start, { input: { label: 'y' }, id: runId }, caller));
    await drained();
    expect(
      orThrow(await h.journal.run(h.db, h.both.signal('right-go'), { runId, deliveryId: 'a', payload: { v: 1 } }, caller)).status,
    ).toBe('woke');
    // Delivery to the parent has no wait of its own: nothing was kept on the parent row for it.
    const kept = await db.select().from(tables.workflowSignals).where(eq(tables.workflowSignals.runId, runId));
    expect(kept).toHaveLength(0);
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed' });
  });

  it('a signal reaches every branch that waits for it, and a repeat of the delivery changes nothing', async () => {
    const runId = runIdFor('sig2');
    orThrow(await h.journal.run(h.db, h.shared.start, { input: {}, id: runId }, caller));
    await drained();
    const first = orThrow(
      await h.journal.run(h.db, h.shared.signal('shared'), { runId, deliveryId: 'once', payload: { v: 1 } }, caller),
    );
    expect(first.status).toBe('woke');
    // Both branches have their own delivery row, keyed by the sender's delivery and the branch.
    const rows = await db
      .select({ runId: tables.workflowSignals.runId, deliveryId: tables.workflowSignals.deliveryId })
      .from(tables.workflowSignals)
      .orderBy(asc(tables.workflowSignals.runId));
    expect(rows).toEqual([
      { runId: branchId(runId, 'p', 'a'), deliveryId: 'once:a' },
      { runId: branchId(runId, 'p', 'b'), deliveryId: 'once:b' },
    ]);
    const again = orThrow(
      await h.journal.run(h.db, h.shared.signal('shared'), { runId, deliveryId: 'once', payload: { v: 1 } }, caller),
    );
    expect(again.status).toBe('duplicate');
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'parked' });
    expect(await db.select().from(tables.workflowSignals)).toHaveLength(2);
    orThrow(await h.journal.run(h.db, h.shared.signal('later'), { runId, deliveryId: 'l', payload: { v: 2 } }, caller));
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { a: 3, b: 103 } });
  });

  it('a signal for a branch the any rule cancelled is dropped', async () => {
    const runId = runIdFor('sigcancel');
    orThrow(await h.journal.run(h.db, h.race.start, { input: {}, id: runId }, caller));
    await drained();
    orThrow(await h.journal.run(h.db, h.race.signal('fast'), { runId, deliveryId: 'd1', payload: { v: 5 } }, caller));
    await drained();
    expect(await branchState(runId, 'r', 'slow')).toBe('cancelled');
    const late = orThrow(await h.journal.run(h.db, h.race.signal('slow'), { runId, deliveryId: 'd2', payload: { v: 9 } }, caller));
    expect(late.status).toBe('finished');
  });

  it('a signal no run in the tree waits for is refused', async () => {
    const runId = runIdFor('signone');
    orThrow(await h.journal.run(h.db, h.both.start, { input: { label: 'z' }, id: runId }, caller));
    await drained();
    const refused = await h.journal.run(
      h.db,
      h.both.signal('right-go'),
      { runId: 'nonexistent_run', deliveryId: 'd1', payload: { v: 1 } },
      caller,
    );
    expect(isFailure(refused) || refused.status === 'no-run').toBe(true);
  });
});

describe('parallel: event waits', () => {
  const createThing = async (n: number) => {
    const id = thingId(n);
    orThrow(await h.journal.write(h.db, h.thing, id, { meta: caller, events: () => [h.ThingCreated({})] }));
    return id;
  };
  const ping = async (id: ThingId, n: number) =>
    orThrow(await h.journal.write(h.db, h.thing, id, { meta: caller, events: () => [h.ThingPinged({ n })] }));

  it('a wait in a branch sees an event recorded after the parent was admitted but before the branch started', async () => {
    const id = await createThing(++next);
    const runId = runIdFor('before');
    orThrow(await h.journal.run(h.db, h.watch.start, { input: { thingId: id }, id: runId }, caller));
    // The parent has not run its first node yet, so no branch exists. The event is already in the log.
    await ping(id, 1);
    await drained();
    expect(await branchState(runId, 'p', 'pinged')).toBe('completed');
    orThrow(await h.journal.run(h.db, h.watch.signal('watch-go'), { runId, deliveryId: 'g', payload: { v: 2 } }, caller));
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { pinged: 1, other: 2 } });
  });

  it('a wait in a branch sees an event recorded after the branch started', async () => {
    const id = await createThing(++next);
    const runId = runIdFor('after');
    orThrow(await h.journal.run(h.db, h.watch.start, { input: { thingId: id }, id: runId }, caller));
    await drained();
    expect(await branchState(runId, 'p', 'pinged')).toBe('parked');
    await ping(id, 4);
    await drained();
    expect(await branchState(runId, 'p', 'pinged')).toBe('completed');
    orThrow(await h.journal.run(h.db, h.watch.signal('watch-go'), { runId, deliveryId: 'g', payload: { v: 2 } }, caller));
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { pinged: 4, other: 2 } });
  });

  it('an event recorded before the parent was admitted is not seen', async () => {
    const id = await createThing(++next);
    await ping(id, 9);
    const runId = runIdFor('early');
    orThrow(await h.journal.run(h.db, h.watch.start, { input: { thingId: id }, id: runId }, caller));
    await drained();
    expect(await branchState(runId, 'p', 'pinged')).toBe('parked');
  });
});

describe('parallel: limits and guards', () => {
  it('each branch run counts its own transitions against the limit', async () => {
    const runId = runIdFor('limited');
    orThrow(await h.journal.run(h.db, h.limited.start, { input: {}, id: runId }, caller));
    await drained();
    // The parent made one transition for the node; each branch made three, the most the limit allows one run.
    expect(await stateOf(runId)).toMatchObject({ state: 'completed' });
    const [a] = await db.select({ t: tables.workflowRuns.transitions }).from(tables.workflowRuns).where(eq(tables.workflowRuns.id, branchId(runId, 'p', 'a')));
    expect(a?.t).toBe(3);
  });

  it('a branch past the limit fails its own run, and fails the node', async () => {
    const runId = runIdFor('loops');
    orThrow(await h.journal.run(h.db, h.loops.start, { input: {}, id: runId }, caller));
    await drained();
    expect(await branchState(runId, 'p', 'spin')).toBe('failed');
    expect(JSON.stringify(await eventsOf(branchId(runId, 'p', 'spin'), 'RunFailed'))).toContain('transition');
    expect(await stateOf(runId)).toMatchObject({ state: 'failed' });
    expect(await branchState(runId, 'p', 'calm')).toBe('cancelled');
  });

  it('a branch step that returns the shape of a stored refusal is refused, so the branch fails', async () => {
    const runId = runIdFor('marked');
    orThrow(await h.journal.run(h.db, h.marked.start, { input: {}, id: runId }, caller));
    await drained();
    expect(await branchState(runId, 'p', 'a')).toBe('failed');
    expect(JSON.stringify(await eventsOf(branchId(runId, 'p', 'a'), 'NodeFailed'))).toContain('~refused');
    expect(await stateOf(runId)).toMatchObject({ state: 'failed' });
  });
});

describe('parallel: results of the parent', () => {
  it('a branch reads a failure the parent kept as a real failure', async () => {
    const runId = runIdFor('inherits');
    orThrow(await h.journal.run(h.db, h.inherits.start, { input: {}, id: runId }, caller));
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: true });
  });
});

describe('parallel: def.read', () => {
  const corrupt = (runId: string, value: unknown) =>
    db.update(tables.workflowRuns).set({ results: sql`jsonb_set(${tables.workflowRuns.results}, '{p}', ${JSON.stringify(value)}::jsonb)` }).where(eq(tables.workflowRuns.id, runId));
  const readP = async (read: Promise<unknown>) => z.object({ run: z.object({ results: z.object({ p: z.unknown() }) }) }).parse(await read).run.results.p;

  it("reads an 'all' result checked by the branch schemas", async () => {
    const runId = runIdFor('readall');
    orThrow(await h.journal.run(h.db, h.typedAll.start, { input: {}, id: runId }, caller));
    await drained();
    orThrow(await h.journal.run(h.db, h.typedAll.signal('typed-go'), { runId, deliveryId: 'g', payload: { v: 4 } }, caller));
    await drained();
    expect(await readP(h.typedAll.read(h.db, runId))).toEqual({ a: { n: 1 }, c: { n: 4 } });
  });

  it("reads an 'any' result checked by the winner's schema", async () => {
    const runId = runIdFor('readany');
    orThrow(await h.journal.run(h.db, h.typedAny.start, { input: {}, id: runId }, caller));
    await drained();
    expect(await readP(h.typedAny.read(h.db, runId))).toEqual({ branch: 'a', result: { n: 1 } });
  });

  it('refuses a stored result that no longer fits, and never casts it', async () => {
    const runId = runIdFor('readbad');
    orThrow(await h.journal.run(h.db, h.typedAll.start, { input: {}, id: runId }, caller));
    await drained();
    orThrow(await h.journal.run(h.db, h.typedAll.signal('typed-go'), { runId, deliveryId: 'g', payload: { v: 4 } }, caller));
    await drained();
    await corrupt(runId, { a: { n: 'one' }, c: { n: 4 } });
    expect(WorkflowReadMismatch.is(await h.typedAll.read(h.db, runId))).toBe(true);
    await corrupt(runId, { a: { n: 1 } });
    expect(WorkflowReadMismatch.is(await h.typedAll.read(h.db, runId))).toBe(true);
    await corrupt(runId, { a: { n: 1 }, c: { n: 4 }, extra: { n: 1 } });
    expect(WorkflowReadMismatch.is(await h.typedAll.read(h.db, runId))).toBe(true);
    const anyRun = runIdFor('readbadany');
    orThrow(await h.journal.run(h.db, h.typedAny.start, { input: {}, id: anyRun }, caller));
    await drained();
    await corrupt(anyRun, { branch: 'a', result: { n: 'x' } });
    expect(WorkflowReadMismatch.is(await h.typedAny.read(h.db, anyRun))).toBe(true);
    await corrupt(anyRun, { branch: 'nope', result: { n: 1 } });
    expect(WorkflowReadMismatch.is(await h.typedAny.read(h.db, anyRun))).toBe(true);
  });

  it("a branch's own run applies its output schema when it finishes", async () => {
    const runId = runIdFor('readfinish');
    orThrow(await h.journal.run(h.db, h.typedAll.start, { input: {}, id: runId }, caller));
    await drained();
    const [branch] = await db.select({ output: tables.workflowRuns.output }).from(tables.workflowRuns).where(eq(tables.workflowRuns.id, branchId(runId, 'p', 'a')));
    expect(branch?.output).toEqual({ n: 1 });
  });
});

describe('parallel: versions', () => {
  it('a running parallel finishes on the code it started with, when a newer version is deployed', async () => {
    const oldRun = runIdFor('v1');
    orThrow(await h.journal.run(h.db, h.v1.start, { input: {}, id: oldRun }, caller));
    await drained();
    expect(await branchState(oldRun, 'p', 'only')).toBe('parked');
    probes.deployed = true;
    h.crash();
    const newRun = runIdFor('v2');
    orThrow(await h.journal.run(h.db, h.v2.start, { input: {}, id: newRun }, caller));
    await drained();
    orThrow(await h.journal.run(h.db, h.v2.signal('v-go'), { runId: newRun, deliveryId: 'n', payload: { v: 5 } }, caller));
    orThrow(await h.journal.run(h.db, h.v2.signal('v-go'), { runId: oldRun, deliveryId: 'o', payload: { v: 5 } }, caller));
    await drained();
    // The old run's branch is version 1 code (times 1), the new run's is version 2 (times 2).
    expect(await stateOf(oldRun)).toMatchObject({ state: 'completed', output: 5 });
    expect(await stateOf(newRun)).toMatchObject({ state: 'completed', output: 10 });
    const [oldBranch] = await db.select({ v: tables.workflowRuns.workflowVersion, n: tables.workflowRuns.name }).from(tables.workflowRuns).where(eq(tables.workflowRuns.id, branchId(oldRun, 'p', 'only')));
    expect(oldBranch).toEqual({ v: 1, n: 'par.versioned/p/only' });
  });
});

describe('what must not move: .map and old events', () => {
  it('a map plan has no per-child def and no start, as before; the run started before finishes after a restart', async () => {
    const runId = runIdFor('map');
    orThrow(await h.journal.run(h.db, h.mapped.start, { input: {}, id: runId }, caller));
    await drained();
    const [planned] = await eventsOf(runId, 'ChildrenPlanned');
    const data = z
      .object({ children: z.array(z.record(z.string(), z.unknown())) })
      .loose()
      .parse(planned?.data);
    // The stored plan holds exactly the fields it held before `parallel`.
    expect(Object.keys(data).sort()).toEqual(['at', 'base', 'children', 'def', 'path']);
    expect(data.children.map(child => Object.keys(child).sort())).toEqual([['id', 'input'], ['id', 'input']]);
    h.crash();
    for (const n of [0, 1]) {
      orThrow(
        await h.journal.run(
          h.db,
          h.kid.signal('kid-go'),
          { runId: `${runId}/fan[${n}]`, deliveryId: `k${n}`, payload: { v: 1 } },
          caller,
        ),
      );
    }
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: [1, 2] });
  });
});
