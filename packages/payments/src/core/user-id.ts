import { userIdSchema as anyUserIdSchema, defineId } from '@arki/contracts';

import { boundedIdSchema } from './id-length.js';

export type { UserId } from '@arki/contracts';

/**
 * Validates a user id this package can store: a string that starts with `usr_` (the `@arki/contracts`
 * rule), no longer than a `user_id` column holds (`ID_COLUMN_LENGTH`, else SQLSTATE 22001), and with no
 * U+0000, which no `user_id` column can hold (Postgres refuses it with SQLSTATE 22021).
 */
export const userIdSchema = boundedIdSchema(anyUserIdSchema).refine(
  value => !value.includes('\u0000'),
  'A user id cannot contain the NUL character (U+0000)',
);

/**
 * Builds the user columns of this package's tables. Its foreign-key columns carry the column
 * schema tag that makes `createInsertSchema(table)` validate `userId` as a `usr_*` value.
 */
export const userIdFactory = defineId('usr_');
