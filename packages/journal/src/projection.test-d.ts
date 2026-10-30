import type { z } from 'zod';
import { describe, expectTypeOf, it } from 'vitest';

import type { journalFlowGraphSchema } from './journal-flow-schema.js';
import type { JournalFlowGraph } from './projection.js';

describe('the journal-flow graph', () => {
  it('reads back exactly the type the journal writes: the schema is locked to `JournalFlowGraph`', () => {
    expectTypeOf<z.output<typeof journalFlowGraphSchema>>().toEqualTypeOf<JournalFlowGraph>();
    expectTypeOf<JournalFlowGraph>().toEqualTypeOf<z.output<typeof journalFlowGraphSchema>>();
  });
});
