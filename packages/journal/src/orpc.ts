/**
 * `@orpc/server` adapter: what an oRPC client sees when a command fails.
 *
 * - `toORPCError(error)` maps one error.
 * - `commandErrors()` is the middleware that maps whatever a procedure throws.
 *
 * `@orpc/server` is an optional peer. Import this module only in an app that
 * serves oRPC. May import `errors` only; this is the one file that may import
 * `@orpc/server`.
 */
import { ORPCError, os } from '@orpc/server';

import { CommandError, isJournalError } from './errors.js';

/**
 * Another request changed the same entity first, or the client's `expectedVersion`
 * is behind. Nothing was written. Repeating the same request as it stands fails
 * again when a version was given, so the client reloads first. The journal's own
 * message names the entity kind and id; the client does not get those.
 */
const CONFLICT_MESSAGE = 'This was changed by another request. Reload the current state and try again.';

/**
 * - A `CommandError` becomes the `ORPCError` with the same code and message.
 * - A `JournalError` with code `CONFLICT` becomes an `ORPCError('CONFLICT')`, a 409 the client can retry.
 * - Anything else is returned unchanged: the app decides what it means.
 *
 * The original error is NOT attached as `cause`. The journal's message names the entity kind and
 * id, and a host may log or serialize a cause. A host that wants the original logs it itself,
 * in a middleware placed inside this one.
 */
export function toORPCError(error: unknown): unknown {
  if (error instanceof CommandError) {
    return new ORPCError(error.code, { message: error.message });
  }
  if (isJournalError(error, 'CONFLICT')) {
    return new ORPCError('CONFLICT', { message: CONFLICT_MESSAGE });
  }
  return error;
}

/**
 * The middleware form of `toORPCError`. Add it once to the app's procedure
 * builders, and no procedure needs a try/catch around a command.
 *
 * Order: put it INSIDE the app's own error middleware, so after it in the
 * chain: `os.use(appErrors).use(commandErrors())`. A rejected rule is then
 * already an `ORPCError` when the app's middleware sees it, and passes. Placed
 * before it, the app's middleware sees a plain error first and answers 500.
 */
export function commandErrors() {
  return os.middleware(async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      throw toORPCError(error);
    }
  });
}
