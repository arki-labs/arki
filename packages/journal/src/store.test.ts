/**
 * The store turns a lost race into the journal's `CONFLICT`, whatever the entity's event setting.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import { initJournal } from './journal.js';
import { tables } from './test-support.js';
import { openJournalDb } from './testing.js';

/** A handle is unique across members: the row's own constraint, which no event log knows about. */
const members = pgTable('members', {
  id: varchar('id', { length: 64 }).primaryKey(),
  handle: varchar('handle', { length: 64 }).notNull().unique(),
  version: integer('version').notNull().default(0),
});

const j = initJournal({ tables, meta: z.object({ actorId: z.string().min(1) }) });
const Joined = j.event('MemberJoined', z.object({ handle: z.string().min(1) }));
const member = j.entity('member', members).create(Joined, e => ({ handle: e.data.handle }));
const guest = j.entity('guest', members, { events: 'transient' }).create(Joined, e => ({ handle: e.data.handle }));
const journal = j.compose({});
const meta = { actorId: 'user:1' };

let db: PgliteDatabase;
let client: PGlite;

beforeAll(async () => {
  ({ db, client } = await openJournalDb({ ...tables, members }));
});
afterAll(async () => {
  await client.close();
});

describe('a unique violation on the row insert', () => {
  it('is CONFLICT for an entity with stored events, and its events roll back with it', async () => {
    // Why: the log's unique index only knows (kind, id, version). A taken handle is caught by the
    // row, after the events were appended. The caller must get the journal's code, not a driver
    // error, and the log must not keep events for a row that was never saved.
    orThrow(
      await db.transaction(tx => journal.write(tx, member, 'm-1', { meta, events: () => [Joined({ handle: 'ada' })] })),
    );
    const taken = db.transaction(tx =>
      journal.write(tx, member, 'm-2', { meta, events: () => [Joined({ handle: 'ada' })] }),
    );
    await expect(taken).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(taken).rejects.toThrow('a column value is already taken');
    const logged = await db
      .select()
      .from(tables.events)
      .where(and(eq(tables.events.kind, 'member'), eq(tables.events.entityId, 'm-2')));
    expect(logged).toEqual([]);
  });

  it('is CONFLICT for a transient entity too: one rule, whatever the setting', async () => {
    // Why: with no log, the row's constraints are the only guard. Same code as the stored case, so
    // a caller never has to know how the entity keeps its events to handle a lost race.
    orThrow(
      await db.transaction(tx => journal.write(tx, guest, 'g-1', { meta, events: () => [Joined({ handle: 'bob' })] })),
    );
    const taken = db.transaction(tx =>
      journal.write(tx, guest, 'g-2', { meta, events: () => [Joined({ handle: 'bob' })] }),
    );
    await expect(taken).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
