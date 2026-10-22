/** Enqueue is an acknowledgement boundary: a lost acknowledgement must never trigger blind replay. */
import type { StandardSchemaV1 } from '@arki/schema';
import { isAsyncSchemaFailure, isFailure } from '@arki/failure';
import { parseAsync } from '@arki/schema';

import type { JobTriggerFailure } from './errors.ts';
import { QueueAcceptanceUnknown } from './errors.ts';
import type { QueueJobId } from './job-id.ts';
import { withEnqueueSpan } from './enqueue-span.ts';
import { queueJobId } from './job-id.ts';

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
