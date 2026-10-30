/**
 * The design's worked example, on real Postgres with two connections: a prayer reminder. Setting a reminder starts a run
 * in the event's transaction. The run works out when the next reminder is due, then waits for that time or for an event
 * that stops it, whichever comes first. A wait that doubles as an interruptible sleep is what makes this one loop instead
 * of a timer job plus a cancel job per prayer. PGlite has one connection, so it cannot show the races. Needs Docker:
 * starts a `postgres:16` container through testcontainers.
 */
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { pushSchema } from 'drizzle-kit/api-postgres';
import { and, asc, count, eq, isNotNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';

import { initJournal } from '../journal.js';
import { journalTables } from '../pg.js';
import { workflowHarnessOn } from '../testing.js';

type PrayerId = `pry_${string}`;
const prayerId = (n: number): PrayerId => `pry_${n}`;
const prayerIdSchema = z.templateLiteral(['pry_', z.string()]);

const prayers = pgTable('prayers', {
  id: varchar('id', { length: 256 }).primaryKey().$type<PrayerId>(),
  status: varchar('status', { enum: ['open', 'answered', 'deleted'] }).notNull(),
  version: integer('version').notNull().default(0),
});
/** One row per push the provider took. The key is the step's own, so a repeated step sends nothing twice. */
const pushes = pgTable('prayer_pushes', {
  key: varchar('key', { length: 512 }).primaryKey(),
  prayerId: varchar('prayer_id', { length: 256 }).notNull(),
});

const tables = journalTables();
const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_test' };
const WAKE = 'workflow.wake:prayer';
const TIMER = 'workflow.timer';
const EVERY_MINUTE = 1;
const WAKE_COMMAND = 'workflow.wake';
/** Set by a test: the next wake job dies right after its work, as a worker that was killed there would. */
const wakeDies = { armed: false };
/** Every run a wake job tried to move, so a test can see the wake that had no reason to run. */
const wakesRun: string[] = [];
/** Set by a test: the next wake command stops at its start until the test lets it go. */
const wakeHeld: { gate?: { readonly arrived: ReturnType<typeof gate>; readonly release: ReturnType<typeof gate> } } = {};

const noop = (): void => {
  // Replaced by the promise's resolver before the gate is returned.
};
/** A promise a test settles by hand, to hold a command at a chosen point. */
function gate() {
  let open = noop;
  const opened = new Promise<void>(resolve => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

function reminderApp() {
  const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
  const PrayerCreated = j.event('PrayerCreated', z.object({}));
  const PrayerReminderSet = j.event('PrayerReminderSet', z.object({ everyMinutes: z.int().positive() }));
  const PrayerReminderCleared = j.event('PrayerReminderCleared', z.object({}));
  const PrayerAnswered = j.event('PrayerAnswered', z.object({ how: z.string().min(1) }));
  const PrayerDeleted = j.event('PrayerDeleted', z.object({}));
  const prayer = j
    .entity('prayer', prayers, { events: 'stored' })
    .create(PrayerCreated, () => ({ status: 'open' }))
    .on(PrayerReminderSet, () => ({}))
    .on(PrayerReminderCleared, () => ({}))
    .on(PrayerAnswered, () => ({ status: 'answered' }))
    .on(PrayerDeleted, () => ({ status: 'deleted' }));

  const reminder = j
    .workflow('prayer-reminder', {
      version: 1,
      input: z.object({ prayerId: prayerIdSchema, everyMinutes: z.int().positive() }),
      startOn: {
        entity: prayer,
        event: PrayerReminderSet,
        id: e => `reminder:${e.entityId}:${e.seq}`,
        input: e => ({ prayerId: e.entityId, everyMinutes: e.data.everyMinutes }),
        timing: 'with-event',
      },
      limits: { transitions: 50_000 },
    })
    .step('due', ({ input }) => ({ at: new Date(Date.now() + input.everyMinutes * 60_000).toISOString() }))
    .waitFor('stop', {
      on: {
        prayer: {
          entity: prayer,
          match: ({ input }) => input.prayerId,
          events: [PrayerAnswered, PrayerDeleted, PrayerReminderCleared, PrayerReminderSet],
        },
      },
      until: ({ results }) => new Date(results.due.at),
      onTimeout: 'continue',
    })
    .step(
      'remind',
      async ({ input, key, db }) => {
        await db.insert(pushes).values({ key, prayerId: input.prayerId }).onConflictDoNothing();
      },
      { when: ({ results }) => results.stop === null, next: 'due' },
    )
    .finish(({ results }) => ({ stoppedBy: results.stop?.event.type ?? null }));

  /** Two waits in a row: a timer can move the run on from the first while a wake for it is still on its way. */
  const handoff = j
    .workflow('prayer-handoff', { version: 1, input: z.object({ prayerId: prayerIdSchema }) })
    .waitFor('first', {
      on: { prayer: { entity: prayer, match: ({ input }) => input.prayerId, events: [PrayerAnswered] } },
      timeout: `${EVERY_MINUTE}m`,
      onTimeout: 'continue',
    })
    .waitFor('second', {
      on: { prayer: { entity: prayer, match: ({ input }) => input.prayerId, events: [PrayerDeleted] } },
    })
    .finish();

  const journal = j.compose({ workflows: [reminder, handoff], workflowMeta });
  journal.hooks.command.around(async (ctx, next) => {
    if (ctx.name === WAKE_COMMAND) {
      wakesRun.push(z.object({ runId: z.string() }).parse(ctx.input).runId);
      if (wakeHeld.gate !== undefined) {
        const { arrived, release } = wakeHeld.gate;
        wakeHeld.gate = undefined;
        arrived.open();
        await release.opened;
      }
    }
    return next();
  });
  journal.hooks.effect.around(async (ctx, next) => {
    await next();
    if (ctx.name === WAKE && wakeDies.armed) {
      wakeDies.armed = false;
      throw new Error('the worker died after the wake committed');
    }
  });
  return {
    tables,
    journal,
    reminder,
    handoff,
    prayer,
    PrayerCreated,
    PrayerReminderSet,
    PrayerReminderCleared,
    PrayerAnswered,
    PrayerDeleted,
  };
}

const harnessFor = (db: NodePgDatabase) => workflowHarnessOn(db, { setup: reminderApp });

let container: StartedPostgreSqlContainer;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: NodePgDatabase;
let dbB: NodePgDatabase;
let h: ReturnType<typeof harnessFor>;
let next = 0;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  poolA = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  poolB = new pg.Pool({ connectionString: container.getConnectionUri(), max: 4 });
  dbA = drizzle({ client: poolA });
  dbB = drizzle({ client: poolB });
  const { apply } = await pushSchema({ ...tables, prayers, pushes }, dbA);
  await apply();
  h = harnessFor(dbA);
}, 120_000);

afterAll(async () => {
  await poolA.end();
  await poolB.end();
  await container.stop();
});

// Each test starts with no due job and no parked run, so a `tick` moves only its own runs.
beforeEach(async () => {
  wakesRun.length = 0;
  await dbA.execute(sql`truncate ${tables.events}, ${tables.jobs}, ${tables.workflowRuns}, ${prayers}, ${pushes} cascade`);
});

const newPrayer = async () => {
  const id = prayerId(++next);
  orThrow(await h.journal.write(h.db, h.prayer, id, { meta: caller, events: () => [h.PrayerCreated({})] }));
  return id;
};
/** Sets a reminder and gives the id of the run it started, which the write committed with the event. */
const setReminder = async (id: PrayerId, db: NodePgDatabase = h.db) => {
  const written = orThrow(
    await h.journal.write(db, h.prayer, id, {
      meta: caller,
      events: () => [h.PrayerReminderSet({ everyMinutes: EVERY_MINUTE })],
    }),
  );
  return `reminder:${id}:${written.events[0]?.seq}`;
};
const answer = async (id: PrayerId, db: NodePgDatabase = h.db) =>
  orThrow(await h.journal.write(db, h.prayer, id, { meta: caller, events: () => [h.PrayerAnswered({ how: 'yes' })] }));

const stateOf = async (runId: string) => {
  const [row] = await h.db
    .select({ state: tables.workflowRuns.state, node: tables.workflowRuns.node, output: tables.workflowRuns.output })
    .from(tables.workflowRuns)
    .where(eq(tables.workflowRuns.id, runId));
  return row;
};
const pushCount = async (id: PrayerId) => {
  const [row] = await h.db.select({ n: count() }).from(pushes).where(eq(pushes.prayerId, id));
  return row?.n ?? 0;
};
const waitRows = (runId: string) => h.db.select().from(tables.workflowWaits).where(eq(tables.workflowWaits.runId, runId));
/** The events of a run, of the types asked for, oldest first. */
const runEvents = async (runId: string, ...types: readonly string[]) => {
  const rows = await h.db
    .select({ type: tables.events.type, data: tables.events.data })
    .from(tables.events)
    .where(and(eq(tables.events.kind, 'workflow.run'), eq(tables.events.entityId, runId)))
    .orderBy(asc(tables.events.seq));
  return rows.filter(row => types.includes(row.type));
};
/** How many times the wait ended, however it ended: each visit may end once. */
const stopEnds = async (runId: string) => {
  const ended = await runEvents(runId, 'NodeCompleted');
  return ended.filter(row => z.object({ path: z.string() }).parse(row.data).path === 'stop').length;
};
const drained = async () => expect(isFailure(await h.drain())).toBe(false);

/** A prayer with a reminder, parked on its wait. */
const parkedReminder = async () => {
  const id = await newPrayer();
  const runId = await setReminder(id);
  await drained();
  expect(await stateOf(runId)).toMatchObject({ state: 'parked', node: 'stop' });
  return { id, runId };
};

describe('the prayer reminder', () => {
  it('the deadline fires and the loop goes round more than once, each round on a wait of its own', async () => {
    const { id, runId } = await parkedReminder();
    expect(await pushCount(id)).toBe(0);
    for (const round of [1, 2, 3]) {
      await h.tick(`${EVERY_MINUTE}m`);
      await drained();
      // Each round sends one push and parks again: the run is not over, it is on its next wait.
      expect(await pushCount(id)).toBe(round);
      expect(await stateOf(runId)).toMatchObject({ state: 'parked', node: 'stop' });
      expect(await waitRows(runId)).toHaveLength(1);
    }
    expect(await runEvents(runId, 'TimerFired')).toHaveLength(3);
  });

  it('PrayerAnswered ends the run before the next reminder', async () => {
    const { id, runId } = await parkedReminder();
    await h.tick(`${EVERY_MINUTE}m`);
    await drained();
    expect(await pushCount(id)).toBe(1);

    await answer(id);
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { stoppedBy: 'PrayerAnswered' } });
    // The run is over, so its wait and its timer went with it: a later tick has nothing to send.
    expect(await waitRows(runId)).toEqual([]);
    await h.tick(`${EVERY_MINUTE}m`);
    await drained();
    expect(await pushCount(id)).toBe(1);
  });

  it('a new PrayerReminderSet ends the old run, and the new run takes over', async () => {
    const { id, runId: oldRun } = await parkedReminder();
    const newRun = await setReminder(id);
    expect(newRun).not.toBe(oldRun);
    await drained();

    expect(await stateOf(oldRun)).toMatchObject({ state: 'completed', output: { stoppedBy: 'PrayerReminderSet' } });
    // The event that started the new run is what ended the old one. It does not stop the run it started.
    expect(await stateOf(newRun)).toMatchObject({ state: 'parked', node: 'stop' });

    await h.tick(`${EVERY_MINUTE}m`);
    await drained();
    expect(await pushCount(id)).toBe(1);
    expect(await stateOf(newRun)).toMatchObject({ state: 'parked', node: 'stop' });
  });

  it('an event committed before the worker parks is not lost', async () => {
    const id = await newPrayer();
    const runId = await setReminder(id);
    // The answer commits while the run's first step job has not even run, and its wake finds no wait to wake.
    await answer(id);
    orThrow(await h.release(job => job.effect === WAKE && job.type === 'PrayerAnswered'));
    expect(await waitRows(runId)).toEqual([]);
    expect(await stateOf(runId)).toMatchObject({ state: 'running' });

    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { stoppedBy: 'PrayerAnswered' } });
    expect(await pushCount(id)).toBe(0);
    // It never parked: the wait read the log and took the event on arrival.
    expect(await runEvents(runId, 'Parked')).toEqual([]);
  });

  it('an event between two rounds of the loop is kept for the next round', async () => {
    const { id, runId } = await parkedReminder();
    await h.tick(`${EVERY_MINUTE}m`);
    orThrow(await h.release(job => job.effect === TIMER));
    // The wait timed out, and the run is on its way back round to it, when the answer commits.
    await answer(id);
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { stoppedBy: 'PrayerAnswered' } });
    // The one push is the round that had timed out already. There is no round after it.
    expect(await pushCount(id)).toBe(1);
  });

  it('an event on another prayer does not wake the run', async () => {
    const { id, runId } = await parkedReminder();
    const other = await newPrayer();
    await answer(other);
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'parked', node: 'stop' });
    expect(await runEvents(runId, 'WaitEventTaken')).toEqual([]);
    expect(await waitRows(runId)).toEqual([
      expect.objectContaining({ entityKind: 'prayer', entityId: id, label: 'prayer' }),
    ]);
  });

  it('a duplicate delivery of the wake moves the run once', async () => {
    const { id, runId } = await parkedReminder();
    // The worker dies after the wake committed and before the job was marked done, so the job runs a second time.
    wakeDies.armed = true;
    await answer(id);
    orThrow(await h.release(job => job.effect === WAKE));
    expect(wakeDies.armed).toBe(false);
    expect(await stopEnds(runId)).toBe(1);
    await h.tick('5m');
    await drained();

    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { stoppedBy: 'PrayerAnswered' } });
    expect(await stopEnds(runId)).toBe(1);
    expect(await runEvents(runId, 'WaitEventTaken')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ node: 'stop', label: 'prayer' }) }),
    ]);
  });

  it('a restart between the park and the wake loses nothing', async () => {
    const { id, runId } = await parkedReminder();
    await answer(id);
    // The process dies with the wake job still queued. A new process reads the same rows.
    h.crash();
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { stoppedBy: 'PrayerAnswered' } });
    expect(await pushCount(id)).toBe(0);
  });

  it('a restart between a wait timing out and the next round keeps the loop going', async () => {
    const { id, runId } = await parkedReminder();
    await h.tick(`${EVERY_MINUTE}m`);
    orThrow(await h.release(job => job.effect === TIMER));
    h.crash();
    await drained();
    expect(await pushCount(id)).toBe(1);
    expect(await stateOf(runId)).toMatchObject({ state: 'parked', node: 'stop' });
  });
});

const keyLock = (id: PrayerId) =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`workflow-wait:prayer:${id}`}, 0))`;
const settleBriefly = () => new Promise(resolve => setTimeout(resolve, 150));

describe('the correlation key', () => {
  it('a park waits for the lock of its key', async () => {
    const id = await newPrayer();
    const runId = await setReminder(id);
    orThrow(await h.release(job => job.effect === 'workflow.step'));
    const parking = await dbB.transaction(async tx => {
      await tx.execute(keyLock(id));
      const released = h.release(job => job.effect === 'workflow.step');
      await settleBriefly();
      expect(await stateOf(runId)).toMatchObject({ state: 'running' });
      return { released };
    });
    // The transaction ended, so the lock is free and the park goes through.
    orThrow(await parking.released);
    expect(await stateOf(runId)).toMatchObject({ state: 'parked' });
  });

  it('a wake waits for the lock of its key', async () => {
    const { id, runId } = await parkedReminder();
    await answer(id);
    const waking = await dbB.transaction(async tx => {
      await tx.execute(keyLock(id));
      const released = h.release(job => job.effect === WAKE && job.type === 'PrayerAnswered');
      await settleBriefly();
      expect(await stateOf(runId)).toMatchObject({ state: 'parked' });
      expect(wakesRun).toEqual([]);
      return { released };
    });
    orThrow(await waking.released);
    expect(wakesRun).toEqual([runId]);
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'completed' });
  });

  it('a wake leaves alone a run whose wait starts after the event, and one that waits for another type', async () => {
    const { id, runId: oldRun } = await parkedReminder();
    const newRun = await setReminder(id);
    // The new run parks before the wake job of the event that started it runs: its wait starts after that event.
    orThrow(await h.release(job => job.effect === 'workflow.step'));
    orThrow(await h.release(job => job.effect === 'workflow.step'));
    expect(await waitRows(newRun)).toHaveLength(1);
    await drained();
    expect(wakesRun).toEqual([oldRun]);

    const firstOnly = await newPrayer();
    orThrow(await h.journal.run(h.db, h.handoff.start, { id: 'run_type', input: { prayerId: firstOnly } }, caller));
    await drained();
    wakesRun.length = 0;
    orThrow(await h.journal.write(h.db, h.prayer, firstOnly, { meta: caller, events: () => [h.PrayerDeleted({})] }));
    await drained();
    // It waits for `PrayerAnswered` here, and `PrayerDeleted` is for its next wait.
    expect(wakesRun).toEqual([]);
  });

  it('a wake that arrives after the run moved to another wait changes nothing', async () => {
    const id = await newPrayer();
    const runId = 'run_handoff';
    orThrow(await h.journal.run(h.db, h.handoff.start, { id: runId, input: { prayerId: id } }, caller));
    await drained();
    await answer(id);
    // The wake has read its waiters and stops. The timer then takes the event, and the run moves to `second`.
    const held = { arrived: gate(), release: gate() };
    wakeHeld.gate = held;
    const waking = h.journal.drain(dbB, { batchSize: 1, leaseSeconds: 3600 });
    await held.arrived.opened;
    await h.tick(`${EVERY_MINUTE}m`);
    await drained();
    expect(await stateOf(runId)).toMatchObject({ state: 'parked', node: 'second' });
    held.release.open();
    expect(await waking).toBe(1);

    expect(await stateOf(runId)).toMatchObject({ state: 'parked', node: 'second' });
    const dead = await h.db.select().from(tables.jobs).where(isNotNull(tables.jobs.deadAt));
    expect(dead).toEqual([]);
    expect(await runEvents(runId, 'WaitEventTaken')).toHaveLength(1);
  });
});

describe('an event and the deadline, under real concurrency', () => {
  it('both workers run at the same moment, and exactly one moves the run', async () => {
    const { id, runId } = await parkedReminder();
    await h.tick(`${EVERY_MINUTE}m`);
    await answer(id);
    const jobs = await h.dueJobs();
    expect(jobs.map(job => job.effect).toSorted()).toEqual([TIMER, WAKE]);
    const both = await Promise.all([
      h.journal.drain(dbA, { batchSize: 1 }),
      h.journal.drain(dbB, { batchSize: 1 }),
    ]);
    expect(both).toEqual([1, 1]);
    await drained();

    expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { stoppedBy: 'PrayerAnswered' } });
    expect(await stopEnds(runId)).toBe(1);
    expect(await runEvents(runId, 'WaitEventTaken')).toHaveLength(1);
    // The event committed before either worker looked, so the timer took it too: nobody was sent a reminder.
    expect(await runEvents(runId, 'TimerFired')).toEqual([]);
    expect(await pushCount(id)).toBe(0);
  });

  it('the event commits while the timer fires, many times over: each visit ends once, and no answer is lost', async () => {
    const rounds = 40;
    let timerFirst = 0;
    let eventFirst = 0;
    for (let round = 0; round < rounds; round++) {
      const { id, runId } = await parkedReminder();
      await h.tick(`${EVERY_MINUTE}m`);
      // One connection commits the answer, the other runs the timer job. Neither waits for the other. The answer leaves
      // a little later each round, so the two meet at every point of the timer job, and each side wins some rounds.
      const lateAnswer = async () => {
        await new Promise(resolve => setTimeout(resolve, round % 20));
        return answer(id, dbB);
      };
      const [drainedByTimer] = await Promise.all([h.journal.drain(dbA, { batchSize: 1 }), lateAnswer()]);
      expect(drainedByTimer).toBe(1);
      await drained();

      const fired = await runEvents(runId, 'TimerFired');
      const taken = await runEvents(runId, 'WaitEventTaken');
      expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { stoppedBy: 'PrayerAnswered' } });
      expect(taken).toHaveLength(1);
      expect(fired.length).toBeLessThanOrEqual(1);
      // A deadline that won is one more visit, and one push. The answer is taken on the next. Never both on one visit.
      expect(await stopEnds(runId)).toBe(fired.length + taken.length);
      expect(await pushCount(id)).toBe(fired.length);
      expect(await waitRows(runId)).toEqual([]);
      if (fired.length === 1) timerFirst += 1;
      else eventFirst += 1;
    }
    expect(timerFirst + eventFirst).toBe(rounds);
    // The split is the evidence: both sides must have had their chance. Shown with `--silent=false`.
    console.info(`event against deadline over ${rounds} rounds: timer first ${timerFirst}, event first ${eventFirst}`);
  }, 120_000);

  it('a park and an event that commit together never lose the event', async () => {
    const rounds = 30;
    for (let round = 0; round < rounds; round++) {
      const id = await newPrayer();
      const runId = await setReminder(id);
      // The first step and the wait's park run on one connection while the answer commits on the other.
      const parking = (async () => {
        orThrow(await h.journal.drain(dbA, { batchSize: 1 }));
        orThrow(await h.journal.drain(dbA, { batchSize: 1 }));
      })();
      await Promise.all([parking, answer(id, dbB)]);
      await drained();
      expect(await stateOf(runId)).toMatchObject({ state: 'completed', output: { stoppedBy: 'PrayerAnswered' } });
      expect(await pushCount(id)).toBe(0);
      expect(await waitRows(runId)).toEqual([]);
    }
  }, 120_000);
});
