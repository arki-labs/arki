import type { Meta } from '@orpc/contract';
import type { Middleware, ORPCErrorConstructorMap } from '@orpc/server';

import { getLogger } from '@arki/log';

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
 * 1. Reads `Idempotency-Key` from the request headers; no key or no signed-in
 *    user → runs the handler as usual.
 * 2. A stored response for (key, path, userId) within the 7-day TTL → returns
 *    it without calling the handler.
 * 3. Otherwise runs the handler and stores its output.
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
    const userId = context.session?.user.id;
    if (!idempotencyKey || !userId) return next();

    const procedurePath = path.join('.');
    const cached = await repo.find(idempotencyKey, procedurePath, userId);
    if (cached !== null) {
      log.debug('replay of {procedurePath} answered from the idempotency cache', { procedurePath });
      return output(cached);
    }

    const result = await next();
    try {
      await repo.store(idempotencyKey, procedurePath, userId, result.output);
      log.debug('stored the response of {procedurePath} for replays', { procedurePath });
    } catch (error) {
      // The handler already ran and the caller gets its answer; only a later replay loses the dedupe.
      log.warn('could not store the response of {procedurePath} for replays: {error}', { procedurePath, error: error instanceof Error ? error : String(error) });
    }
    return result;
  };
}
