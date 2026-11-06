/** The stored shape of a queued mail, and reading it back without trusting it. */
import type { ScheduledJob } from '@arki/journal';
import { is } from '@arki/schema';

import type { MailMessage } from '../types.js';
import { MAIL_ERROR_CODES, MailError } from '../errors.js';
import { queuedArgsSchema } from './args-schemas.js';

/** The queue row's job name. The version is part of the stored shape. */
export const MAIL_JOB = 'mail.deliver.v1';

/**
 * What a queue row holds. `queuedArgsSchema` (`args-schemas.ts`) checks it; `args.test-d.ts` locks the two.
 * The schemas live apart so `./pg` and `./outbox` name no Zod type (`TYPES_E001`).
 */
export type QueuedArgs = {
  readonly version: 1;
  readonly message: MailMessage;
  readonly expiresAt?: string;
};

/** The row's args, or a permanent failure: a row that cannot be read will never send. */
export function queuedArgs(job: ScheduledJob): QueuedArgs {
  if (is(job.args, queuedArgsSchema)) return job.args;
  throw new MailError(MAIL_ERROR_CODES.badQueuedData, `Queued mail ${job.id} does not hold a ${MAIL_JOB} message.`);
}
