/**
 * Named limits and pause on PGlite. A limit is what lets an app say "at most two uploads at once, whichever workflow
 * starts them" and lets an operator stop new work during an incident without touching code: a start over any limit it
 * holds must never create a run, an operator's change must apply to the very next start, and a pause must stop new
 * runs while the running ones finish. Races between two real connections are in `runner.pg.test.ts`.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InvalidInput, isFailure, orThrow } from '@arki/failure';

import { CommandInvalid, CommandNotFound, WorkflowBusy } from '../errors.js';
import { initJournal } from '../journal.js';
import { journalTables } from '../pg.js';
import { j, tables } from '../test-support.js';
import { openJournalDb } from '../testing.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const ops = { actor: 'usr_ops', reason: 'incident 42' };

let db: PgliteDatabase;
let client: PGlite;
let counter = 0;
const newId = (prefix: string) => `${prefix}_${++counter}`;

const accountInput = z.object({ account: z.string() });
const byAccount = ({ account }: { account: string }) => account;

/** Two runs of the pool at a time, whichever of the two workflows starts them. */
const pool = j.limit({ name: 'test.pool', total: 2 });
/** One run per account, across the two workflows that share it. */
const perAccount = j.limit({ name: 'test.per-account', perKey: 1 });
/** One run in all, to show that a start needs room in every limit it holds. */
const narrow = j.limit({ name: 'test.narrow', total: 1 });

/** A workflow that parks until it is told to go, so its run holds its limits for as long as a test needs. */
const parked = (name: string, concurrency?: Parameters<typeof j.workflow<typeof accountInput>>[1]['concurrency']) =>
  j
    .workflow(name, { version: 1, input: accountInput, ...(concurrency === undefined ? {} : { concurrency }) })
    .waitFor('go', { signal: 'go', schema: z.object({}) })
    .finish();

const totalOnly = parked('test.total-only', { total: 2, onBusy: 'refuse' });
const poolA = parked('test.pool-a', { shared: [pool], onBusy: 'refuse' });
const poolB = parked('test.pool-b', { shared: [pool], onBusy: 'refuse' });
const accountA = parked('test.account-a', { key: byAccount, shared: [perAccount], onBusy: 'refuse' });
const accountB = parked('test.account-b', { key: byAccount, shared: [perAccount], onBusy: 'refuse' });
const both = parked('test.both', { key: byAccount, limit: 5, shared: [narrow], onBusy: 'join' });
const keyed = parked('test.keyed', { key: byAccount, limit: 1, onBusy: 'refuse' });
const joined = parked('test.joined', { key: byAccount, limit: 1, onBusy: 'join' });
/** No concurrency at all: only a pause of `workflow/test.plain` applies. */
const plain = parked('test.plain');
/** A run that ends by itself, to show that a pause lets running runs finish. */
const quick = j
  .workflow('test.quick', { version: 1, input: accountInput, concurrency: { total: 5, onBusy: 'refuse' } })
  .step('work', ({ input }) => input.account)
  .finish();

const journal = j.compose({
  workflows: [totalOnly, poolA, poolB, accountA, accountB, both, keyed, joined, plain, quick],
  workflowMeta,
});

beforeAll(async () => {
  ({ db, client } = await openJournalDb(tables));
});
afterAll(() => client.close());

async function settle(limit = 40) {
  for (let pass = 0; pass < limit; pass++) {
    if ((await journal.drain(db).then(result => orThrow(result))) === 0) return;
  }
  throw new Error('the runs did not settle');
}

type Def = typeof poolA;
const start = (
  def: { readonly start: Def['start'] },
  account: string,
  extra: { readonly id?: string; readonly scope?: string } = {},
) => journal.run(db, def.start, { input: { account }, ...extra }, caller);
/** Ends every parked run of a workflow, so the next test starts from an empty limit. */
const release = async (def: Def) => {
  await settle();
  const parkedRuns = await db
    .select({ id: tables.workflowRuns.id })
    .from(tables.workflowRuns)
    .where(and(eq(tables.workflowRuns.name, def.name), eq(tables.workflowRuns.state, 'parked')));
  for (const { id } of parkedRuns) {
    orThrow(await journal.run(db, def.signal('go'), { runId: id, deliveryId: `go:${id}`, payload: {} }, caller));
  }
  await settle();
};
const busyOf = (outcome: unknown) => {
  if (!WorkflowBusy.is(outcome)) throw new Error(`expected WorkflowBusy, got ${JSON.stringify(outcome)}`);
  return outcome.data;
};

describe("a workflow's own total", () => {
  it('total caps every run of the workflow, whatever the key, so a job with no key can still be capped', async () => {
    orThrow(await start(totalOnly, newId('acc')));
    orThrow(await start(totalOnly, newId('acc')));
    expect(busyOf(await start(totalOnly, newId('acc')))).toMatchObject({
      limitName: 'workflow/test.total-only',
      reason: 'full',
      limit: 2,
      // A start without a key says so with `null`, so a caller tests for the key, not for an empty-string stand-in.
      key: null,
    });
    await release(totalOnly);
    expect(isFailure(await start(totalOnly, newId('acc')))).toBe(false);
    await release(totalOnly);
  });
});

describe('a shared limit', () => {
  it('its total counts the runs of every workflow that lists it, so two workflows cannot exceed it together', async () => {
    const first = orThrow(await start(poolA, newId('acc')));
    orThrow(await start(poolB, newId('acc')));
    const refused = busyOf(await start(poolA, newId('acc')));
    expect(refused).toMatchObject({ name: 'test.pool-a', limitName: 'test.pool', reason: 'full', limit: 2 });
    // The run stores the shared limit it holds, so the count finds it whatever workflow it belongs to.
    const [row] = await db
      .select({ limits: tables.workflowRuns.limits })
      .from(tables.workflowRuns)
      .where(eq(tables.workflowRuns.id, first.runId));
    expect(row?.limits).toEqual(['test.pool']);
    await release(poolA);
    expect(isFailure(await start(poolB, newId('acc')))).toBe(false);
    await release(poolB);
  });

  it('its perKey counts one key across the workflows, and another key is free', async () => {
    const account = newId('acc');
    orThrow(await start(accountA, account));
    expect(busyOf(await start(accountB, account))).toMatchObject({
      limitName: 'test.per-account',
      key: account,
      limit: 1,
    });
    expect(isFailure(await start(accountB, newId('acc')))).toBe(false);
    await release(accountA);
    await release(accountB);
  });

  it('a start needs room in every limit it holds: its own has room, the shared one is full, so it is refused', async () => {
    orThrow(await start(both, newId('acc')));
    expect(busyOf(await start(both, newId('acc')))).toMatchObject({ limitName: 'test.narrow', reason: 'full' });
    await release(both);
  });

  it("join answers only when the workflow's own perKey is full: a full shared limit is refused, never joined", async () => {
    const account = newId('acc');
    const first = orThrow(await start(both, account));
    // Another key: the own limit has room, the shared one is full. Joining would hand back an unrelated run.
    expect(WorkflowBusy.is(await start(both, newId('acc')))).toBe(true);
    // The same key again with the own limit at 1: the run already under way is the answer.
    orThrow(await journal.limits.override(db, { name: 'workflow/test.both', perKey: 1 }, ops));
    expect(await start(both, account)).toEqual({ runId: first.runId });
    orThrow(await journal.limits.reset(db, { name: 'workflow/test.both' }, ops));
    await release(both);
  });
});

describe('overrides', () => {
  it('an override of total raises and lowers admission at once, and reset brings back the code value', async () => {
    orThrow(await start(poolA, newId('acc')));
    orThrow(await start(poolA, newId('acc')));
    const raised = orThrow(await journal.limits.override(db, { name: 'test.pool', total: 3 }, ops));
    expect(raised).toMatchObject({ code: { total: 2 }, override: { total: 3 }, effective: { total: 3 }, running: 2 });
    orThrow(await start(poolB, newId('acc')));
    orThrow(await journal.limits.override(db, { name: 'test.pool', total: 1 }, ops));
    expect(busyOf(await start(poolB, newId('acc')))).toMatchObject({ limitName: 'test.pool', limit: 1 });
    orThrow(await journal.limits.reset(db, { name: 'test.pool' }, ops));
    expect(busyOf(await start(poolB, newId('acc')))).toMatchObject({ limit: 2 });
    await release(poolA);
    await release(poolB);
  });

  it("an override of a workflow's own perKey lets a busy key take one more run", async () => {
    const account = newId('acc');
    orThrow(await start(keyed, account));
    expect(WorkflowBusy.is(await start(keyed, account))).toBe(true);
    orThrow(await journal.limits.override(db, { name: 'workflow/test.keyed', perKey: 2 }, ops));
    orThrow(await start(keyed, account));
    expect(busyOf(await start(keyed, account))).toMatchObject({ limit: 2 });
    orThrow(await journal.limits.reset(db, { name: 'workflow/test.keyed' }, ops));
    await release(keyed);
  });

  it('a key override applies to that key only, until it expires; then the code value is back', async () => {
    const hot = newId('acc');
    const other = newId('acc');
    const view = orThrow(await journal.limits.override(db, { name: 'workflow/test.keyed', key: hot, perKey: 2 }, ops));
    // Seven days unless the operator says otherwise, as trigger.dev does.
    const until = new Date(view.keys.find(entry => entry.key === hot)?.until ?? 0).getTime();
    expect(until - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    orThrow(await start(keyed, hot));
    orThrow(await start(keyed, hot));
    orThrow(await start(keyed, other));
    expect(WorkflowBusy.is(await start(keyed, other))).toBe(true);
    // Time is the one thing faked: the override ran out an hour ago.
    await db.execute(
      sql`update journal_limits set keys = jsonb_set(keys, ${`{${hot},until}`}::text[], to_jsonb(${new Date(Date.now() - 3_600_000).toISOString()}::text)) where name = 'workflow/test.keyed'`,
    );
    await release(keyed);
    orThrow(await start(keyed, hot));
    expect(busyOf(await start(keyed, hot))).toMatchObject({ limit: 1 });
    expect(orThrow(await journal.limits.get(db, 'workflow/test.keyed')).keys).toEqual([]);
    await release(keyed);
  });

  it('perKey 0 blocks one key even with nothing running, and leaves the other keys alone', async () => {
    const blocked = newId('acc');
    orThrow(await journal.limits.override(db, { name: 'workflow/test.keyed', key: blocked, perKey: 0 }, ops));
    expect(busyOf(await start(keyed, blocked))).toMatchObject({ limit: 0, reason: 'full' });
    expect(isFailure(await start(keyed, newId('acc')))).toBe(false);
    orThrow(await journal.limits.reset(db, { name: 'workflow/test.keyed', key: blocked }, ops));
    expect(isFailure(await start(keyed, blocked))).toBe(false);
    await release(keyed);
  });

  it('a key override lasts at most 30 days, and an override that could never apply is refused, not kept', async () => {
    const tooLong = await journal.limits.override(
      db,
      { name: 'workflow/test.keyed', key: 'acc_x', perKey: 2, ttl: '31d' },
      ops,
    );
    expect(InvalidInput.is(tooLong)).toBe(true);
    // A workflow without concurrency has nothing to override, and `total-only` has no key for a perKey to count by.
    expect(CommandInvalid.is(await journal.limits.override(db, { name: 'workflow/test.plain', total: 1 }, ops))).toBe(
      true,
    );
    expect(
      CommandInvalid.is(await journal.limits.override(db, { name: 'workflow/test.total-only', perKey: 1 }, ops)),
    ).toBe(true);
  });
});

describe('pause', () => {
  it('a paused limit refuses new starts, the running run completes, and resume admits again', async () => {
    const running = orThrow(await start(quick, newId('acc')));
    const paused = orThrow(await journal.limits.pause(db, { name: 'workflow/test.quick' }, ops));
    expect(paused.paused).toBe(true);
    const refused = await start(quick, newId('acc'));
    expect(busyOf(refused)).toMatchObject({ limitName: 'workflow/test.quick', reason: 'paused', limit: 0 });
    await settle();
    const [row] = await db
      .select({ state: tables.workflowRuns.state })
      .from(tables.workflowRuns)
      .where(eq(tables.workflowRuns.id, running.runId));
    expect(row?.state).toBe('completed');
    orThrow(await journal.limits.resume(db, { name: 'workflow/test.quick' }, ops));
    expect(isFailure(await start(quick, newId('acc')))).toBe(false);
    await settle();
  });

  it('a paused shared limit stops every workflow that holds it', async () => {
    orThrow(await journal.limits.pause(db, { name: 'test.pool' }, ops));
    expect(busyOf(await start(poolA, newId('acc')))).toMatchObject({ reason: 'paused', limitName: 'test.pool' });
    expect(busyOf(await start(poolB, newId('acc')))).toMatchObject({ reason: 'paused', limitName: 'test.pool' });
    orThrow(await journal.limits.resume(db, { name: 'test.pool' }, ops));
    expect(isFailure(await start(poolA, newId('acc')))).toBe(false);
    await release(poolA);
  });

  it('a pause offers no join: the caller would follow a run of a limit the operator stopped', async () => {
    const account = newId('acc');
    orThrow(await start(joined, account));
    orThrow(await journal.limits.pause(db, { name: 'workflow/test.joined' }, ops));
    expect(busyOf(await start(joined, account))).toMatchObject({ reason: 'paused', running: [] });
    orThrow(await journal.limits.resume(db, { name: 'workflow/test.joined' }, ops));
    await release(joined);
  });

  it('a workflow without concurrency can be paused by its own limit name, and the same start again is still its run', async () => {
    const id = newId('plain');
    const account = newId('acc');
    orThrow(await start(plain, account, { id }));
    orThrow(await journal.limits.pause(db, { name: 'workflow/test.plain' }, ops));
    expect(busyOf(await start(plain, newId('acc')))).toMatchObject({
      reason: 'paused',
      limitName: 'workflow/test.plain',
    });
    expect(await start(plain, account, { id })).toEqual({ runId: id });
    orThrow(await journal.limits.resume(db, { name: 'workflow/test.plain' }, ops));
    expect(isFailure(await start(plain, newId('acc')))).toBe(false);
    await release(plain);
  });
});

describe('the limit verbs', () => {
  it('each change is an event on the limit that names the operator and the reason', async () => {
    orThrow(await journal.limits.pause(db, { name: 'test.narrow' }, ops));
    orThrow(await journal.limits.resume(db, { name: 'test.narrow' }, { actor: 'usr_lead' }));
    const recorded = await db
      .select({ type: tables.events.type, data: tables.events.data })
      .from(tables.events)
      .where(and(eq(tables.events.kind, 'journal.limit'), eq(tables.events.entityId, 'test.narrow')))
      .orderBy(tables.events.seq);
    expect(recorded).toMatchObject([
      { type: 'LimitPaused', data: { actorId: 'usr_ops', reason: 'incident 42' } },
      { type: 'LimitResumed', data: { actorId: 'usr_lead' } },
    ]);
  });

  it('an unknown limit name is CommandNotFound, never a row for a limit nothing holds', async () => {
    expect(CommandNotFound.is(await journal.limits.pause(db, { name: 'test.nope' }, ops))).toBe(true);
    expect(CommandNotFound.is(await journal.limits.get(db, 'test.nope'))).toBe(true);
    const rows = await db.select().from(tables.limits).where(eq(tables.limits.name, 'test.nope'));
    expect(rows).toEqual([]);
  });

  it('list shows every limit the workflows hold: the shared ones and each workflow its own', async () => {
    const listed = await journal.limits.list(db);
    const names = listed.map(limit => limit.name);
    expect(names).toEqual(expect.arrayContaining(['test.pool', 'test.per-account', 'workflow/test.plain']));
    expect(listed.find(limit => limit.name === 'test.pool')).toMatchObject({
      workflows: ['test.pool-a', 'test.pool-b'],
      code: { total: 2, perKey: null },
      effective: { total: 2, perKey: null },
      paused: false,
    });
  });
});

describe('limits across scopes', () => {
  it('a full shared limit refuses another scope but never names its runs', async () => {
    const tenantA = orThrow(await start(poolA, newId('acc'), { scope: 'ten_a' }));
    orThrow(await start(poolB, newId('acc'), { scope: 'ten_a' }));
    const fromB = busyOf(await start(poolA, newId('acc'), { scope: 'ten_b' }));
    expect(fromB.running).toEqual([]);
    expect(JSON.stringify(fromB)).not.toContain(tenantA.runId);
    expect(busyOf(await start(poolA, newId('acc'), { scope: 'ten_a' })).running).toContain(tenantA.runId);
    await release(poolA);
    await release(poolB);
  });

  it("a shared perKey refuses another scope's start of the key without naming or joining its run", async () => {
    const account = newId('shared');
    const tenantA = orThrow(await start(accountA, account, { scope: 'ten_a' }));
    const fromB = busyOf(await start(accountB, account, { scope: 'ten_b' }));
    expect(fromB.running).toEqual([]);
    expect(JSON.stringify(fromB)).not.toContain(tenantA.runId);
    await release(accountA);
  });

  it("an override's raised perKey still never joins another scope's run", async () => {
    const account = newId('shared');
    const tenantA = orThrow(await start(joined, account, { scope: 'ten_a' }));
    const fromB = await start(joined, account, { scope: 'ten_b' });
    expect(WorkflowBusy.is(fromB)).toBe(true);
    expect(JSON.stringify(fromB)).not.toContain(tenantA.runId);
    await release(joined);
  });
});

/** A workflow definition to throw from, under a name no other test uses. */
const define = (concurrency: Parameters<typeof parked>[1]) => () => parked(newId('test.def'), concurrency);

describe('limit definitions', () => {
  it('a limit with no value, a bad value or a workflow/ name throws when it is defined', () => {
    expect(() => j.limit({ name: 'test.empty' })).toThrow(/total, perKey or both/);
    expect(() => j.limit({ name: 'test.zero', total: 0 })).toThrow(/positive whole number/);
    expect(() => j.limit({ name: 'workflow/x', total: 1 })).toThrow(/own limit/);
  });

  it('concurrency that would count something else than it says throws when the workflow is defined', () => {
    const one = j.limit({ name: 'test.one', total: 1 });
    const two = j.limit({ name: 'test.two', total: 1 });
    const three = j.limit({ name: 'test.three', total: 1 });
    expect(define({ shared: [one, two, three], onBusy: 'refuse' })).toThrow(/at most 2/);
    expect(define({ limit: 1, onBusy: 'refuse' })).toThrow(/needs concurrency.key/);
    expect(define({ onBusy: 'refuse' })).toThrow(/limits nothing/);
    expect(define({ shared: [perAccount], onBusy: 'refuse' })).toThrow(/needs a key/);
  });

  it('two limits of one name with other values make compose throw, so one name never counts by two sets of values', () => {
    const own = initJournal({ tables: journalTables(), meta: z.object({ actorId: z.string() }) });
    const first = own
      .workflow('test.first', {
        version: 1,
        input: accountInput,
        concurrency: { shared: [own.limit({ name: 'test.clash', total: 1 })], onBusy: 'refuse' },
      })
      .step('a', () => null)
      .finish();
    const second = own
      .workflow('test.second', {
        version: 1,
        input: accountInput,
        concurrency: { shared: [own.limit({ name: 'test.clash', total: 2 })], onBusy: 'refuse' },
      })
      .step('a', () => null)
      .finish();
    expect(() => own.compose({ workflows: [first, second], workflowMeta })).toThrow(/other values/);
  });
});
