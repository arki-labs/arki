import { ID_GENERATION_FAILURES } from '@arki/contracts';
import { defineFailure } from '@arki/failure';
import type { FailureOf } from '@arki/failure';

/**
 * The database did not confirm that the response was cached. It may have been saved.
 * @fix Reconcile the cache before retrying its write; never repeat the completed handler.
 * @verify bun run test -- __tests__/orpc/idempotency.pglite.test.ts
 */
export const IdempotencyStoreUnconfirmed = defineFailure('offline.idempotency_store_unconfirmed', {
  status: 503,
  message: 'The idempotency response cache write was not confirmed.',
  remediation: 'Reconcile the cache before retrying its write. Do not repeat the completed application operation.',
});

/** Exact failures returned by response-cache writes, including generation defects. */
export const IDEMPOTENCY_STORE_FAILURES = [IdempotencyStoreUnconfirmed, ...ID_GENERATION_FAILURES] as const;

/** Derived once from the canonical definitions. */
export type IdempotencyStoreFailure = FailureOf<(typeof IDEMPOTENCY_STORE_FAILURES)[number]>;
