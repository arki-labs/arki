import { createId } from '@paralleldrive/cuid2';

import { JournalError } from './errors.js';

/**
 * Same shape as `createPrefixedId` in `@arki/db/id`. That module is not
 * imported because its value export pulls `drizzle-orm/pg-core` and
 * `@arki/contracts` into browser bundles.
 */
const prefixed = <P extends string>(prefix: P): `${P}${string}` => `${prefix}${createId()}`;

export const eventId = () => prefixed('evt_');
export const jobId = () => prefixed('job_');
export const commandId = () => prefixed('cmd_');
export const correlationId = () => prefixed('cor_');
export const leaseToken = () => createId();

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
