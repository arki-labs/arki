import { defineId } from '@arki/contracts';
import type { IdOf } from '@arki/contracts';

/** Stored cache-record identity; distinct from the client's idempotency token. */
export const idempotencyKeyId = defineId('idk_', {
  kind: 'offline.idempotency-record',
  format: { alphabet: '_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', length: 21 },
});

/** Inferred from the canonical record schema; stored prefixes remain compatible. */
export type IdempotencyKeyId = IdOf<typeof idempotencyKeyId>;
