import type { z } from 'zod';
import { describe, expectTypeOf, it } from 'vitest';

import type { LimitOps } from '../api.js';
import type { JobOperationInput } from '../outbox.js';
import type { DbHandle } from '../types.js';
import type { LimitKeyOverride, LimitNameArgs, LimitOverrideArgs, LimitResetArgs } from './limit-types.js';
import type { limitKeyOverrideSchema } from './limits.js';
import type { WorkflowVerbs } from './read.js';
import type { shapeSchema } from './machine.js';
import type {
  addTagsSchema,
  cancelArgsSchema,
  limitNameArgsSchema,
  limitOverrideSchema,
  limitResetSchema,
  operationSchema,
  operatorCancelSchema,
  operatorSignalSchema,
  replaySchema,
  rescheduleSchema,
  resolveStepSchema,
  retryStepSchema,
  setMetadataSchema,
  signalEnvelope,
  skipUndoSchema,
} from './runner.js';
import type { CancelArgs, ReplayArgs, RescheduleArgs, SignalArgs } from './run-types.js';
import type { RetentionAge } from '../retention.js';
import type { MetadataChange, RunFields, RunOverrides, RunTiming } from './run-fields.js';
import type {
  delayAgeSchema,
  metadataChangeSchema,
  runFieldsSchema,
  runOverridesSchema,
  runTimingSchema,
  ttlAgeSchema,
} from './run-field-schemas.js';
import type { WorkflowShape } from './shape.js';

// Compile-time only: tsc checks this file, vitest does not run it.
// Each TS type is the source and each zod schema checks the same value at runtime. A field added to one side and not
// the other would let a stored or sent value pass the check but break the code that reads it, so each pair must be equal.
type VerbArgs<Verb extends keyof WorkflowVerbs<DbHandle>> = Parameters<WorkflowVerbs<DbHandle>[Verb]>[1];
type LimitArgs<Verb extends 'override' | 'reset' | 'pause' | 'resume'> = Parameters<LimitOps<DbHandle>[Verb]>[1];
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

  it('the overrides def.start takes', () => {
    expectTypeOf<z.output<typeof runOverridesSchema>>().toEqualTypeOf<RunOverrides>();
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

  it('the limit verbs: their arguments plus the operation, and a stored key override', () => {
    expectTypeOf<z.output<typeof limitKeyOverrideSchema>>().toEqualTypeOf<LimitKeyOverride>();
    expectTypeOf<WithoutOp<z.output<typeof limitOverrideSchema>>>().toEqualTypeOf<LimitOverrideArgs>();
    expectTypeOf<LimitArgs<'override'>>().toEqualTypeOf<LimitOverrideArgs>();
    expectTypeOf<Omit<z.output<typeof limitResetSchema>, 'op'>>().toEqualTypeOf<LimitResetArgs>();
    expectTypeOf<LimitArgs<'reset'>>().toEqualTypeOf<LimitResetArgs>();
    expectTypeOf<Omit<z.output<typeof limitNameArgsSchema>, 'op'>>().toEqualTypeOf<LimitNameArgs>();
    expectTypeOf<LimitArgs<'pause'>>().toEqualTypeOf<LimitNameArgs>();
    expectTypeOf<LimitArgs<'resume'>>().toEqualTypeOf<LimitNameArgs>();
  });
});
