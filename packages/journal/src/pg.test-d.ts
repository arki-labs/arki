import { describe, expectTypeOf, it } from 'vitest';

import type { ExportsEveryJournalTable, JournalTables, LimitKeyOverride } from './pg.js';

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

describe('LimitKeyOverride', () => {
  it('is the type of journal_limits.keys, so a schema module that infers its tables can name it (TS2883)', () => {
    expectTypeOf<JournalTables['limits']['$inferSelect']['keys']>().toEqualTypeOf<Readonly<Record<string, LimitKeyOverride>>>();
    expectTypeOf<LimitKeyOverride>().toEqualTypeOf<{ readonly perKey: number; readonly until: string }>();
  });
});
