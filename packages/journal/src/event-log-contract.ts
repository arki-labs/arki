/**
 * The event log conformance suite. `eventLogContract` returns plain `{ name, run }` cases that any
 * runner (or none) can execute: it never imports a test framework. A case that does not apply to
 * the log under test (no global order, no erase, no transactions) throws {@link ContractSkip}
 * with the reason; the runner reports it as skipped.
 * Imports only `event-log`, `errors`, `storage` and leaf files.
 */
import type { EventLog, EventLogReads, EventLogWrites, EventToAppend, StoredEvent } from './event-log.js';
import type { DbHandle } from './types.js';
import { isJournalError } from './errors.js';
import { logOn } from './event-log.js';
import { sameValue } from './storage.js';

/** Thrown by a case that does not apply to this log. `message` is the reason. */
export class ContractSkip extends Error {
  override readonly name = 'ContractSkip';
}

export type ContractCase = {
  readonly name: string;
  run(): Promise<void>;
};

/**
 * A fresh, empty log for one case. `db` is the app database the log joins; a log that joins
 * transactions needs it, and the transaction cases open theirs on it.
 */
export type MakeLog = () => Promise<{ readonly log: EventLog; readonly db?: DbHandle }>;

class ContractFailure extends Error {
  override readonly name = 'ContractFailure';
}

const check = (ok: boolean, what: string): void => {
  if (!ok) throw new ContractFailure(what);
};

/** Events for one entity, each with a seq from `nextSeq`, as the app database would stamp them. */
const eventsFor = (
  nextSeq: () => number,
  kind: string,
  entityId: string,
  fromVersion: number,
  types: readonly string[],
): EventToAppend[] =>
  types.map((type, index) => {
    const seq = nextSeq();
    return {
      seq,
      id: `evt_contract_${seq}`,
      kind,
      entityId,
      version: fromVersion + index,
      type,
      data: { n: seq },
      meta: { actorId: 'contract' },
      recordedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
      commandId: null,
      causeSeq: null,
      correlationId: `cor_${kind}`,
      schemaVersion: 1,
    };
  });

/** The fields the journal reads back. `erasedAt` is the log's own. */
const asAppended = (event: StoredEvent): EventToAppend => ({
  seq: event.seq,
  id: event.id,
  kind: event.kind,
  entityId: event.entityId,
  version: event.version,
  type: event.type,
  data: event.data,
  meta: event.meta,
  recordedAt: event.recordedAt,
  commandId: event.commandId,
  causeSeq: event.causeSeq,
  correlationId: event.correlationId,
  schemaVersion: event.schemaVersion,
});

const rejectsWith = async (run: () => Promise<unknown>, code: 'CONFLICT'): Promise<void> => {
  try {
    await run();
  } catch (error) {
    check(isJournalError(error, code), `expected JournalError ${code}, got ${String(error)}`);
    return;
  }
  throw new ContractFailure(`expected JournalError ${code}, but the call succeeded`);
};

const orderOf = (on: EventLogReads) => {
  if (on.all === undefined) throw new ContractSkip('the log has no global order');
  return on.all;
};

export function eventLogContract(makeLog: MakeLog): readonly ContractCase[] {
  /** Opens a fresh log and gives the case the log as the journal sees it on the app database. */
  const withLog = async (
    run: (on: EventLogReads & EventLogWrites, nextSeq: () => number) => Promise<void>,
  ): Promise<void> => {
    const { log, db } = await makeLog();
    let seq = 0;
    const nextSeq = () => ++seq;
    if (log.canJoinTransaction) {
      if (db === undefined) throw new ContractFailure('a log that joins transactions needs `db` from makeLog');
      await run(logOn(log, db), nextSeq);
    } else {
      await run(log, nextSeq);
    }
  };

  return [
    {
      name: 'stream returns the events exactly as appended, oldest first',
      run: () =>
        withLog(async (on, nextSeq) => {
          const events = eventsFor(nextSeq, 'order', 'o1', 1, ['Placed', 'Paid']);
          await on.append({ kind: 'order', entityId: 'o1', expectedVersion: 0, events });
          const read = await on.stream('order', 'o1');
          check(
            sameValue(
              read.map(event => asAppended(event)),
              events,
            ),
            'stream did not return the appended events unchanged',
          );
          check(
            read.every(event => event.erasedAt === null),
            'a new event must not be erased',
          );
        }),
    },
    {
      name: 'stream keeps entities apart and honours types, afterVersion and limit',
      run: () =>
        withLog(async (on, nextSeq) => {
          await on.append({
            kind: 'order',
            entityId: 'o1',
            expectedVersion: 0,
            events: eventsFor(nextSeq, 'order', 'o1', 1, ['Placed', 'Paid', 'Noted']),
          });
          await on.append({
            kind: 'order',
            entityId: 'o2',
            expectedVersion: 0,
            events: eventsFor(nextSeq, 'order', 'o2', 1, ['Placed']),
          });
          const other = await on.stream('order', 'o2');
          check(other.length === 1, 'another entity leaked into the stream');
          const paid = await on.stream('order', 'o1', { types: ['Paid'] });
          check(
            sameValue(
              paid.map(e => e.version),
              [2],
            ),
            'types did not filter',
          );
          const after = await on.stream('order', 'o1', { afterVersion: 1, limit: 1 });
          check(
            sameValue(
              after.map(e => e.version),
              [2],
            ),
            'afterVersion with limit did not page',
          );
        }),
    },
    {
      name: 'highestVersion is 0 for a new entity and the last version after appends',
      run: () =>
        withLog(async (on, nextSeq) => {
          check((await on.highestVersion('order', 'o1')) === 0, 'a new entity must be at version 0');
          await on.append({
            kind: 'order',
            entityId: 'o1',
            expectedVersion: 0,
            events: eventsFor(nextSeq, 'order', 'o1', 1, ['Placed', 'Paid']),
          });
          check((await on.highestVersion('order', 'o1')) === 2, 'highestVersion must be the last appended version');
        }),
    },
    {
      name: 'a taken version is CONFLICT and the whole batch is refused',
      run: () =>
        withLog(async (on, nextSeq) => {
          await on.append({
            kind: 'order',
            entityId: 'o1',
            expectedVersion: 0,
            events: eventsFor(nextSeq, 'order', 'o1', 1, ['Placed']),
          });
          // Version 1 is taken by another event; version 2 is free. Neither may land.
          const rival = eventsFor(nextSeq, 'order', 'o1', 1, ['Placed', 'Paid']);
          await rejectsWith(
            () => on.append({ kind: 'order', entityId: 'o1', expectedVersion: 0, events: rival }),
            'CONFLICT',
          );
          check((await on.highestVersion('order', 'o1')) === 1, 'part of a refused batch was appended');
        }),
    },
    {
      name: 'the same batch again is a success that appends nothing',
      run: () =>
        withLog(async (on, nextSeq) => {
          const events = eventsFor(nextSeq, 'order', 'o1', 1, ['Placed', 'Paid']);
          const batch = { kind: 'order', entityId: 'o1', expectedVersion: 0, events };
          await on.append(batch);
          await on.append(batch);
          const stream = await on.stream('order', 'o1');
          check(stream.length === 2, 'a repeated batch appended its events twice');
        }),
    },
    {
      name: 'all.after walks every entity in one order, page by page, and filters by kind and type',
      run: () =>
        withLog(async (on, nextSeq) => {
          const order = orderOf(on);
          check((await order.top()) === null, 'an empty log has no top');
          await on.append({
            kind: 'order',
            entityId: 'o1',
            expectedVersion: 0,
            events: eventsFor(nextSeq, 'order', 'o1', 1, ['Placed']),
          });
          await on.append({
            kind: 'cart',
            entityId: 'c1',
            expectedVersion: 0,
            events: eventsFor(nextSeq, 'cart', 'c1', 1, ['Opened']),
          });
          await on.append({
            kind: 'order',
            entityId: 'o1',
            expectedVersion: 1,
            events: eventsFor(nextSeq, 'order', 'o1', 2, ['Paid']),
          });
          const first = await order.after(null, { limit: 2 });
          check(
            sameValue(
              first.events.map(e => e.id),
              ['evt_contract_1', 'evt_contract_2'],
            ),
            'first page out of order',
          );
          const second = await order.after(first.next, { limit: 2 });
          check(
            sameValue(
              second.events.map(e => e.id),
              ['evt_contract_3'],
            ),
            'second page did not continue the first',
          );
          check(second.next === (await order.top()), 'a short page must end at the top');
          const done = await order.after(second.next, { limit: 2 });
          check(done.events.length === 0 && done.next === second.next, 'a walk past the top must stay at the top');
          const orders = await order.after(null, { kinds: ['order'], types: ['Paid'], limit: 10 });
          check(
            sameValue(
              orders.events.map(e => e.id),
              ['evt_contract_3'],
            ),
            'kinds and types did not filter',
          );
          check(orders.next === (await order.top()), 'a filtered walk must still reach the top');
          if (order.distance !== undefined) {
            check(order.distance(null, await order.top()) > 0, 'distance from the start to the top must be positive');
            check(order.distance(await order.top(), await order.top()) === 0, 'distance to itself must be 0');
          }
        }),
    },
    {
      name: 'erase rewrites one event in place and keeps the first stamp',
      run: () =>
        withLog(async (on, nextSeq) => {
          if (on.erase === undefined) throw new ContractSkip('the log cannot rewrite events in place');
          const events = eventsFor(nextSeq, 'order', 'o1', 1, ['Placed', 'Noted']);
          await on.append({ kind: 'order', entityId: 'o1', expectedVersion: 0, events });
          const first = await on.erase(
            { kind: 'order', entityId: 'o1', version: 2 },
            { data: { note: 'x' }, schemaVersion: 2 },
          );
          const again = await on.erase(
            { kind: 'order', entityId: 'o1', version: 2 },
            { data: { note: 'y' }, schemaVersion: 2 },
          );
          check(first.erasedAt.getTime() === again.erasedAt.getTime(), 'a second erase must keep the first stamp');
          const [placed, noted] = await on.stream('order', 'o1');
          check(placed?.erasedAt === null && sameValue(placed.data, events[0]?.data), 'erase touched another event');
          check(sameValue(noted?.data, { note: 'y' }) && noted?.schemaVersion === 2, 'erase did not rewrite the event');
        }),
    },
    {
      name: 'inside a transaction, a refused batch leaves nothing even when the caller goes on and commits',
      run: async () => {
        const { log, db } = await makeLog();
        if (!log.canJoinTransaction) throw new ContractSkip('the log does not join transactions');
        if (db === undefined) throw new ContractFailure('a log that joins transactions needs `db` from makeLog');
        let seq = 0;
        const nextSeq = () => ++seq;
        await db.transaction(async tx => {
          const inside = log.bind(tx);
          await inside.append({
            kind: 'order',
            entityId: 'o1',
            expectedVersion: 0,
            events: eventsFor(nextSeq, 'order', 'o1', 1, ['Placed']),
          });
          const rival = eventsFor(nextSeq, 'order', 'o1', 1, ['Placed', 'Paid']);
          await rejectsWith(
            () => inside.append({ kind: 'order', entityId: 'o1', expectedVersion: 0, events: rival }),
            'CONFLICT',
          );
        });
        check((await log.bind(db).highestVersion('order', 'o1')) === 1, 'part of a refused batch was committed');
      },
    },
    {
      name: 'a joined log sees its own uncommitted events, and a rollback leaves none',
      run: async () => {
        const { log, db } = await makeLog();
        if (!log.canJoinTransaction) throw new ContractSkip('the log does not join transactions');
        if (db === undefined) throw new ContractFailure('a log that joins transactions needs `db` from makeLog');
        let seq = 0;
        const events = eventsFor(() => ++seq, 'order', 'o1', 1, ['Placed']);
        const rolledBack = new Error('roll back');
        await db
          .transaction(async tx => {
            const inside = log.bind(tx);
            await inside.append({ kind: 'order', entityId: 'o1', expectedVersion: 0, events });
            check((await inside.highestVersion('order', 'o1')) === 1, 'the bound log did not see its own append');
            throw rolledBack;
          })
          .catch((error: unknown) => {
            if (error !== rolledBack) throw error;
          });
        check((await log.bind(db).highestVersion('order', 'o1')) === 0, 'a rolled back append stayed in the log');
      },
    },
  ];
}
