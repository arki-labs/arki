import { z } from 'zod/v4';

/**
 * The id of a user: `usr_` followed by an id. Every package that refers to a user, whether or
 * not it owns the user table, uses this one type, so ids pass between packages without a
 * dependency between them.
 */
export type UserId = `usr_${string}`;

/** Validates a user id: a string that starts with `usr_`. */
export const userIdSchema = z.custom<UserId>(value => typeof value === 'string' && value.startsWith('usr_'), {
  message: 'Expected a user id: a string starting with "usr_"',
});
