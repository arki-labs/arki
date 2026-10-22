import type { z } from 'zod';
import { describe, expectTypeOf, it } from 'vitest';

import type { ExportsEveryJournalTable, JournalTables, StoredEventRow } from './pg.js';

describe('StoredEventRow', () => {
  it('decodes an effect job’s `args` to exactly the `journal_events` row type, so the worker runs the same shape the writer stored', () => {
    // The table is the one source of the row type. The schema only brings the JSON copy back (dates
    // become strings in jsonb); this check fails as soon as a column is added to one and not the other.
    expectTypeOf<z.output<typeof StoredEventRow>>().toEqualTypeOf<JournalTables['events']['$inferSelect']>();
  });
});

// Compile-time only: tsc checks this file, vitest does not run it.
// A schema module as drizzle-kit sees it: one top-level export per table.
type EveryTable = {
  [Name in keyof JournalTables as `journal_${Name}`]: JournalTables[Name];
};

describe('ExportsEveryJournalTable', () => {
  it('passes when each table has its own export, whatever the names', () => {
    expectTypeOf<ExportsEveryJournalTable<EveryTable>>().toEqualTypeOf<EveryTable>();
  });

  it('passes when the module also exports other things', () => {
    type WithExtras = EveryTable & { users: { id: string }; allJournalTables: JournalTables };
    expectTypeOf<ExportsEveryJournalTable<WithExtras>>().toEqualTypeOf<WithExtras>();
  });

  it('fails and names the table when one table has no export', () => {
    type NoArchive = Omit<EveryTable, 'journal_jobArchive'>;
    // @ts-expect-error -- drizzle-kit would never migrate journal_job_archive.
    expectTypeOf<ExportsEveryJournalTable<NoArchive>>().toBeObject();
  });

  it('fails when the tables are exported only inside one object', () => {
    // @ts-expect-error -- drizzle-kit does not look inside a nested object.
    expectTypeOf<ExportsEveryJournalTable<{ allJournalTables: JournalTables }>>().toBeObject();
  });
});
