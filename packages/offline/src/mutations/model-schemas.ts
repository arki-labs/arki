/**
 * The schemas that check stored queue values. Internal: the storage and dead-letter store read and write with
 * them. The TS types (`model.ts`, `dead-letter.ts`) are the source; `__tests__/mutations/model.test-d.ts` locks
 * each schema to its type both ways.
 */
import { z } from '@arki/contracts';

import { mutationIdempotencyKey, queuedMutationId } from './identity.js';

/** A `QueuedMutation`. */
export const queuedMutationSchema = z.object({
  id: queuedMutationId.schema,
  idempotencyKey: mutationIdempotencyKey.schema,
  procedurePath: z.array(z.string()).readonly(),
  input: z.unknown(),
  actorId: z.string().nullable(),
  enqueuedAt: z.number().finite(),
  attempts: z.number().int().nonnegative(),
  lastError: z.object({ code: z.enum(['RETRY', 'MAX_RETRIES', 'ACTOR_MISMATCH']), message: z.string() }).optional(),
});

/** An `EnqueueReceipt`. */
export const enqueueReceiptSchema = z.object({
  idempotencyKey: mutationIdempotencyKey.schema,
  status: z.enum(['queued', 'sent', 'dead-letter']),
});

/** A `DeadLetterEntry`. */
export const deadLetterEntrySchema = z.object({
  mutation: queuedMutationSchema,
  error: z.object({ message: z.string(), name: z.string() }),
  deadLetteredAt: z.number().finite(),
});
