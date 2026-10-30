/** The stored shape of a queued mail, and reading it back without trusting it. */
import { z } from 'zod';

import type { ScheduledJob } from '@arki/journal';
import { is } from '@arki/schema';

import { MAIL_ERROR_CODES, MailError } from '../errors.js';

/** The queue row's job name. The version is part of the stored shape. */
export const MAIL_JOB = 'mail.deliver.v1';

const addressesSchema = z.union([z.string(), z.array(z.string()).readonly()]);
const stringRecordSchema = z.record(z.string(), z.string()).readonly();

/**
 * A stored message, checked field by field: the row may predate a deploy or be edited by hand.
 * `args.test-d.ts` locks its output to `MailMessage`.
 */
export const mailMessageSchema = z
  .object({
    from: z.string(),
    subject: z.string(),
    text: z.string(),
    to: addressesSchema,
    html: z.string().exactOptional(),
    cc: addressesSchema.exactOptional(),
    bcc: addressesSchema.exactOptional(),
    replyTo: addressesSchema.exactOptional(),
    headers: stringRecordSchema.exactOptional(),
    tags: stringRecordSchema.exactOptional(),
    template: z.string().exactOptional(),
  })
  .readonly();

/** What a queue row holds. */
export const queuedArgsSchema = z
  .object({
    version: z.literal(1),
    message: mailMessageSchema,
    expiresAt: z.string().exactOptional(),
  })
  .readonly();

export type QueuedArgs = z.output<typeof queuedArgsSchema>;

/** The row's args, or a permanent failure: a row that cannot be read will never send. */
export function queuedArgs(job: ScheduledJob): QueuedArgs {
  if (is(job.args, queuedArgsSchema)) return job.args;
  throw new MailError(MAIL_ERROR_CODES.badQueuedData, `Queued mail ${job.id} does not hold a ${MAIL_JOB} message.`);
}
