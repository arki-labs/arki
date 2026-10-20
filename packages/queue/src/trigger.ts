/** Enqueue is an acknowledgement boundary: a lost acknowledgement must never trigger blind replay. */
import type { StandardSchemaV1 } from '@arki/schema';
import { ID_GENERATION_FAILURES } from '@arki/contracts';
import { defineFailure, InvalidInput, isAsyncSchemaFailure, isFailure, ValidatorDefect } from '@arki/failure';
import { parseAsync } from '@arki/schema';

import type { QueueJobId } from './job-id.ts';
import { withEnqueueSpan } from './enqueue-span.ts';
import { queueJobId } from './job-id.ts';

/**
 * @fix Register and start the queue before triggering this job.
 * @verify bun run test -- src/trigger.spec.ts
 */
export const QueueUnavailable = defineFailure('queue.unavailable', {
  status: 503,
  message: 'The job has no active queue transport.',
  remediation: 'Register and start the queue before triggering this job.',
});
/**
 * @fix Inspect the job by its idempotency key before enqueueing it again.
 * @verify bun run test -- src/trigger.spec.ts
 */
export const QueueAcceptanceUnknown = defineFailure('queue.acceptance_unknown', {
  status: 503,
  message: 'The queue could not confirm whether the job was accepted.',
  remediation: 'Inspect the job by its idempotency key before enqueueing it again.',
});
export const JOB_TRIGGER_FAILURES = [
  InvalidInput,
  ValidatorDefect,
  QueueUnavailable,
  QueueAcceptanceUnknown,
  ...ID_GENERATION_FAILURES,
] as const;
export type JobTriggerFailure = ReturnType<(typeof JOB_TRIGGER_FAILURES)[number]>;
export type JobTriggerResult = QueueJobId | JobTriggerFailure;

/** Validate caller input, then pass its original wire representation to the persisted boundary. */
export async function triggerValidated<Input>(
  schema: StandardSchemaV1<unknown, Input>,
  data: unknown,
  key: string | undefined,
  send: (key: QueueJobId) => Promise<string | undefined>,
  jobName?: string,
): Promise<JobTriggerResult> {
  return withEnqueueSpan(async () => {
    const checked = await parseAsync(schema, data);
    if (isAsyncSchemaFailure(checked)) return checked;
    const id = key === undefined ? queueJobId.create() : await parseAsync(queueJobId.schema, key);
    if (isFailure(id)) return id;
    try {
      const acknowledged = await send(id);
      if (acknowledged === undefined) return QueueAcceptanceUnknown();
      const restored = await parseAsync(queueJobId.schema, acknowledged);
      return isAsyncSchemaFailure(restored) ? QueueAcceptanceUnknown({ cause: restored }) : restored;
    } catch (error) {
      return QueueAcceptanceUnknown({ cause: error });
    }
  }, jobName);
}
