/** The stored shape of a queued mail, and reading it back without trusting it. */
import type { ScheduledJob } from '@arki/journal';

import type { MailMessage } from '../types.js';
import { MAIL_ERROR_CODES, MailError, permanent } from '../errors.js';

/** The queue row's job name. The version is part of the stored shape. */
export const MAIL_JOB = 'mail.deliver.v1';

/** What a queue row holds. */
export type QueuedArgs = { readonly version: 1; readonly message: MailMessage; readonly expiresAt?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isAddresses = (value: unknown): boolean =>
  typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string'));
const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every(item => typeof item === 'string');
const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);
const isString = (value: unknown): boolean => typeof value === 'string';

/** A stored message, checked field by field: the row may predate a deploy or be edited by hand. */
export function isMailMessage(value: unknown): value is MailMessage {
  return (
    isRecord(value) &&
    isString(value.from) &&
    isString(value.subject) &&
    isString(value.text) &&
    isAddresses(value.to) &&
    optional(value.html, isString) &&
    optional(value.cc, isAddresses) &&
    optional(value.bcc, isAddresses) &&
    optional(value.replyTo, isAddresses) &&
    optional(value.headers, isStringRecord) &&
    optional(value.tags, isStringRecord) &&
    optional(value.template, isString)
  );
}

/** The row's args, or a permanent failure: a row that cannot be read will never send. */
export function queuedArgs(job: ScheduledJob): QueuedArgs {
  const args = job.args;
  if (isRecord(args) && args.version === 1 && isMailMessage(args.message) && optional(args.expiresAt, isString)) {
    const expiresAt = typeof args.expiresAt === 'string' ? args.expiresAt : undefined;
    return { version: 1, message: args.message, ...(expiresAt === undefined ? {} : { expiresAt }) };
  }
  throw new MailError(
    permanent(MAIL_ERROR_CODES.badQueuedData, `Queued mail ${job.id} does not hold a ${MAIL_JOB} message.`),
  );
}
