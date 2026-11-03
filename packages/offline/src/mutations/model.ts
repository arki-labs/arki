import { z } from '@arki/contracts';
import { mutationIdempotencyKey, queuedMutationId } from './identity.js';

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
export type QueuedMutation = z.output<typeof queuedMutationSchema>;
export type QueueErrorCode = NonNullable<QueuedMutation['lastError']>['code'];

export const enqueueReceiptSchema = z.object({
  idempotencyKey: mutationIdempotencyKey.schema,
  status: z.enum(['queued', 'sent', 'dead-letter']),
});
export type EnqueueReceipt = z.output<typeof enqueueReceiptSchema>;

