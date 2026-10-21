import type { z } from 'zod';
import { describe, expectTypeOf, it } from 'vitest';

import type { JobOperationInput } from '../outbox.js';
import type { DbHandle } from '../types.js';
import type { WorkflowVerbs } from './read.js';
import type { shapeSchema } from './machine.js';
import type {
  CancelArgs,
  SignalArgs,
  cancelArgsSchema,
  operationSchema,
  operatorCancelSchema,
  operatorSignalSchema,
  resolveStepSchema,
  retryStepSchema,
  signalEnvelope,
  skipUndoSchema,
} from './runner.js';
import type { WorkflowShape } from './shape.js';

// Compile-time only: tsc checks this file, vitest does not run it.
// Each TS type is the source and each zod schema checks the same value at runtime. A field added to one side and not
// the other would let a stored or sent value pass the check but break the code that reads it, so each pair must be equal.
type VerbArgs<Verb extends keyof WorkflowVerbs<DbHandle>> = Parameters<WorkflowVerbs<DbHandle>[Verb]>[1];

describe('workflow schemas match their types exactly', () => {
  it('the stored shape', () => {
    expectTypeOf<z.output<typeof shapeSchema>>().toEqualTypeOf<WorkflowShape>();
  });

  it('the arguments of def.cancel and def.signal', () => {
    expectTypeOf<z.output<typeof cancelArgsSchema>>().toEqualTypeOf<CancelArgs>();
    expectTypeOf<z.output<typeof signalEnvelope>>().toEqualTypeOf<SignalArgs<unknown>>();
  });

  it('the operator verbs: their arguments plus the operation', () => {
    expectTypeOf<z.output<typeof operationSchema>>().toEqualTypeOf<JobOperationInput>();
    expectTypeOf<Omit<z.output<typeof retryStepSchema>, 'op'>>().toEqualTypeOf<VerbArgs<'retryStep'>>();
    expectTypeOf<Omit<z.output<typeof resolveStepSchema>, 'op'>>().toEqualTypeOf<VerbArgs<'resolveStep'>>();
    expectTypeOf<Omit<z.output<typeof skipUndoSchema>, 'op'>>().toEqualTypeOf<VerbArgs<'skipUndo'>>();
    expectTypeOf<Omit<z.output<typeof operatorSignalSchema>, 'op'>>().toEqualTypeOf<VerbArgs<'signal'>>();
    expectTypeOf<Omit<z.output<typeof operatorCancelSchema>, 'op'>>().toEqualTypeOf<VerbArgs<'cancel'>>();
  });
});
