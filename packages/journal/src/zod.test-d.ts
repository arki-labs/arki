import type { z } from 'zod';
import { describe, expectTypeOf, it } from 'vitest';

import type { EventLogPosition } from './event-log.js';
import type { ForwardArgs, JournalTables, StoredEventRow } from './pg.js';
import type { eventLogPositionSchema, forwardArgsSchema, storedEventRowSchema } from './zod.js';

// Each type is written once, where it belongs; the schema that decodes it is locked to it both ways.
describe('storedEventRowSchema', () => {
  it('decodes an effect job’s `args` to exactly the `journal_events` row type, so the worker runs the same shape the writer stored', () => {
    // The table is the one source of the row type. The schema only brings the JSON copy back (dates
    // become strings in jsonb); this check fails as soon as a column is added to one and not the other.
    expectTypeOf<StoredEventRow>().toEqualTypeOf<JournalTables['events']['$inferSelect']>();
    expectTypeOf<z.output<typeof storedEventRowSchema>>().toEqualTypeOf<StoredEventRow>();
  });
});

describe('forwardArgsSchema', () => {
  it('decodes a forward job’s `args` to exactly `ForwardArgs`, the events the worker appends', () => {
    expectTypeOf<z.output<typeof forwardArgsSchema>>().toEqualTypeOf<ForwardArgs>();
  });
});

describe('eventLogPositionSchema', () => {
  it('makes exactly the branded `EventLogPosition`, so a plain string is not a position', () => {
    // Why: a cursor or `rerun({ after })` must hold a position a log made, not any text.
    expectTypeOf<z.output<typeof eventLogPositionSchema>>().toEqualTypeOf<EventLogPosition>();
    expectTypeOf<string>().not.toExtend<EventLogPosition>();
  });
});
