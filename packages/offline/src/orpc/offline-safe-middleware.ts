import debug from 'debug';
import type { Middleware } from '@orpc/server';

import type { IdempotencyRepository } from './idempotency-repository';

const log = debug('arki:offline:orpc');

type IdempotentContext = {
  headers: Headers;
  session: { user: { id: string } } | null | undefined;
};

/**
 * oRPC middleware that deduplicates replayed offline mutations.
 *
 * 1. Reads `Idempotency-Key` from the request header.
 * 2. If a cached response exists for (key, path, userId) within the 7-day TTL → returns it
 *    without calling the handler.
 * 3. If not found → runs the handler, caches the response on success.
 *
 * Procedures using this MUST also be marked with `.meta({ offlineSafe: true })` so the
 * client-side TypeScript enforcement knows they are safe to enqueue offline.
 */
export function offlineSafe(
  repo: IdempotencyRepository,
): Middleware<IdempotentContext, Record<never, never>, unknown, unknown, any, any> {
  return async ({ context, path, next }, _input, output) => {
    const idempotencyKey = context.headers.get('Idempotency-Key');
    const userId = context.session?.user?.id;

    if (!idempotencyKey || !userId) {
      return next();
    }

    const procedurePath = path.join('.');

    const cached = await repo.find(idempotencyKey, procedurePath, userId);
    if (cached !== null) {
      log('cache hit for key=%s path=%s', idempotencyKey, procedurePath);
      return output(cached as never);
    }

    const result = await next();

    try {
      await repo.store(idempotencyKey, procedurePath, userId, result.output);
      log('cached response for key=%s path=%s', idempotencyKey, procedurePath);
    } catch (err) {
      log('failed to cache response for key=%s: %o', idempotencyKey, err);
    }

    return result;
  };
}
