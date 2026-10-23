/**
 * `kurrentEvents` against a real KurrentDB: entities forwarded to it, an async projection
 * following `$all`, a store switch into it with `copyLog`, and the event log contract. Needs
 * Docker: starts a `kurrentplatform/kurrentdb` container through testcontainers. The image is
 * amd64 only; on an arm64 machine Docker runs it emulated.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { StartedTestContainer } from 'testcontainers';
import { jsonEvent, KurrentDBClient } from '@kurrent/kurrentdb-client';
import { eq } from 'drizzle-orm';
import { GenericContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';
import { ensure } from '@arki/schema';

import type { ForwardedLog } from './event-log.js';
import { ContractSkip, eventLogContract } from './event-log-contract.js';
import { initJournal } from './journal.js';
import { kurrentEvents } from './kurrentdb.js';
import { OrderNoted, OrderPaid, OrderPlaced, orders, tables } from './test-support.js';
import { openJournalDb } from './testing.js';

let container: StartedTestContainer;
let client: KurrentDBClient;
let db: PgliteDatabase;
let pglite: PGlite;
let next = 0;
const meta = { actorId: 'user:1' };

const metaSchema = z.object({ actorId: z.string().min(1) });
const define = (events: 'stored' | ForwardedLog) => {
  const jx = initJournal({ tables, meta: metaSchema, events });
  const order = jx
    .entity('kurrentorder', orders)
    .create(OrderPlaced, e => ({ customerId: e.data.customerId, total: e.data.total, status: 'placed' }))
    .on(OrderPaid, () => ({ status: 'paid' }))
    .on(OrderNoted, (_row, e) => ({ note: e.data.note }));
  const placed: string[] = [];
  const placedProjection = jx.projection(
    'placed-kurrent',
    order,
    {
      OrderPlaced: (_tx, e) => {
        placed.push(e.entityId);
      },
    },
    { lane: 'async' },
  );
  return { order, placed, journal: jx.compose({ projections: [placedProjection] }) };
};
/** The app before and after a switch: the same entity, first on the built-in log, then on KurrentDB. */
let local: ReturnType<typeof define>;
let remote: ReturnType<typeof define>;
let log: ForwardedLog;

/** The first event KurrentDB holds in a stream, as the client returns it. */
async function firstRaw(stream: string) {
  for await (const resolved of client.readStream(stream, { maxCount: 1 })) return resolved.event ?? null;
  return null;
}

const newId = () => `ord_kdb_${++next}` as const;
const place = (app: ReturnType<typeof define>, id: ReturnType<typeof newId>) =>
  db.transaction(tx =>
    app.journal.write(tx, app.order, id, { meta, events: () => [OrderPlaced({ customerId: 'c', total: 1 })] }),
  );
const pay = (app: ReturnType<typeof define>, id: ReturnType<typeof newId>) =>
  db.transaction(tx => app.journal.write(tx, app.order, id, { meta, events: () => [OrderPaid({ amount: 1 })] }));

beforeAll(async () => {
  container = await new GenericContainer('kurrentplatform/kurrentdb:26.2.3')
    .withPlatform('linux/amd64')
    .withEnvironment({ KURRENTDB_INSECURE: 'true', KURRENTDB_MEM_DB: 'true', KURRENTDB_RUN_PROJECTIONS: 'None' })
    .withExposedPorts(2113)
    .withWaitStrategy(Wait.forLogMessage('IS LEADER'))
    .start();
  client = KurrentDBClient.connectionString`kurrentdb://${container.getHost()}:${container.getMappedPort(2113)}?tls=false`;
  log = kurrentEvents({ client, prefix: 'app.' });
  local = define('stored');
  remote = define(log);
  ({ db, client: pglite } = await openJournalDb({ ...tables, orders }));
}, 180_000);

afterAll(async () => {
  await client.dispose();
  await pglite.close();
  await container.stop();
});

describe('an entity on kurrentEvents', () => {
  it('lands its events in one stream per entity, and an async projection follows $all', async () => {
    // Why: this is the adapter end to end. The write commits only the row and a forward job; the
    // worker appends one atomic batch to `app.kurrentorder-<id>` with the expected revision; catchUp
    // then walks `$all`, so the projection sees each create once and its cursor is a $all position.
    const first = newId();
    const written = orThrow(await place(remote, first));
    orThrow(await pay(remote, first));
    expect(await log.stream('kurrentorder', first)).toEqual([]);

    orThrow(await remote.journal.drain(db));
    const landed = await log.stream('kurrentorder', first);
    expect(landed.map(e => [e.id, e.version, e.seq, e.type])).toEqual([
      [written.events[0]?.id, 1, written.events[0]?.seq, 'OrderPlaced'],
      [expect.stringMatching(/^evt_/), 2, expect.any(Number), 'OrderPaid'],
    ]);
    expect(landed[0]?.recordedAt).toBeInstanceOf(Date);
    expect(await log.highestVersion('kurrentorder', first)).toBe(2);
    const raw = await firstRaw(`app.kurrentorder-${first}`);
    expect(raw?.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);

    await remote.journal.catchUp(db);
    expect(remote.placed).toContain(first);
    const [cursor] = await remote.journal.cursors(db);
    expect(cursor).toMatchObject({
      name: 'placed-kurrent',
      behind: false,
      position: expect.stringMatching(/^\d+:\d+$/),
    });

    const second = newId();
    orThrow(await place(remote, second));
    orThrow(await remote.journal.drain(db));
    const [behind] = await remote.journal.cursors(db);
    expect(behind).toMatchObject({ behind: true });
    await remote.journal.catchUp(db);
    expect(remote.placed.filter(id => id === second)).toEqual([second]);
  });

  it('refuses forget, because KurrentDB cannot rewrite an event', async () => {
    // Why: forget promises the personal data is gone from the history. KurrentDB keeps every
    // event as written, so the journal must say so instead of erasing only the row's copies.
    const id = newId();
    orThrow(await place(remote, id));
    orThrow(
      await db.transaction(tx =>
        remote.journal.write(tx, remote.order, id, { meta, events: () => [OrderNoted({ note: 'secret' })] }),
      ),
    );
    orThrow(await remote.journal.drain(db));
    await expect(remote.journal.forget(db, remote.order, id)).rejects.toMatchObject({
      code: 'NO_HISTORY',
      message: expect.stringContaining('cannot rewrite events in place'),
    });
  });

  it('takes a repeat KurrentDB does not recognise as a repeat, by reading the stream back', async () => {
    // Why: KurrentDB drops a repeated append by event UUID only while it remembers it. When it does
    // not, the append fails on the revision; the events already at those versions are the same
    // journal events, so the retry must succeed, not kill the forward job as a rival write.
    const source = kurrentEvents({ client, prefix: 'repeatsrc.' });
    const target = kurrentEvents({ client, prefix: 'repeatdst.' });
    const id = newId();
    orThrow(await place(local, id));
    const [event] = await db.select().from(tables.events).where(eq(tables.events.entityId, id));
    if (event === undefined) throw new Error('the write recorded an event');
    const { erasedAt: _erasedAt, ...toAppend } = event;
    const batch = { kind: 'kurrentorder', entityId: id, expectedVersion: 0, events: [toAppend] };
    await source.append(batch);
    // The same journal event, already in the target stream under another KurrentDB id.
    const written = await firstRaw(`repeatsrc.kurrentorder-${id}`);
    if (written === null) throw new Error('the source stream holds the event');
    await client.appendToStream(`repeatdst.kurrentorder-${id}`, [
      jsonEvent({
        type: written.type,
        data: ensure(written.data, z.record(z.string(), z.unknown())),
        metadata: written.metadata,
      }),
    ]);

    await expect(target.append(batch)).resolves.toBeUndefined();
    const stored = await target.stream('kurrentorder', id);
    expect(stored.map(e => e.id)).toEqual([event.id]);
    // A different event at that version is still a rival.
    await expect(target.append({ ...batch, events: [{ ...toAppend, id: 'evt_rival' }] })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('refuses a kind with "-", which would break the stream name', async () => {
    // Why: KurrentDB reads the category of a stream up to its first "-". A kind with one would be
    // split, and its entities would land in another kind's category.
    await expect(log.highestVersion('bad-kind', 'x')).rejects.toMatchObject({ code: 'BAD_DEFINITION' });
  });
});

describe('copyLog into KurrentDB', () => {
  it('moves a kind from the built-in log, so writes after the switch continue the history', async () => {
    // Why: KurrentDB checks the stream revision on every append. Without the copy the first
    // forward job after the switch expects revision N-1 on a stream that does not exist.
    const id = newId();
    orThrow(await place(local, id));
    orThrow(await pay(local, id));
    const before = await db.select().from(tables.events).where(eq(tables.events.entityId, id));

    await local.journal.copyLog(db, local.order, { to: log });
    const after = await log.stream('kurrentorder', id);
    expect(after.map(e => [e.id, e.version, e.seq])).toEqual(
      before.toSorted((a, b) => a.version - b.version).map(e => [e.id, e.version, e.seq]),
    );
    await local.journal.copyLog(db, local.order, { to: log });
    expect(await log.highestVersion('kurrentorder', id)).toBe(2);

    const paidAgain = orThrow(await pay(remote, id));
    expect(paidAgain.events.map(e => e.version)).toEqual([3]);
    orThrow(await remote.journal.drain(db));
    expect(await log.highestVersion('kurrentorder', id)).toBe(3);
    expect(orThrow(await remote.journal.verify(db, remote.order, id))).toMatchObject({ ok: true });
  });
});

describe('kurrentEvents meets the event log contract', () => {
  let cases = 0;
  // KurrentDB cannot be emptied, so each case gets streams under a prefix of its own.
  for (const contractCase of eventLogContract(() =>
    Promise.resolve({ log: kurrentEvents({ client, prefix: `contract${++cases}.` }) }),
  )) {
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
