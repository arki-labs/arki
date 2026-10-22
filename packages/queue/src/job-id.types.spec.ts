import { expectTypeOf, it } from 'vitest';

import type { ID_GENERATION_FAILURES, IdGenerationFailure, IdOf } from '@arki/contracts';
import type { FailureOf } from '@arki/failure';

import type { QueueJobId } from './job-id.ts';
import type { JOB_TRIGGER_FAILURES } from './errors.ts';
import type { JobTriggerResult } from './trigger.ts';
import type { queueJobId } from './job-id.ts';

it('keeps generated failure and branded success types exact at the acknowledgement boundary', () => {
  expectTypeOf<QueueJobId>().toEqualTypeOf<IdOf<typeof queueJobId>>();
  expectTypeOf<ReturnType<typeof queueJobId.create>>().toEqualTypeOf<QueueJobId | IdGenerationFailure>();
  expectTypeOf<JobTriggerResult>().toEqualTypeOf<QueueJobId | FailureOf<(typeof JOB_TRIGGER_FAILURES)[number]>>();
  expectTypeOf<
    Extract<JobTriggerResult, FailureOf<(typeof ID_GENERATION_FAILURES)[number]>>
  >().toEqualTypeOf<IdGenerationFailure>();
  expectTypeOf<string>().not.toExtend<QueueJobId>();
});
