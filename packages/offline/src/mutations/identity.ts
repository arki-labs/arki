import { defineId } from '@arki/contracts';
import type { IdOf } from '@arki/contracts';

const format = { alphabet: '_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', length: 21 } as const;

/** Browser queue identity; the existing unprefixed Nano ID representation is unchanged. */
export const queuedMutationId = defineId('', { kind: 'offline.queued-mutation', format });
export type QueuedMutationId = IdOf<typeof queuedMutationId>;

/** Transport deduplication identity, distinct from queue and server cache-record identities. */
export const mutationIdempotencyKey = defineId('', { kind: 'offline.mutation-idempotency-key', format });
export type MutationIdempotencyKey = IdOf<typeof mutationIdempotencyKey>;
