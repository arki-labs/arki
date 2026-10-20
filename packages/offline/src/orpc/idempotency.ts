import type { Meta } from '@orpc/contract';
import type { Middleware, ORPCErrorConstructorMap } from '@orpc/server';
import { ORPCError } from '@orpc/server';

import { getLogger } from '@arki/log';
import { isFailure } from '@arki/failure';

import type { IdempotencyRepository } from './idempotency-repository';

const log = getLogger('arki:offline:orpc');

/** What the middleware reads from the request context. */
export type IdempotentContext = {
  readonly headers: Headers;
  readonly session: { readonly user: { readonly id: string } } | null | undefined;
};

/** The two calls the middleware makes. `IdempotencyRepository` is the Postgres one. */
export type IdempotencyStore = Pick<IdempotencyRepository, 'find' | 'store'>;

/**
 * oRPC middleware that deduplicates replayed offline mutations. Install it
 * ONCE where the app builds its implementer:
 *
 *   implement(rpcContract).$context<RequestContext>().use(idempotency(repo))
 *
 * It acts only on procedures whose contract meta says `offlineSafe: true`
 * (see `offlineSafe(p)`); every other procedure passes straight through.
 * For a marked one:
 *
 * 1. Reads `Idempotency-Key` from the request headers; no key → runs the
 *    handler as usual (not a queued replay).
 * 2. A queued replay carries `Offline-Actor`: the user who queued the write.
 *    It must equal the session user (both absent counts as equal). Otherwise
 *    → 403 FORBIDDEN, which the client queue dead-letters. This catches what
 *    the browser cannot: a session cookie that changed between the queue's
 *    own actor check and the request leaving the browser. A missing header
 *    with a signed-in session is refused too.
 * 3. No signed-in user → runs the handler (the cache is scoped to a user).
 * 4. A stored response for (key, path, userId) within the 7-day TTL → returns
 *    it without calling the handler.
 * 5. Otherwise runs the handler and stores its output.
 *
 * Best-effort under concurrency: two replays of one key that arrive together
 * can both run the handler (lookup, run and store are separate steps).
 */
export function idempotency(
  repo: IdempotencyStore,
): Middleware<IdempotentContext, Record<never, never>, unknown, unknown, ORPCErrorConstructorMap<Record<never, never>>, Meta> {
  return async ({ context, path, procedure, next }, _input, output) => {
    if (procedure['~orpc'].meta.offlineSafe !== true) return next();

    const idempotencyKey = context.headers.get('Idempotency-Key');
    if (!idempotencyKey) return next();

    const userId = context.session?.user.id;
    const queuedBy = context.headers.get('Offline-Actor');
    if ((queuedBy ?? undefined) !== userId) {
      log.debug('refused a replay of {path}: queued by another actor than the session', { path: path.join('.') });
      throw new ORPCError('FORBIDDEN', { message: 'Queued under another account; not run under the account signed in now' });
    }
    if (!userId) return next();

    const procedurePath = path.join('.');
    const cached = await repo.find(idempotencyKey, procedurePath, userId);
    if (cached !== null) {
      log.debug('replay of {procedurePath} answered from the idempotency cache', { procedurePath });
      return output(cached);
    }

    const result = await next();
    try {
      const stored = await repo.store(idempotencyKey, procedurePath, userId, result.output);
      if (isFailure(stored)) {
        log.warn('could not cache the completed response: {code}', { code: stored.code });
        return result;
      }
      log.debug('stored the response of {procedurePath} for replays', { procedurePath });
    } catch {
      // Custom stores/reporters may still throw. Neither can replace the completed response.
      try { log.warn('could not cache the completed response'); } catch { /* Best-effort reporting. */ }
    }
    return result;
  };
}
