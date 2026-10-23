import type { z } from 'zod';
import { describe, expectTypeOf, it } from 'vitest';

import type { archivedSummarySchema, attemptSummarySchema, jobSummarySchema, operationSummarySchema } from './jobs.js';
import type { ArchivedSummary, AttemptSummary, JobSummary, OperationSummary } from './shapes.js';

// The summaries are written once, as types, in `shapes.ts`; the schemas the reads parse their
// output with are locked to them both ways, so a field added to one fails here.
describe('Foreman job summaries', () => {
  it('parse to exactly the summary types the public entry names', () => {
    expectTypeOf<z.output<typeof attemptSummarySchema>>().toEqualTypeOf<AttemptSummary>();
    expectTypeOf<z.output<typeof operationSummarySchema>>().toEqualTypeOf<OperationSummary>();
    expectTypeOf<z.output<typeof archivedSummarySchema>>().toEqualTypeOf<ArchivedSummary>();
    expectTypeOf<z.output<typeof jobSummarySchema>>().toEqualTypeOf<JobSummary>();
  });
});
