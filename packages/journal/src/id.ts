import { defineId } from '@arki/contracts';

import { JournalError } from './errors.js';

export const eventId = defineId('evt_').create;
export const jobId = defineId('job_').create;
export const commandId = defineId('cmd_').create;
export const correlationId = defineId('cor_').create;
export const attemptId = defineId('att_').create;
export const operationId = defineId('jop_').create;
export const workflowRunId = defineId('wfr_').create;
export const workflowBatchId = defineId('wfb_').create;
export const workflowSignalId = defineId('wsg_').create;
export const leaseToken = defineId('').create;

const NAME_KINDS = {
  'entity kind': 64,
  'event type': 128,
  'effect name': 128,
} as const;

/**
 * Throws unless `name` fits the `varchar` column the journal stores it in: non-empty,
 * well-formed UTF-16 (a lone surrogate would be stored as U+FFFD and alias another name),
 * and at most the column length in code points. Hermes-safe: no `isWellFormed`, no lookbehind.
 */
export function assertStoredName(what: keyof typeof NAME_KINDS, name: string): void {
  const limit = NAME_KINDS[what];
  const shown = JSON.stringify(name);
  if (name === '') throw new JournalError('BAD_DEFINITION', what, shown, `journal: ${what} must not be empty`);
  let length = 0;
  for (const ch of name) {
    const point = ch.codePointAt(0);
    if (point !== undefined && point >= 55_296 && point <= 57_343) {
      throw new JournalError(
        'BAD_DEFINITION',
        what,
        shown,
        `journal: ${what} ${shown} has an unpaired surrogate; the database would store it as U+FFFD`,
      );
    }
    length++;
  }
  if (length > limit) {
    throw new JournalError(
      'BAD_DEFINITION',
      what,
      shown,
      `journal: ${what} ${shown} is ${length} characters; the limit is ${limit}`,
    );
  }
}
