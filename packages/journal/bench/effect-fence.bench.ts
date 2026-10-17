// What the lease fence costs one effect that runs one command. The fence is one indexed
// `SELECT … FOR SHARE` on the job's open attempt row, inside the command's transaction.
//
// The rival is the same effect that runs the same command through `journal.run` instead of `ctx.run`:
// the same work minus the fence (`journal.run` is the unfenced path `ctx.run` wraps). Both cases write
// the order's events and drain the one job, so the gap is the fence plus noise.
// Run: `bun run bench`.

import { integer, pgTable, varchar } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { compare, defineSuite } from '@arki/bench';
import { initJournal } from '@arki/journal';
import { journalTables } from '@arki/journal/pg';
import { openJournalDb } from '@arki/journal/testing';

const notes = pgTable('bench_notes', {
  id: varchar('id', { length: 64 }).primaryKey(),
  note: varchar('note', { length: 2048 }).notNull(),
  version: integer('version').notNull().default(0),
});

const tables = journalTables();
const j = initJournal({ meta: z.object({ actorId: z.string().min(1) }) });
const NoteOpened = j.event('NoteOpened', z.object({ note: z.string() }));
const NoteSent = j.event('NoteSent', z.object({}));
const noteEntity = j
  .entity('note', notes)
  .create(NoteOpened, event => ({ note: event.data.note }))
  .on(NoteSent, row => row);
const touch = j.command('touch', z.object({ id: z.string() }), (input, { write }) =>
  write(noteEntity, input.id, () => []),
);
const meta = { actorId: 'usr_bench' };

type Db = Awaited<ReturnType<typeof openJournalDb>>['db'];
const fenced = j.effect('fenced', noteEntity, {
  NoteSent: (event, ctx) => ctx.run(touch, { id: event.entityId }, meta),
});
const fencedJournal = j.compose({ tables, effects: [fenced] });
// Reads `unfencedJournal` only when the effect runs, after `compose` has returned it.
const unfenced = j.effect('unfenced', noteEntity, {
  NoteSent: async (event, ctx) => {
    await unfencedJournal.run(ctx.db, touch, { id: event.entityId }, meta);
  },
});
const unfencedJournal = j.compose({ tables, effects: [unfenced] });

let pending: Promise<Db> | undefined;
const environment = (): Promise<Db> => (pending ??= openJournalDb({ ...tables, notes }).then(opened => opened.db));
let counter = 0;

async function viaEffect(effectJournal: typeof fencedJournal, note: string): Promise<string> {
  const db = await environment();
  const id = `note_${++counter}`;
  await db.transaction(tx => effectJournal.write(tx, noteEntity, id, { meta, events: () => [NoteOpened({ note })] }));
  await db.transaction(tx => effectJournal.write(tx, noteEntity, id, { meta, events: () => [NoteSent({})] }));
  const ran = await effectJournal.drain(db);
  return JSON.stringify({ ran, note });
}

export default defineSuite({
  id: '@arki/journal/effect-fence',
  intro:
    'One effect that runs one command (`ctx.run`), against the same effect that runs the same command through `journal.run`, which skips the lease fence. Same in-memory PGlite, same writes, same drain.',
  notes: [
    'The fence is one indexed `SELECT … FOR SHARE` on the job’s open attempt row, inside the command’s transaction. The race it closes is proven in `src/fence.pg.test.ts`, not timed here.',
    'PGlite has one connection, so this is the cost of one extra statement, not of lock contention.',
  ],
  groups: [
    compare<string>({
      id: 'effect-one-command',
      title: 'Write, drain and run one command from an effect',
      contract: {
        id: 'journal-effect-fence/v1',
        description: 'the effect runs once and its command commits, with or without the fence',
      },
      inputs: ['short note', 'x'.repeat(1024)],
      expected: note => JSON.stringify({ ran: 1, note }),
      mode: 'async',
      baseline: 'unfenced',
      cases: c => ({
        unfenced: c({
          label: 'journal.run from the effect (no fence)',
          package: '@arki/journal',
          setup: note => note,
          run: note => viaEffect(unfencedJournal, note),
        }),
        fenced: c({
          label: 'ctx.run (lease fence)',
          package: '@arki/journal',
          setup: note => note,
          run: note => viaEffect(fencedJournal, note),
        }),
      }),
    }),
  ],
});
