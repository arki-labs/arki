import type { z } from 'zod';
import { describe, expectTypeOf, it } from 'vitest';

import type { JobOperationInput } from '../outbox.js';
import type { DbHandle } from '../types.js';
import type { WorkflowVerbs } from './read.js';
import type { shapeSchema } from './machine.js';
import type {
  addTagsSchema,
  CancelArgs,
  SignalArgs,
  cancelArgsSchema,
  operationSchema,
  operatorCancelSchema,
  operatorSignalSchema,
  ReplayArgs,
  replaySchema,
  RescheduleArgs,
  rescheduleSchema,
  resolveStepSchema,
  retryStepSchema,
  setMetadataSchema,
  signalEnvelope,
  skipUndoSchema,
} from './runner.js';
import type { RetentionAge } from '../retention.js';
import type {
  delayAgeSchema,
  MetadataChange,
  metadataChangeSchema,
  RunFields,
  runFieldsSchema,
  RunTiming,
  runTimingSchema,
  ttlAgeSchema,
} from './run-fields.js';
import type { WorkflowShape } from './shape.js';

// Compile-time only: tsc checks this file, vitest does not run it.
// Each TS type is the source and each zod schema checks the same value at runtime. A field added to one side and not
// the other would let a stored or sent value pass the check but break the code that reads it, so each pair must be equal.
type VerbArgs<Verb extends keyof WorkflowVerbs<DbHandle>> = Parameters<WorkflowVerbs<DbHandle>[Verb]>[1];
/** `Omit` over each member of a union: `reschedule` takes one of two shapes. */
type WithoutOp<T> = T extends unknown ? Omit<T, 'op'> : never;

describe('workflow schemas match their types exactly', () => {
  it('the stored shape', () => {
    expectTypeOf<z.output<typeof shapeSchema>>().toEqualTypeOf<WorkflowShape>();
  });

  it('the run fields def.start takes', () => {
    expectTypeOf<z.output<typeof runFieldsSchema>>().toEqualTypeOf<RunFields>();
  });

  it('the timing def.start takes, and the ages it is written in', () => {
    expectTypeOf<z.output<typeof runTimingSchema>>().toEqualTypeOf<RunTiming>();
    expectTypeOf<z.output<typeof delayAgeSchema>>().toEqualTypeOf<RetentionAge>();
    expectTypeOf<z.output<typeof ttlAgeSchema>>().toEqualTypeOf<RetentionAge>();
  });

  it('a change to the metadata of a run', () => {
    expectTypeOf<z.output<typeof metadataChangeSchema>>().toEqualTypeOf<MetadataChange>();
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
    expectTypeOf<Omit<z.output<typeof setMetadataSchema>, 'op'>>().toEqualTypeOf<VerbArgs<'setMetadata'>>();
    expectTypeOf<Omit<z.output<typeof addTagsSchema>, 'op'>>().toEqualTypeOf<VerbArgs<'addTags'>>();
    expectTypeOf<WithoutOp<z.output<typeof rescheduleSchema>>>().toEqualTypeOf<RescheduleArgs>();
    expectTypeOf<VerbArgs<'reschedule'>>().toEqualTypeOf<RescheduleArgs>();
    expectTypeOf<Omit<z.output<typeof replaySchema>, 'op'>>().toEqualTypeOf<ReplayArgs>();
    expectTypeOf<VerbArgs<'replay'>>().toEqualTypeOf<ReplayArgs>();
  });
});
