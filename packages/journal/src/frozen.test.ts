/**
 * Events are recorded facts. Every event the library hands to user code is
 * read-only, so one handler cannot change what another handler or a later
 * rerun sees.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import { j, meta, openDb, orderId, orders, tables } from './test-support.js';

const Tagged = j.event('Tagged', z.object({ items: z.array(z.string()) }));

const seen: string[][] = [];
const frozenFlags: boolean[] = [];
let mutateInEffect = false;

const tagged = j.entity('tagged', orders).create(Tagged, e => ({
  customerId: 'c',
  total: e.data.items.length,
  status: 'placed',
}));

const sortsInPlace = j.projection('sorts-in-place', tagged, {
  Tagged: (_tx, e) => {
    // The defect under test: an in-place sort must fail, not reorder what the next handler sees.
    e.data.items.sort();
  },
});

const sortsCopy = j.projection('sorts-copy', tagged, {
  Tagged: (_tx, e) => {
    seen.push(e.data.items.toSorted());
  },
});

const readsOrder = j.projection('reads-order', tagged, {
  Tagged: (_tx, e) => {
    seen.push([...e.data.items]);
  },
});

const reassigns = j.entity('reassigns', orders).create(Tagged, e => {
  Object.assign(e.data, { items: [] });
  return { customerId: 'c', total: 0, status: 'placed' };
});

const mutatesNested = j.entity('mutates-nested', orders).create(Tagged, e => {
  e.data.items.push('x');
  return { customerId: 'c', total: 0, status: 'placed' };
});

const watcher = j.effect('watcher', tagged, {
  Tagged: e => {
    frozenFlags.push(
      Object.isFrozen(e),
      Object.isFrozen(e.data),
      Object.isFrozen(e.data.items),
      Object.isFrozen(e.meta),
    );
    if (mutateInEffect) e.data.items.push('x');
  },
});

let db: PgliteDatabase;
let client: PGlite;
let next = 5000;

beforeAll(async () => {
  ({ db, client } = await openDb());
});

afterAll(async () => {
  await client.close();
});

const write = (
  journal: ReturnType<typeof j.compose>,
  entity: typeof tagged | typeof reassigns | typeof mutatesNested,
  id: ReturnType<typeof orderId>,
  items: string[],
) => db.transaction(tx => journal.write(tx, entity, id, { meta, events: () => [Tagged({ items })] }));

const rowCounts = async (id: ReturnType<typeof orderId>) => {
  const events = await db.select().from(tables.events).where(eq(tables.events.entityId, id));
  const rows = await db.select().from(orders).where(eq(orders.id, id));
  return { events: events.length, rows: rows.length };
};

const expectFrozen = (e: { data: { items: string[] }; meta: object }) => {
  expect(Object.isFrozen(e)).toBe(true);
  expect(Object.isFrozen(e.data)).toBe(true);
  expect(Object.isFrozen(e.data.items)).toBe(true);
  expect(Object.isFrozen(e.meta)).toBe(true);
};

describe('read-only events', () => {
  it('one handler must not be able to change what another handler or a later rerun sees: a mutating projection refuses the write', async () => {
    const journal = j.compose({ projections: [sortsInPlace, readsOrder] });
    const id = orderId(++next);
    await expect(write(journal, tagged, id, ['b', 'a'])).rejects.toBeInstanceOf(TypeError);
    expect(await rowCounts(id)).toEqual({ events: 0, rows: 0 });
  });

  it('a projection that sorts a copy works and the next projection still sees the original order', async () => {
    const journal = j.compose({ projections: [sortsCopy, readsOrder] });
    seen.length = 0;
    orThrow(await write(journal, tagged, orderId(++next), ['b', 'a']));
    expect(seen).toEqual([
      ['a', 'b'],
      ['b', 'a'],
    ]);
  });

  it('a reducer that assigns to e.data throws, and so does one that changes a nested field', async () => {
    const journal = j.compose({});
    const id = orderId(++next);
    await expect(write(journal, reassigns, id, ['a'])).rejects.toBeInstanceOf(TypeError);
    await expect(write(journal, mutatesNested, orderId(++next), ['a'])).rejects.toBeInstanceOf(TypeError);
    expect(await rowCounts(id)).toEqual({ events: 0, rows: 0 });
  });

  it('the events returned by write and by replay are frozen all the way down', async () => {
    const journal = j.compose({});
    const id = orderId(++next);
    const written = orThrow(await write(journal, tagged, id, ['b', 'a']));
    for (const e of written.events) expectFrozen(e);
    const replayed = orThrow(await journal.replay(db, tagged, id));
    expect(replayed.events).toHaveLength(1);
    for (const e of replayed.events) expectFrozen(e);
  });

  it('an effect receives a frozen event; one that mutates it fails and the job is retried like any handler failure', async () => {
    const journal = j.compose({ effects: [watcher] });
    const id = orderId(++next);
    const written = orThrow(await write(journal, tagged, id, ['a']));
    const [job] = await db
      .select()
      .from(tables.jobs)
      .where(eq(tables.jobs.eventSeq, written.events[0]?.seq ?? -1));
    if (job === undefined) throw new Error('no job row');
    frozenFlags.length = 0;
    mutateInEffect = true;
    try {
      await journal.drain(db);
    } finally {
      mutateInEffect = false;
    }
    expect(frozenFlags).toEqual([true, true, true, true]);
    const [after] = await db.select().from(tables.jobs).where(eq(tables.jobs.id, job.id));
    expect(after).toMatchObject({ attempts: 1, deadAt: null });
    expect(after?.lastError).toContain('TypeError');
  });
});
