/**
 * Event waits, on the harness's database: the rules a process manager leans on. `prayer-reminder.pg.test.ts` proves the
 * races on real Postgres; these prove what a wait takes, when, and what it leaves behind.
 */
import { and, asc, eq } from 'drizzle-orm';
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow } from '@arki/failure';

import { JournalError, WorkflowReadMismatch } from '../errors.js';
import { initJournal } from '../journal.js';
import { journalTables } from '../pg.js';
import { createJobOps } from '../outbox.js';
import { resolveRetention } from '../retention.js';
import { workflowHarness } from '../testing.js';
import { workflow } from './define.js';

type TicketId = `tkt_${string}`;
type UserId = `usr_${string}`;
const ticketIdSchema = z.templateLiteral(['tkt_', z.string()]);

const tickets = pgTable('wait_tickets', {
  id: varchar('id', { length: 256 }).primaryKey().$type<TicketId>(),
  note: varchar('note', { length: 256 }).notNull().default(''),
  version: integer('version').notNull().default(0),
});
const users = pgTable('wait_users', {
  id: varchar('id', { length: 256 }).primaryKey().$type<UserId>(),
  version: integer('version').notNull().default(0),
});

const tables = journalTables();
const workflowMeta = { actorId: 'system:workflow' };
const caller = { actorId: 'usr_caller' };
const noWake = () => {
  /* Nothing to wake: the test drains by hand. */
};

function ticketApp() {
  const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
  const Opened = j.event('Opened', z.object({ title: z.string().min(1) }));
  const Replied = j.event('Replied', z.object({ text: z.string().min(1) }));
  const Closed = j.event('Closed', z.object({}));
  const Escalated = j.event('Escalated', z.object({}));
  const ticket = j
    .entity('wait-ticket', tickets, { events: 'stored' })
    .create(Opened, () => ({}))
    .on(Replied, () => ({}))
    .on(Closed, () => ({}))
    .on(Escalated, () => ({}));
  const UserJoined = j.event('UserJoined', z.object({}));
  const UserLeft = j.event('UserLeft', z.object({}));
  const user = j
    .entity('wait-user', users, { events: 'stored' })
    .create(UserJoined, () => ({}))
    .on(UserLeft, () => ({}));
  const input = z.object({ ticket: ticketIdSchema });

  const ticketOf = (view: { readonly input: { readonly ticket: TicketId } }) => view.input.ticket;
  const onReply = { ticket: { entity: ticket, events: [Replied], match: ticketOf } };
  /** Started by hand: its first node waits for a reply, with no deadline. */
  const reply = j
    .workflow('wait.reply', { version: 1, input })
    .waitFor('reply', { on: onReply })
    .finish(({ results }) => ({ text: results.reply.event.data.text, at: results.reply.event.recordedAt.toISOString() }));
  /** Started by the event, after the commit: an event between the two must count. */
  const afterCommit = j
    .workflow('wait.after-commit', {
      version: 1,
      input,
      startOn: {
        entity: ticket,
        event: Opened,
        id: e => `after:${e.entityId}`,
        input: e => ({ ticket: e.entityId }),
        timing: 'after-commit',
      },
    })
    .step('first', () => 1)
    .waitFor('reply', { on: onReply })
    .finish(({ results }) => results.reply.event.data.text);
  /** A loop of three replies: each visit must take the next one. */
  const replies = j
    .workflow('wait.replies', { version: 1, input })
    .step('round', ({ results }: { readonly results: Readonly<Record<string, unknown>> }) => Object.keys(results).length)
    .waitFor('reply', { on: onReply })
    .step('note', ({ results }) => results.reply.event.data.text, { next: 'round' })
    .finish();
  /** Two waits in a row for the same event type: each takes its own. */
  const twoWaits = j
    .workflow('wait.two', { version: 1, input })
    .waitFor('first', { on: onReply })
    .waitFor('second', { on: onReply })
    .finish(({ results }) => [results.first.event.data.text, results.second.event.data.text]);
  /** Fails when nobody replies in time. */
  const timed = j
    .workflow('wait.timed', { version: 1, input })
    .waitFor('reply', { on: onReply, timeout: '1h' })
    .finish();
  /** Goes on when nobody replies in time, so a body sees `null`. */
  const soft = j
    .workflow('wait.soft', { version: 1, input })
    .waitFor('reply', { on: onReply, timeout: '1h', onTimeout: 'continue' })
    .finish(({ results }) => results.reply?.via ?? 'nobody');
  /** Two labels on two entities. */
  const either = j
    .workflow('wait.either', { version: 1, input: input.extend({ user: z.templateLiteral(['usr_', z.string()]) }) })
    .waitFor('first', {
      on: {
        ticket: { entity: ticket, events: [Replied, Closed], match: ({ input }) => input.ticket },
        user: { entity: user, events: [UserLeft], match: ({ input }) => input.user },
      },
    })
    .finish(({ results }) => {
      const { first } = results;
      if (first.via === 'user') return first.event.entityId;
      return first.event.type === 'Replied' ? first.event.data.text : 'closed';
    });
  /** Only a reply that is not from the bot counts. */
  const filtered = j
    .workflow('wait.filtered', { version: 1, input })
    .waitFor('human', {
      on: {
        ticket: {
          entity: ticket,
          events: [Replied],
          match: ({ input }) => input.ticket,
          where: ({ event }) => event.data.text !== 'bot',
        },
      },
    })
    .finish(({ results }) => results.human.event.data.text);
  /** Two labels on one entity kind: the id and the type say which label an event belongs to. */
  const labelled = j
    .workflow('wait.labelled', { version: 1, input: z.object({ a: ticketIdSchema, b: ticketIdSchema }) })
    .waitFor('first', {
      on: {
        left: { entity: ticket, events: [Replied], match: ({ input }) => input.a },
        right: { entity: ticket, events: [Replied], match: ({ input }) => input.b },
      },
    })
    .finish(({ results }) => results.first.via);
  /** Two labels on one entity: the type says which label an event belongs to. */
  const byType = j
    .workflow('wait.by-type', { version: 1, input })
    .waitFor('first', {
      on: {
        replied: { entity: ticket, events: [Replied], match: ({ input }) => input.ticket },
        closed: { entity: ticket, events: [Closed], match: ({ input }) => input.ticket },
      },
    })
    .finish(({ results }) => results.first.via);
  /** An `until` that gives no real time. */
  const badUntil = j
    .workflow('wait.bad-until', { version: 1, input })
    .waitFor('reply', { on: onReply, until: () => new Date('not a date') })
    .finish();
  /** Its second visit accepts what its first refused: the cursor must still hold it back. */
  const widening = j
    .workflow('wait.widening', { version: 1, input })
    .step('round', ({ key }) => (key.endsWith(':do') ? 1 : 2))
    .waitFor('reply', {
      on: {
        ticket: {
          entity: ticket,
          events: [Replied],
          match: ({ input }) => input.ticket,
          where: ({ event, results }) => results.round === 2 || event.data.text === 'second',
        },
      },
    })
    .step('note', ({ results }) => results.reply.event.data.text, { next: 'round' })
    .finish();
  /** Started by the event, in its transaction. */
  const withEvent = j
    .workflow('wait.with-event', {
      version: 1,
      input,
      startOn: {
        entity: ticket,
        event: Escalated,
        id: e => `with:${e.entityId}`,
        input: e => ({ ticket: e.entityId }),
        timing: 'with-event',
      },
    })
    .waitFor('reply', { on: onReply })
    .finish(({ results }) => results.reply.event.data.text);
  /** A deadline for the whole run, and a wait with none of its own. */
  const bounded = j
    .workflow('wait.bounded', { version: 1, input, deadline: '1h' })
    .waitFor('reply', { on: onReply })
    .finish();
  /** A payload limit far too small for any event. */
  const tiny = j
    .workflow('wait.tiny', { version: 1, input, limits: { payload: 200 } })
    .waitFor('reply', { on: onReply })
    .finish();
  /** Skips its wait on request. */
  const skipped = j
    .workflow('wait.skipped', { version: 1, input: input.extend({ wait: z.boolean() }) })
    .waitFor('reply', { on: onReply, when: ({ input }) => input.wait })
    .finish(({ results }) => results.reply?.via ?? 'skipped');
  /** `sleep` with `next`: it goes back round three times, by a function of what it has done. */
  const counted = j
    .workflow('wait.counted', { version: 1, input: z.object({}) })
    .step('count', ({ runId }) => runId.length)
    .sleep('pause', '1h', { next: ({ results }) => (results.count > 0 ? 'count' : 'next') })
    .finish();
  /** `sleep` with a fixed `next`. */
  const looped = j
    .workflow('wait.looped', { version: 1, input: z.object({}) })
    .step('tick', ({ metadata }) => metadata.increment('rounds').then(() => 1))
    .sleep('pause', '1h', { next: 'tick' })
    .finish();

  const journal = j.compose({
    workflows: [
      reply,
      afterCommit,
      replies,
      twoWaits,
      timed,
      soft,
      either,
      filtered,
      labelled,
      byType,
      badUntil,
      widening,
      withEvent,
      bounded,
      tiny,
      skipped,
      counted,
      looped,
    ],
    workflowMeta,
  });
  return {
    tables,
    journal,
    ticket,
    user,
    Opened,
    Replied,
    Closed,
    Escalated,
    UserJoined,
    UserLeft,
    reply,
    afterCommit,
    replies,
    twoWaits,
    timed,
    soft,
    either,
    filtered,
    labelled,
    byType,
    badUntil,
    widening,
    withEvent,
    bounded,
    tiny,
    skipped,
    counted,
    looped,
  };
}

const open = () => workflowHarness({ setup: ticketApp, schema: { ...tables, tickets, users } });
type Harness = Awaited<ReturnType<typeof open>>;
const opened: Harness[] = [];
let next = 0;

/** A harness of its own per test: `tick` moves every run in it, so tests must not share one. */
const harness = async () => {
  const h = await open();
  opened.push(h);
  return h;
};
afterEach(async () => {
  await Promise.all(opened.splice(0).map(h => h.close()));
});

const newTicket = async (h: Harness): Promise<TicketId> => {
  const id: TicketId = `tkt_${++next}`;
  orThrow(await h.journal.write(h.db, h.ticket, id, { meta: caller, events: () => [h.Opened({ title: 'x' })] }));
  return id;
};
const replyTo = async (h: Harness, id: TicketId, text: string) =>
  orThrow(await h.journal.write(h.db, h.ticket, id, { meta: caller, events: () => [h.Replied({ text })] }));
const stateOf = async (h: Harness, runId: string) => {
  const [row] = await h.db
    .select({ state: tables.workflowRuns.state, output: tables.workflowRuns.output })
    .from(tables.workflowRuns)
    .where(eq(tables.workflowRuns.id, runId));
  return row;
};
const waitRows = (h: Harness, runId: string) =>
  h.db.select().from(tables.workflowWaits).where(eq(tables.workflowWaits.runId, runId));
const started = async (h: Harness, id: TicketId, runId: string) =>
  orThrow(await h.journal.run(h.db, h.reply.start, { id: runId, input: { ticket: id } }, caller));

describe('what a wait takes', () => {
  it('parks on a row of its key, and a reply on that key ends it with the typed event', async () => {
    const h = await harness();
    const id = await newTicket(h);
    await started(h, id, 'run_1');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_1')).toMatchObject({ state: 'parked' });
    expect(await waitRows(h, 'run_1')).toEqual([
      expect.objectContaining({ node: 'reply', label: 'ticket', entityKind: 'wait-ticket', entityId: id, types: ['Replied'] }),
    ]);

    await replyTo(h, id, 'hello');
    orThrow(await h.drain());
    const run = await stateOf(h, 'run_1');
    expect(run).toMatchObject({ state: 'completed', output: { text: 'hello' } });
    // `recordedAt` comes back a Date, or this ISO call would have thrown in `finish`.
    expect(z.object({ at: z.iso.datetime() }).safeParse(run?.output).success).toBe(true);
    expect(await waitRows(h, 'run_1')).toEqual([]);
  });

  it('def.read gives the result typed and checked, with the event as a job would see it', async () => {
    const h = await harness();
    const id = await newTicket(h);
    await started(h, id, 'run_read');
    await replyTo(h, id, 'typed');
    orThrow(await h.drain());
    const read = await h.reply.read(h.db, 'run_read');
    if (read === undefined || isFailure(read)) throw new Error('the read failed');
    expect(read.run.results.reply).toMatchObject({ via: 'ticket', event: { type: 'Replied', data: { text: 'typed' } } });
    expect(read.run.results.reply?.event.recordedAt).toBeInstanceOf(Date);
    expect(read.run.results.reply?.event.entityId).toBe(id);
  });

  it('def.read refuses a stored result its schemas do not accept, never casts it', async () => {
    const h = await harness();
    const id = await newTicket(h);
    await started(h, id, 'run_bad');
    await replyTo(h, id, 'fine');
    orThrow(await h.drain());
    // The run stores a pointer: the event it points at is the stored value `def.read` checks.
    const [row] = await h.db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, 'run_bad'));
    const { seq } = z.object({ reply: z.object({ via: z.string(), seq: z.int() }) }).parse(row?.results).reply;
    await h.db.update(tables.events).set({ data: { text: 7 } }).where(eq(tables.events.seq, seq));
    const read = await h.reply.read(h.db, 'run_bad');
    expect(WorkflowReadMismatch.is(read)).toBe(true);
  });

  it('two labels on two entities: a run wakes on either, and `via` says which', async () => {
    const h = await harness();
    const id = await newTicket(h);
    const user: UserId = `usr_${++next}`;
    orThrow(await h.journal.write(h.db, h.user, user, { meta: caller, events: () => [h.UserJoined({})] }));
    orThrow(await h.journal.run(h.db, h.either.start, { id: 'run_either', input: { ticket: id, user } }, caller));
    orThrow(await h.drain());
    expect(await waitRows(h, 'run_either')).toHaveLength(2);
    orThrow(await h.journal.write(h.db, h.user, user, { meta: caller, events: () => [h.UserLeft({})] }));
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_either')).toMatchObject({ state: 'completed', output: user });
  });

  it('two labels on one entity kind: the id says which label an event belongs to', async () => {
    const h = await harness();
    const a = await newTicket(h);
    const b = await newTicket(h);
    orThrow(await h.journal.run(h.db, h.labelled.start, { id: 'run_labels', input: { a, b } }, caller));
    orThrow(await h.drain());
    await replyTo(h, b, 'on the right');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_labels')).toMatchObject({ state: 'completed', output: 'right' });
  });

  it('two labels on one entity: the type says which label an event belongs to', async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(await h.journal.run(h.db, h.byType.start, { id: 'run_types', input: { ticket: id } }, caller));
    orThrow(await h.drain());
    orThrow(await h.journal.write(h.db, h.ticket, id, { meta: caller, events: () => [h.Closed({})] }));
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_types')).toMatchObject({ state: 'completed', output: 'closed' });
  });

  it('an event too big for the run fails the run, and leaves no half-taken wait', async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(await h.journal.run(h.db, h.tiny.start, { id: 'run_tiny', input: { ticket: id } }, caller));
    orThrow(await h.drain());
    await replyTo(h, id, 'much longer than sixteen bytes');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_tiny')).toMatchObject({ state: 'failed' });
    expect(await waitRows(h, 'run_tiny')).toEqual([]);
  });

  it('`where` passes over the events it refuses, and the first it accepts wakes the run', async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(await h.journal.run(h.db, h.filtered.start, { id: 'run_where', input: { ticket: id } }, caller));
    orThrow(await h.drain());
    await replyTo(h, id, 'bot');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_where')).toMatchObject({ state: 'parked' });
    await replyTo(h, id, 'person');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_where')).toMatchObject({ state: 'completed', output: 'person' });
  });

  it('`where` looks past a whole batch of refused events in the log', async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(await h.journal.run(h.db, h.filtered.start, { id: 'run_batch', input: { ticket: id } }, caller));
    for (let reply = 0; reply < 105; reply++) await replyTo(h, id, 'bot');
    await replyTo(h, id, 'person');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_batch')).toMatchObject({ state: 'completed', output: 'person' });
  });

  it('`when` skips the wait: the run does not park and the result is null', async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(
      await h.journal.run(h.db, h.skipped.start, { id: 'run_skip', input: { ticket: id, wait: false } }, caller),
    );
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_skip')).toMatchObject({ state: 'completed', output: 'skipped' });
    expect(await waitRows(h, 'run_skip')).toEqual([]);
  });
});

describe('when an event counts', () => {
  it('a direct start counts from its admission: a reply before the start is not taken, one after it is', async () => {
    const h = await harness();
    const id = await newTicket(h);
    await replyTo(h, id, 'too early');
    await started(h, id, 'run_admit');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_admit')).toMatchObject({ state: 'parked' });
    await replyTo(h, id, 'in time');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_admit')).toMatchObject({ state: 'completed', output: { text: 'in time' } });
  });

  it('a start after the commit counts from the event that started it, not from RunStarted', async () => {
    const h = await harness();
    const id = await newTicket(h);
    // The reply commits after the trigger and before the start job runs, so it is older than `RunStarted`.
    await replyTo(h, id, 'between');
    orThrow(await h.drain());
    expect(await stateOf(h, `after:${id}`)).toMatchObject({ state: 'completed', output: 'between' });
  });

  it('a start with the event counts every event after it, even one in the same write', async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(
      await h.journal.write(h.db, h.ticket, id, {
        meta: caller,
        events: () => [h.Escalated({}), h.Replied({ text: 'same breath' })],
      }),
    );
    orThrow(await h.drain());
    expect(await stateOf(h, `with:${id}`)).toMatchObject({ state: 'completed', output: 'same breath' });
  });

  it('a revisit never goes back past the last event it took, even for one it would accept now', async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(await h.journal.run(h.db, h.widening.start, { id: 'run_wide', input: { ticket: id } }, caller));
    await replyTo(h, id, 'first');
    await replyTo(h, id, 'second');
    orThrow(await h.drain());
    // The first visit refused 'first' and took 'second'. The second visit would accept 'first', but it is behind the cursor.
    expect(await stateOf(h, 'run_wide')).toMatchObject({ state: 'parked' });
    const taken = await h.db
      .select({ id: tables.events.id })
      .from(tables.events)
      .where(and(eq(tables.events.entityId, 'run_wide'), eq(tables.events.type, 'WaitEventTaken')));
    expect(taken).toHaveLength(1);
    await replyTo(h, id, 'third');
    orThrow(await h.drain());
    const [row] = await h.db.select().from(tables.workflowRuns).where(eq(tables.workflowRuns.id, 'run_wide'));
    expect(row?.results).toMatchObject({ note: 'third' });
  });

  it('a revisit in a loop takes only what came after the last event it took', async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(await h.journal.run(h.db, h.replies.start, { id: 'run_loop', input: { ticket: id } }, caller));
    await replyTo(h, id, 'one');
    await replyTo(h, id, 'two');
    orThrow(await h.drain());
    // Both replies were waiting: one visit took each, oldest first, and the third visit found nothing.
    const taken = await h.db
      .select({ data: tables.events.data })
      .from(tables.events)
      .where(and(eq(tables.events.entityId, 'run_loop'), eq(tables.events.type, 'WaitEventTaken')))
      .orderBy(asc(tables.events.seq));
    expect(taken).toHaveLength(2);
    expect(await stateOf(h, 'run_loop')).toMatchObject({ state: 'parked' });
    const [first, second] = taken.map(row => z.object({ seq: z.int() }).parse(row.data).seq);
    expect(first).toBeLessThan(second ?? 0);
    await replyTo(h, id, 'three');
    orThrow(await h.drain());
    expect(await waitRows(h, 'run_loop')).toHaveLength(1);
    expect(await stateOf(h, 'run_loop')).toMatchObject({ state: 'parked' });
  });

  it('one event is taken once per run: a second wait for the same type needs a second event', async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(await h.journal.run(h.db, h.twoWaits.start, { id: 'run_two', input: { ticket: id } }, caller));
    await replyTo(h, id, 'one');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_two')).toMatchObject({ state: 'parked' });
    await replyTo(h, id, 'two');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_two')).toMatchObject({ state: 'completed', output: ['one', 'two'] });
  });
});

describe('how a wait ends without an event', () => {
  it("`onTimeout: 'fail'` fails the run when the time runs out", async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(await h.journal.run(h.db, h.timed.start, { id: 'run_late', input: { ticket: id } }, caller));
    orThrow(await h.drain());
    await h.tick('1h');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_late')).toMatchObject({ state: 'failed' });
    expect(await waitRows(h, 'run_late')).toEqual([]);
  });

  it("`onTimeout: 'continue'` gives null, and the run goes on", async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(await h.journal.run(h.db, h.soft.start, { id: 'run_soft', input: { ticket: id } }, caller));
    orThrow(await h.drain());
    await h.tick('1h');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_soft')).toMatchObject({ state: 'completed', output: 'nobody' });
    const read = await h.soft.read(h.db, 'run_soft');
    if (read === undefined || isFailure(read)) throw new Error('the read failed');
    expect(read.run.results.reply).toBeNull();
  });

  it('an event that committed before the timer ran beats the timer, even with its wake job still queued', async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(await h.journal.run(h.db, h.soft.start, { id: 'run_first', input: { ticket: id } }, caller));
    orThrow(await h.drain());
    await h.tick('1h');
    await replyTo(h, id, 'just in time');
    orThrow(await h.release(job => job.effect === 'workflow.timer'));
    expect(await stateOf(h, 'run_first')).toMatchObject({ state: 'completed', output: 'ticket' });
  });

  it('an `until` that gives no real time fails the node, and never parks on nothing', async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(
      await h.journal.run(h.db, h.badUntil.start, { id: 'run_nan', input: { ticket: id }, maxAttempts: 1 }, caller),
    );
    orThrow(await h.drain());
    const [step] = await h.db.select().from(tables.workflowSteps).where(eq(tables.workflowSteps.runId, 'run_nan'));
    expect(step).toMatchObject({ status: 'failed' });
    expect(await waitRows(h, 'run_nan')).toEqual([]);
  });

  it('a run past its deadline does not take an event: the deadline wins even before its own timer runs', async () => {
    const h = await harness();
    const id = await newTicket(h);
    orThrow(await h.journal.run(h.db, h.bounded.start, { id: 'run_over', input: { ticket: id } }, caller));
    orThrow(await h.drain());
    await h.tick('2h');
    await replyTo(h, id, 'too late');
    orThrow(await h.release(job => job.effect === 'workflow.wake:wait-ticket' && job.type === 'Replied'));
    expect(await stateOf(h, 'run_over')).toMatchObject({ state: 'failed' });
    expect(await waitRows(h, 'run_over')).toEqual([]);
  });

  it('a cancel leaves no wait behind', async () => {
    const h = await harness();
    const id = await newTicket(h);
    await started(h, id, 'run_cancel');
    orThrow(await h.drain());
    orThrow(await h.journal.run(h.db, h.reply.cancel, { runId: 'run_cancel', reason: 'done with it' }, caller));
    expect(await waitRows(h, 'run_cancel')).toEqual([]);
    await replyTo(h, id, 'too late');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_cancel')).toMatchObject({ state: 'cancelled' });
  });
});

describe('the wake effect', () => {
  /** Two workflows on one ticket, and a process that may have lost the code of one. */
  const strandedApp = () => {
    const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
    const Opened = j.event('Opened', z.object({}));
    const Replied = j.event('Replied', z.object({ text: z.string().min(1) }));
    const ticket = j
      .entity('wait-ticket', tickets, { events: 'stored' })
      .create(Opened, () => ({}))
      .on(Replied, () => ({}));
    const input = z.object({ ticket: ticketIdSchema });
    const ticketOf = (view: { readonly input: { readonly ticket: TicketId } }) => view.input.ticket;
    const on = { ticket: { entity: ticket, events: [Replied], match: ticketOf } };
    const gone = j.workflow('wait.gone', { version: 1, input }).waitFor('reply', { on }).finish();
    const kept = j.workflow('wait.kept', { version: 1, input }).waitFor('reply', { on }).finish();
    const journal = j.compose({ workflows: codeIsGone.value ? [kept] : [gone, kept], workflowMeta });
    return { tables, journal, ticket, Opened, Replied, gone, kept };
  };
  const codeIsGone = { value: false };

  it('a stranded run fails the job for an operator, and the other runs on the key still wake', async () => {
    codeIsGone.value = false;
    const h = await workflowHarness({ setup: strandedApp, schema: { ...tables, tickets, users } });
    const id: TicketId = `tkt_${++next}`;
    orThrow(await h.journal.write(h.db, h.ticket, id, { meta: caller, events: () => [h.Opened({})] }));
    orThrow(await h.journal.run(h.db, h.gone.start, { id: 'run_gone', input: { ticket: id } }, caller));
    orThrow(await h.journal.run(h.db, h.kept.start, { id: 'run_kept', input: { ticket: id } }, caller));
    orThrow(await h.drain());

    codeIsGone.value = true;
    h.crash();
    orThrow(await h.journal.write(h.db, h.ticket, id, { meta: caller, events: () => [h.Replied({ text: 'hi' })] }));
    orThrow(await h.drain());
    const states = async () => {
      const rows = await h.db
        .select({ id: tables.workflowRuns.id, state: tables.workflowRuns.state })
        .from(tables.workflowRuns)
        .orderBy(asc(tables.workflowRuns.id));
      return rows.map(row => `${row.id}:${row.state}`);
    };
    expect(await states()).toEqual(['run_gone:parked', 'run_kept:completed']);
    const [job] = await h.db.select().from(tables.jobs).where(eq(tables.jobs.effect, 'workflow.wake:wait-ticket'));
    expect(job?.deadAt).toBeInstanceOf(Date);

    // The code is back and an operator retries the job: the event is still in the log, so the wake finds it.
    codeIsGone.value = false;
    h.crash();
    orThrow(await h.journal.retry(h.db, job?.id ?? '', { actor: 'usr_operator', reason: 'code is back' }));
    orThrow(await h.drain());
    expect(await states()).toEqual(['run_gone:completed', 'run_kept:completed']);
    await h.close();
  });
});

describe('the sweep', () => {
  it('keeps what a parked wait needs: its rows, its run and the events it may still read', async () => {
    const h = await harness();
    const id = await newTicket(h);
    await started(h, id, 'run_swept');
    orThrow(await h.drain());
    await replyTo(h, id, 'kept');
    await h.tick('400d');
    const sweeper = createJobOps({ tables, retention: resolveRetention({}), wake: noWake });
    await sweeper.sweepOnce(h.db);
    expect(await waitRows(h, 'run_swept')).toHaveLength(1);
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_swept')).toMatchObject({ state: 'completed', output: { text: 'kept' } });
  });
});

describe('sleep with next', () => {
  it('a function can loop a sleep back, with the results so far', async () => {
    const h = await harness();
    orThrow(await h.journal.run(h.db, h.counted.start, { id: 'run_sleep', input: {} }, caller));
    orThrow(await h.drain());
    await h.tick('1h');
    orThrow(await h.drain());
    await h.tick('1h');
    orThrow(await h.drain());
    expect(await stateOf(h, 'run_sleep')).toMatchObject({ state: 'parked' });
    const steps = await h.db
      .select({ path: tables.workflowSteps.path, key: tables.workflowSteps.key })
      .from(tables.workflowSteps)
      .where(eq(tables.workflowSteps.runId, 'run_sleep'));
    // Three visits of `count`: the key of the third names it, so a provider dedupes each visit apart.
    expect(steps).toContainEqual({ path: 'count', key: 'run_sleep:count:do:3' });
  });

  it('a name loops a sleep back too', async () => {
    const h = await harness();
    orThrow(await h.journal.run(h.db, h.looped.start, { id: 'run_named', input: {} }, caller));
    orThrow(await h.drain());
    await h.tick('1h');
    orThrow(await h.drain());
    const [row] = await h.db
      .select({ metadata: tables.workflowRuns.metadata, state: tables.workflowRuns.state })
      .from(tables.workflowRuns)
      .where(eq(tables.workflowRuns.id, 'run_named'));
    expect(row).toMatchObject({ state: 'parked', metadata: { rounds: 2 } });
  });

  it('a `next` that is not an earlier node is a bad definition', () => {
    const input = z.object({});
    expect(() =>
      workflow('bad-next', { version: 1, input })
        .step('a', () => 1)
        // @ts-expect-error 'later' is no earlier node
        .sleep('z', '1h', { next: 'later' })
        .finish(),
    ).toThrow(/sleep 'z' has next: 'later'/);
  });

  it('a function that names no earlier node fails the run, not the worker', async () => {
    const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
    const stray = j
      .workflow('wait.stray', { version: 1, input: z.object({}) })
      .step('a', () => 1)
      // @ts-expect-error the function must return an earlier node or 'next'
      .sleep('z', '1h', { next: () => 'nowhere' })
      .finish();
    const h = await workflowHarness({
      setup: () => ({ tables, journal: j.compose({ workflows: [stray], workflowMeta }) }),
    });
    orThrow(await h.journal.run(h.db, stray.start, { id: 'run_stray', input: {} }, caller));
    orThrow(await h.drain());
    await h.tick('1h');
    orThrow(await h.drain());
    const [row] = await h.db.select({ state: tables.workflowRuns.state }).from(tables.workflowRuns);
    expect(row?.state).toBe('failed');
    await h.close();
  });
});

describe('the definition', () => {
  const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
  const Seen = j.event('Seen', z.object({}));
  const Other = j.event('Other', z.object({}));
  const Stranger = j.event('Stranger', z.object({}));
  const thing = j
    .entity('wait-thing', tickets, { events: 'stored' })
    .create(Seen, () => ({}))
    .on(Other, () => ({}));
  const fleeting = j.entity('wait-fleeting', users, { events: 'transient' }).create(Seen, () => ({}));
  const input = z.object({ id: ticketIdSchema });
  const id = (view: { readonly input: { readonly id: TicketId } }) => view.input.id;
  const on = { a: { entity: thing, events: [Seen], match: id } };
  const hashed = () => workflow('hashed', { version: 1, input }).waitFor('w', { on }).finish();

  it('pins the shape of an event wait: changing `on` means a new version', () => {
    const changed = workflow('hashed', { version: 1, input })
      .waitFor('w', { on: { a: { entity: thing, events: [Other], match: id } } })
      .finish();
    const relabelled = workflow('hashed', { version: 1, input })
      .waitFor('w', { on: { b: { entity: thing, events: [Seen], match: id } } })
      .finish();
    expect(hashed().shapeHash).toBe(hashed().shapeHash);
    expect(changed.shapeHash).not.toBe(hashed().shapeHash);
    expect(relabelled.shapeHash).not.toBe(hashed().shapeHash);
    expect(hashed().shape.nodes[0]).toEqual({
      name: 'w',
      kind: 'eventWait',
      undo: false,
      on: [{ label: 'a', entity: 'wait-thing', events: ['Seen'] }],
    });
    // Worked out when event waits were built. If this moves, running workflows with event waits strand.
    expect(hashed().shapeHash).toBe('8fd314db0e58517e');
  });

  it('refuses an event its entity does not record, for a caller who skips the types', () => {
    expect(() =>
      workflow('foreign', { version: 1, input })
        // @ts-expect-error `Stranger` is not an event of `thing`
        .waitFor('w', { on: { a: { entity: thing, events: [Stranger], match: id } } }),
    ).toThrow(/does not record event "Stranger"/);
  });

  it('refuses a wait on an entity that keeps no events: there would be no log to read', () => {
    expect(() =>
      workflow('fleeting', { version: 1, input: z.object({ id: z.templateLiteral(['usr_', z.string()]) }) }).waitFor('w', {
        on: { a: { entity: fleeting, events: [Seen], match: ({ input }) => input.id } },
      }),
    ).toThrow(/does not keep its events in journal_events/);
  });

  it('refuses a label with no events, no label at all, and both timeout and until', () => {
    const empty = workflow('empty', { version: 1, input });
    const source = { entity: thing, events: [Seen], match: id };
    expect(() => empty.waitFor('w', { on: { '': source } })).toThrow(/labels of 1 to 128/);
    expect(() => empty.waitFor('w', { on: { ['x'.repeat(129)]: source } })).toThrow(/labels of 1 to 128/);
    expect(() => empty.waitFor('w', { on: { a: { entity: thing, events: [], match: id } } })).toThrow(/lists no events/);
    expect(() => empty.waitFor('w', { on: {} })).toThrow(/at least one label/);
    expect(() =>
      // @ts-expect-error `timeout` and `until` cannot go together
      empty.waitFor('w', { on, timeout: '1h', until: () => new Date() }),
    ).toThrow(/takes timeout or until/);
  });

  it('an event wait has no undo', () => {
    expect(() =>
      // @ts-expect-error a wait does nothing, so it has nothing to undo
      workflow('undo', { version: 1, input }).waitFor('w', { on, undo: () => 1 }),
    ).toThrow(JournalError);
  });
});
