/**
 * A child ending and its parent on real Postgres with two connections: a child finishing against its parent being
 * cancelled, and two children of one map finishing together. Whichever commits first moves the parent, and the other
 * finds it moved. Needs Docker: starts a `postgres:16` container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';

import { j, tables } from '../test-support.js';

const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const Go = z.object({});

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: NodePgDatabase;
let dbB: NodePgDatabase;
let next = 0;

const noop = (): void => {
  // Replaced by the promise's resolver before the gate is returned.
};

/** A promise a test settles by hand, to hold a command at a chosen point. */
function gate() {
  let open = noop;
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return { opened, open };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  poolA = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  poolB = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
  const { apply } = await pushSchema({ ...tables }, dbA);
  await apply();
}, 120_000);

afterAll(async () => {
  await poolA.end();
  await poolB.end();
  await container.stop();
});

/** Holds a slot, undoes it, waits for `go`. */
const kid = j
  .workflow('test.pgkid', { version: 1, input: z.object({ n: z.int() }) })
  .step('hold', ({ input }) => ({ slot: input.n }), { undo: () => 0 })
  .waitFor('go', { signal: 'go', schema: Go })
  .step('done', ({ results }) => ({ slot: results.hold.slot }))
  .finish();
const single = j
  .workflow('test.pgparent.single', { version: 1, input: z.object({}) })
  .child('kid', kid, { input: () => ({ n: 1 }) })
  .step('after', ({ results }) => results.kid.slot)
  .finish();
const pair = j
  .workflow('test.pgparent.pair', { version: 1, input: z.object({}) })
  .map('fan', kid, { items: () => [0, 1], input: (_ctx, n) => ({ n }) })
  .step('after', ({ results }) => results.fan.map(entry => entry.slot))
  .finish();

const either = j
  .workflow('test.pgparent.either', { version: 1, input: z.object({}) })
  .map('fan', kid, { items: () => [0, 1], input: (_ctx, n) => ({ n }), wait: 'any' })
  .step('after', ({ results }) => results.fan.slot)
  .finish();

const journal = j.compose({ workflows: [kid, single, pair, either], workflowMeta });

type Side = 'first' | 'second' | 'cancel';
type Hold = { readonly arrived: ReturnType<typeof gate>; readonly release: ReturnType<typeof gate> };
const holds = new Map<Side, Hold>();
const hold = (side: Side): Hold => {
  const made = { arrived: gate(), release: gate() };
  holds.set(side, made);
  return made;
};
/** The signal to child `n` is held as `first` or `second`; a cancel as `cancel`. */
const sideOf = (name: string, input: unknown): Side | undefined => {
  if (name.endsWith('.cancel')) return 'cancel';
  if (name !== 'test.pgkid.signal.go') return undefined;
  const asked = z.object({ runId: z.string() }).safeParse(input);
  return asked.success && asked.data.runId.endsWith('[1]') ? 'second' : 'first';
};
journal.hooks.command.around(async (ctx, next) => {
  const side = sideOf(ctx.name, ctx.input);
  const held = side === undefined ? undefined : holds.get(side);
  if (held !== undefined) {
    holds.delete(side ?? 'first');
    held.arrived.open();
    await held.release.opened;
  }
  await next();
});

beforeEach(async () => {
  holds.clear();
  await dbA.delete(tables.jobs).where(sql`true`);
});

const expectOk = (result: unknown) => {
  expect(isFailure(result)).toBe(false);
};
const typesOf = async (id: string) => {
  const found = await dbA
    .select({ type: tables.events.type })
    .from(tables.events)
    .where(eq(tables.events.entityId, id))
    .orderBy(asc(tables.events.seq));
  return found.map(event => event.type);
};
const stateOf = async (id: string) => {
  const [row] = await dbA.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
  return row?.state;
};
const ends = (types: readonly string[]) =>
  types.filter(type => ['RunCompleted', 'RunFailed', 'RunCancelled'].includes(type));

async function parkedOnChild(def: typeof single | typeof pair | typeof either, label: string) {
  const id = `${label}_${++next}`;
  expectOk(await journal.run(dbA, def.start, { input: {}, id }, caller));
  await journal.drain(dbA).then(result => orThrow(result));
  expect(await stateOf(id)).toBe('parked');
  return id;
}

describe('a child ending races the parent', () => {
  it('a child finishing and its parent being cancelled resolve exactly once', async () => {
    for (let round = 0; round < 8; round++) {
      const id = await parkedOnChild(single, 'cancelrace');
      const kidId = `${id}/kid`;
      const finishing = hold('first');
      const stopping = hold('cancel');
      const finished = journal.run(
        dbB,
        kid.signal('go'),
        { runId: kidId, deliveryId: `d${round}`, payload: {} },
        caller,
      );
      const cancelled = journal.run(dbA, single.cancel, { runId: id, reason: 'race' }, caller);
      await Promise.all([finishing.arrived.opened, stopping.arrived.opened]);
      finishing.release.open();
      stopping.release.open();
      const [finishedResult, cancelResult] = await Promise.all([finished, cancelled]);
      expectOk(finishedResult);
      for (let pass = 0; pass < 30; pass++) if ((await journal.drain(dbA).then(result => orThrow(result))) === 0) break;
      const parent = await typesOf(id);
      const child = await typesOf(kidId);
      const label = `round ${round}: parent ${parent.join(',')} | child ${child.join(',')}`;
      // Each run ends once, and the two end the same way: a completed parent has a completed child; a cancelled one has none left over.
      expect(ends(parent), label).toHaveLength(1);
      expect(child.filter(type => type === 'RunCompleted').length, label).toBeLessThanOrEqual(1);
      expect(child.filter(type => type === 'RunCancelled').length, label).toBeLessThanOrEqual(1);
      expect((await stateOf(id)) === 'completed', label).toBe((await stateOf(kidId)) === 'completed');
      expect(['completed', 'cancelled'], label).toContain(await stateOf(id));
      // A cancel that came after the end is a returned conflict, never a second end.
      if ((await stateOf(id)) === 'completed') expect(isFailure(cancelResult), label).toBe(true);
      expect(parent.filter(type => type === 'CompensationStarted').length, label).toBeLessThanOrEqual(1);
    }
  }, 120_000);

  it('two map children finishing together advance the parent once', async () => {
    for (let round = 0; round < 8; round++) {
      const id = await parkedOnChild(pair, 'pairrace');
      const first = hold('first');
      const second = hold('second');
      const a = journal.run(
        dbA,
        kid.signal('go'),
        { runId: `${id}/fan[0]`, deliveryId: `a${round}`, payload: {} },
        caller,
      );
      const b = journal.run(
        dbB,
        kid.signal('go'),
        { runId: `${id}/fan[1]`, deliveryId: `b${round}`, payload: {} },
        caller,
      );
      await Promise.all([first.arrived.opened, second.arrived.opened]);
      first.release.open();
      second.release.open();
      const [aResult, bResult] = await Promise.all([a, b]);
      expectOk(aResult);
      expectOk(bResult);
      for (let pass = 0; pass < 30; pass++) if ((await journal.drain(dbA).then(result => orThrow(result))) === 0) break;
      const parent = await typesOf(id);
      const label = `round ${round}: ${parent.join(',')}`;
      const [row] = await dbA.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, id));
      expect(row, label).toMatchObject({ state: 'completed', output: [0, 1] });
      expect(
        parent.filter(type => type === 'RunCompleted'),
        label,
      ).toHaveLength(1);
      // The node completed once, however the two ends were ordered.
      const [fanDone] = await dbA
        .select({ n: sql<string>`count(*)` })
        .from(tables.events)
        .where(
          sql`${tables.events.entityId} = ${id} and ${tables.events.type} = 'NodeCompleted' and ${tables.events.data} ->> 'path' = 'fan'`,
        );
      expect(Number(fanDone?.n), label).toBe(1);
    }
  }, 120_000);

  it('two any children finishing together complete the node once', async () => {
    for (let round = 0; round < 8; round++) {
      const id = await parkedOnChild(either, 'eitherrace');
      const first = hold('first');
      const second = hold('second');
      const a = journal.run(
        dbA,
        kid.signal('go'),
        { runId: `${id}/fan[0]`, deliveryId: `a${round}`, payload: {} },
        caller,
      );
      const b = journal.run(
        dbB,
        kid.signal('go'),
        { runId: `${id}/fan[1]`, deliveryId: `b${round}`, payload: {} },
        caller,
      );
      await Promise.all([first.arrived.opened, second.arrived.opened]);
      first.release.open();
      second.release.open();
      expectOk(await a);
      expectOk(await b);
      for (let pass = 0; pass < 30; pass++) if ((await journal.drain(dbA).then(result => orThrow(result))) === 0) break;
      const parent = await typesOf(id);
      const label = `round ${round}: ${parent.join(',')}`;
      expect(await stateOf(id), label).toBe('completed');
      expect(parent.filter(type => type === 'NodeCompleted').length, label).toBe(2);
      expect(ends(parent), label).toHaveLength(1);
    }
  }, 120_000);
});
