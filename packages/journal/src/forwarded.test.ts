/**
 * An entity whose events live in an event log that cannot join the row's transaction. The row, its
 * projections, effects and one `forward` job commit together; the worker appends the events to the
 * log afterwards, one stream per entity, in version order. The log here is the built-in log on a
 * second PGlite database, so it is a real Postgres that shares no transaction with the app.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import type { EventLog, ForwardedLog } from './event-log.js';
import { ContractSkip, eventLogContract } from './event-log-contract.js';
import { initJournal } from './journal.js';
import { createBuiltInEventLog } from './store.js';
import { OrderCancelled, OrderNoted, OrderPaid, OrderPlaced, orders, tables } from './test-support.js';
import { openJournalDb } from './testing.js';

let db: PgliteDatabase;
let client: PGlite;
let storeDb: PgliteDatabase;
let storeClient: PGlite;
let next = 0;
const meta = { actorId: 'user:1' };
const alice = { actor: 'alice', reason: 'test' };

/** The built-in log, but on the other database and used as a log that cannot join the app's transaction. */
const builtIn = createBuiltInEventLog({ tables });
const onStore = () => builtIn.bind(storeDb);
const remoteLog: ForwardedLog = {
  canJoinTransaction: false,
  stream: (kind, entityId, filter) => onStore().stream(kind, entityId, filter),
  highestVersion: (kind, entityId) => onStore().highestVersion(kind, entityId),
  append: batch => onStore().append(batch),
  erase: (at, patch) => onStore().erase(at, patch),
};
/** The same log with a global order, so an async projection can follow it. */
const orderedLog: ForwardedLog = {
  ...remoteLog,
  all: {
    after: (position, filter) => onStore().all.after(position, filter),
    top: () => onStore().all.top(),
    distance: (from, to) => onStore().all.distance(from, to),
  },
};

const jf = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
const remote = jf
  .entity('remote-order', orders, { events: remoteLog })
  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))
  .on(OrderPaid, () => ({ status: 'paid' }))
  .on(OrderNoted, (_row, e) => ({ note: e.data.note }))
  .on(OrderCancelled, () => null);
const ordered = jf
  .entity('ordered-order', orders, { events: orderedLog })
  .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }));

const placedByProjection: string[] = [];
const placedCounts = jf.projection(
  'placed-remote',
  ordered,
  {
    OrderPlaced: (_tx, e) => {
      placedByProjection.push(e.entityId);
    },
  },
  { lane: 'async' },
);
const journal = jf.compose({ projections: [placedCounts] });
/** A handler for a declaration `compose` must refuse: it never runs. */
const ignore = (): void => {
  throw new Error('never runs: compose refuses this handler');
};

const newId = () => `ord_fwd_${++next}` as const;
const place = (id: ReturnType<typeof newId>) =>
  db.transaction(tx =>
    journal.write(tx, remote, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
  );
const pay = (id: ReturnType<typeof newId>) =>
  db.transaction(tx => journal.write(tx, remote, id, { meta, events: () => [OrderPaid({ amount: 1 })] }));
const forwardJobs = (id: string) =>
  db
    .select()
    .from(tables.jobs)
    .where(and(eq(tables.jobs.kind, 'forward'), eq(tables.jobs.stream, `remote-order/${id}`)))
    .orderBy(asc(tables.jobs.streamPosition));
const storeEvents = (kind: string, id: string) => onStore().stream(kind, id);
const appEvents = (id: string) => db.select().from(tables.events).where(eq(tables.events.entityId, id));

beforeAll(async () => {
  ({ db, client } = await openJournalDb({ ...tables, orders }));
  ({ db: storeDb, client: storeClient } = await openJournalDb({ ...tables }));
});
afterAll(async () => {
  await client.close();
  await storeClient.close();
});

describe('a forwarded write', () => {
  it('commits the row and one forward job, and the worker appends the events to the log afterwards', async () => {
    // Why: the row is the truth and the log follows. Nothing reaches the log inside the write, and
    // nothing lands in the app's own journal_events, but after a drain the log holds exactly the
    // events the write recorded: same ids, versions and seqs.
    const id = newId();
    const written = orThrow(await place(id));
    const [job] = await forwardJobs(id);
    expect(job).toMatchObject({ kind: 'forward', jobName: 'remote-order', streamPosition: 0 });
    expect(await storeEvents('remote-order', id)).toEqual([]);
    expect(await appEvents(id)).toEqual([]);

    orThrow(await journal.drain(db));
    const landed = await storeEvents('remote-order', id);
    expect(landed.map(e => [e.id, e.version, e.seq])).toEqual(written.events.map(e => [e.id, e.version, e.seq]));
    expect(await forwardJobs(id)).toEqual([]);
  });

  it('a create after a delete continues the version count, from the pending jobs or from the log', async () => {
    // Why: the log keeps the deleted entity's history. A create that started again at version 1
    // would collide with it and the stream would diverge.
    const id = newId();
    orThrow(await place(id));
    orThrow(
      await db.transaction(tx =>
        journal.write(tx, remote, id, { meta, events: () => [OrderCancelled({ reason: 'gone' })] }),
      ),
    );
    // Still pending: the jobs say the history ends at version 2.
    const again = orThrow(await place(id));
    expect(again.events.map(e => e.version)).toEqual([3]);
    orThrow(await journal.drain(db));
    orThrow(
      await db.transaction(tx =>
        journal.write(tx, remote, id, { meta, events: () => [OrderCancelled({ reason: 'gone again' })] }),
      ),
    );
    orThrow(await journal.drain(db));
    // Nothing pending now: the log says the history ends at version 4.
    const third = orThrow(await place(id));
    expect(third.events.map(e => e.version)).toEqual([5]);
    orThrow(await journal.drain(db));
    const versions = await storeEvents('remote-order', id);
    expect(versions.map(e => e.version)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('the stream order', () => {
  it("runs one entity's forward jobs in version order: a dead head holds the jobs after it", async () => {
    // Why: a log appended out of order would hold a history with a hole. The claim takes only the
    // head of a stream, so a later job waits while an earlier one is waiting, running or dead.
    const id = newId();
    orThrow(await place(id));
    orThrow(await pay(id));
    // Something else wrote version 1 to the log: the head diverges and dies at once.
    await onStore().append({
      kind: 'remote-order',
      entityId: id,
      expectedVersion: 0,
      events: [
        {
          seq: 900_000 + next,
          id: `evt_foreign_${next}`,
          kind: 'remote-order',
          entityId: id,
          version: 1,
          type: 'OrderPlaced',
          data: { customerId: 'x', total: 9 },
          meta: {},
          recordedAt: new Date(),
          commandId: null,
          causeSeq: null,
          correlationId: null,
          schemaVersion: 1,
        },
      ],
    });
    orThrow(await journal.drain(db));
    const [head, later] = await forwardJobs(id);
    expect(head?.deadAt).not.toBeNull();
    expect(head?.attempts).toBe(1);
    expect(head?.lastError).toContain('FORWARD_DIVERGED');
    expect(later).toMatchObject({ attempts: 0, deadAt: null });

    // The purge keeps a dead head that later jobs wait behind.
    await db
      .update(tables.jobs)
      .set({ deadAt: sql`now() - interval '60 days'` })
      .where(eq(tables.jobs.id, head?.id ?? ''));
    const purged = orThrow(await journal.purgeDead(db, { olderThan: new Date(Date.now() - 31 * 86_400_000) }, alice));
    expect(purged).toMatchObject({ archived: 0, deleted: 0 });

    // The log holds version 1, so the operator may discard the head; the next job then runs.
    orThrow(await journal.discard(db, head?.id ?? '', alice));
    orThrow(await journal.drain(db));
    const landed = await storeEvents('remote-order', id);
    expect(landed.map(e => e.id)).toEqual([`evt_foreign_${next}`, expect.stringMatching(/^evt_/)]);
    expect(await forwardJobs(id)).toEqual([]);
  });

  it('waits, never dies, while the log is below the version a job follows', async () => {
    // Why: a missing earlier batch may still land (a replay, a slow worker). Dying would block the
    // stream for good; waiting costs one more try later.
    const id = newId();
    orThrow(await place(id));
    orThrow(await pay(id));
    const [head] = await forwardJobs(id);
    // The head is lost from the table, so the second job is the head now and its log is behind. It has
    // used many tries already: a plain retry policy would let it die now.
    await db.delete(tables.jobs).where(eq(tables.jobs.id, head?.id ?? ''));
    await db
      .update(tables.jobs)
      .set({ attempts: 50 })
      .where(eq(tables.jobs.stream, `remote-order/${id}`));
    orThrow(await journal.drain(db));
    const [waiting] = await forwardJobs(id);
    expect(waiting).toMatchObject({ deadAt: null, streamPosition: 1 });
    expect(waiting?.lastError).toContain('an earlier batch has not landed');
    expect(waiting?.availableAt.getTime()).toBeGreaterThan(Date.now());
    // It would wait for ever: the batch before it is gone. Take it out so the lag below is this file's own.
    await db.delete(tables.jobs).where(eq(tables.jobs.id, waiting?.id ?? ''));
  });
});

describe('the job verbs on forward jobs', () => {
  it('refuse to cancel a forward job, or discard one whose events the log does not hold', async () => {
    // Why: both would drop events the log never got, and the stream would wait on the gap for good.
    const id = newId();
    orThrow(await place(id));
    const [job] = await forwardJobs(id);
    await expect(journal.cancel(db, job?.id ?? '', alice)).rejects.toMatchObject({ code: 'FORWARD_PENDING' });
    await db
      .update(tables.jobs)
      .set({ deadAt: sql`now()` })
      .where(eq(tables.jobs.id, job?.id ?? ''));
    await expect(journal.discard(db, job?.id ?? '', alice)).rejects.toMatchObject({ code: 'FORWARD_PENDING' });
    orThrow(await journal.retry(db, job?.id ?? '', alice));
    orThrow(await journal.drain(db));
    expect(await forwardJobs(id)).toEqual([]);
  });

  it('forwardLag counts the forward jobs still waiting and reports zero once the logs are current', async () => {
    orThrow(await journal.drain(db));
    const id = newId();
    orThrow(await place(id));
    const lag = await journal.forwardLag(db);
    expect(lag.pending).toBeGreaterThan(0);
    expect(lag.oldestEnqueuedAt).toBeInstanceOf(Date);
    orThrow(await journal.drain(db));
    expect(await journal.forwardLag(db)).toEqual({ pending: 0, dead: 0, oldestEnqueuedAt: null });
  });
});

describe('history on a forwarded entity', () => {
  it('is refused with FORWARD_PENDING while a forward job waits, and reads the log once it is current', async () => {
    // Why: the log is behind the row until the job runs; a replay then would rebuild an old row.
    const id = newId();
    orThrow(await place(id));
    orThrow(await pay(id));
    await expect(journal.replay(db, remote, id)).rejects.toMatchObject({ code: 'FORWARD_PENDING' });
    await expect(journal.repair(db, remote, id)).rejects.toMatchObject({ code: 'FORWARD_PENDING' });
    orThrow(await journal.drain(db));
    expect(orThrow(await journal.replay(db, remote, id)).row).toMatchObject({ status: 'paid', version: 2 });
    expect(await journal.verify(db, remote, id)).toEqual({ ok: true });
  });

  it('forget erases in the log and in the archived forward job, and is refused while one waits', async () => {
    // Why: personal data must leave every copy the journal keeps: the log, and the archived job
    // that carried the event there.
    const id = newId();
    orThrow(await place(id));
    orThrow(
      await db.transaction(tx =>
        journal.write(tx, remote, id, { meta, events: () => [OrderNoted({ note: 'secret' })] }),
      ),
    );
    await expect(journal.forget(db, remote, id)).rejects.toMatchObject({ code: 'FORWARD_PENDING' });
    orThrow(await journal.drain(db));
    const forgotten = orThrow(await journal.forget(db, remote, id));
    expect(forgotten.erased).toBe(1);
    const stored = await storeEvents('remote-order', id);
    const noted = stored.find(e => e.type === 'OrderNoted');
    expect(noted?.data).toEqual({ note: '[erased]' });
    const archived = await db
      .select({ args: tables.jobArchive.args })
      .from(tables.jobArchive)
      .where(and(eq(tables.jobArchive.kind, 'forward'), eq(tables.jobArchive.stream, `remote-order/${id}`)));
    expect(JSON.stringify(archived)).not.toContain('secret');
    expect(JSON.stringify(archived)).toContain('[erased]');
  });
});

describe('handlers that read a forwarded log back', () => {
  it('an async projection follows a forwarded log that has a global order', async () => {
    const id = `ord_fwd_proj_${++next}` as const;
    orThrow(
      await db.transaction(tx =>
        journal.write(tx, ordered, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
      ),
    );
    orThrow(await journal.drain(db));
    await journal.catchUp(db);
    expect(placedByProjection).toContain(id);
    const [cursor] = await journal.cursors(db);
    expect(cursor?.behind).toBe(false);
  });

  it('compose refuses a tap on a forwarded entity, and an async projection on a log with no global order', () => {
    // Why: a tap reads journal_events by the seq range of the wake signal, which a forwarded log
    // never fills; an async projection walks a global order the log does not have.
    const tap = jf.tap('remote-tap', remote, { OrderPlaced: ignore });
    expect(() => jf.compose({ taps: [tap] })).toThrow(expect.objectContaining({ code: 'BAD_DEFINITION' }));
    const unordered = jf.projection('remote-async', remote, { OrderPlaced: ignore }, { lane: 'async' });
    expect(() => jf.compose({ projections: [unordered] })).toThrow(expect.objectContaining({ code: 'BAD_DEFINITION' }));
  });

  it('refuses one entity kind with two different forwarded logs', () => {
    expect(() => jf.entity('remote-order', orders, { events: orderedLog })).toThrow(
      expect.objectContaining({ code: 'BAD_DEFINITION' }),
    );
  });
});

describe('the forwarded test log keeps the event log contract', () => {
  const logs: Record<string, EventLog> = { 'without a global order': remoteLog, 'with a global order': orderedLog };
  for (const [name, log] of Object.entries(logs)) {
    describe(name, () => {
      for (const contractCase of eventLogContract(async () => {
        await storeDb.execute(sql`truncate ${tables.events} restart identity cascade`);
        return { log };
      })) {
        it(contractCase.name, async context => {
          try {
            await contractCase.run();
          } catch (error) {
            if (error instanceof ContractSkip) context.skip(error.message);
            throw error;
          }
        });
      }
    });
  }
});
