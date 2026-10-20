/** Enqueue is an acknowledgement boundary: a lost acknowledgement must never trigger blind replay. */
import type { StandardSchemaV1 } from '@arki/schema';
import { defineFailure, InvalidInput, isAsyncSchemaFailure, ValidatorDefect } from '@arki/failure';
import { parseAsync } from '@arki/schema';

export const QueueUnavailable = defineFailure('queue.unavailable', {
  status: 503,
  message: 'The job has no active queue transport.',
  remediation: 'Register and start the queue before triggering this job.',
});
export const QueueAcceptanceUnknown = defineFailure('queue.acceptance_unknown', {
  status: 503,
  message: 'The queue could not confirm whether the job was accepted.',
  remediation: 'Inspect the job by its idempotency key before enqueueing it again.',
});
export const JOB_TRIGGER_FAILURES = [InvalidInput, ValidatorDefect, QueueUnavailable, QueueAcceptanceUnknown] as const;
export type JobTriggerFailure = ReturnType<(typeof JOB_TRIGGER_FAILURES)[number]>;
export type JobTriggerResult = string | JobTriggerFailure;

/** Validate caller input, then pass its original wire representation to the persisted boundary. */
export async function triggerValidated<Input>(
  schema: StandardSchemaV1<unknown, Input>,
  data: unknown,
  send: () => Promise<string>,
): Promise<JobTriggerResult> {
  const checked = await parseAsync(schema, data);
  if (isAsyncSchemaFailure(checked)) return checked;
  try {
    return await send();
  } catch (error) {
    return QueueAcceptanceUnknown({ cause: error });
  }
}
