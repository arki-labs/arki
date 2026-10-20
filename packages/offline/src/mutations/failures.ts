import { ID_GENERATION_FAILURES, z } from '@arki/contracts';
import { defineFailure, UnexpectedDefect } from '@arki/failure';
import type { FailureOf } from '@arki/failure';

import { mutationIdempotencyKey, queuedMutationId } from './identity.ts';

/**
 * @fix Restore access to local storage before attempting another enqueue.
 * @verify bun run test -- __tests__/mutations/queue.test.ts
 */
export const QueueStorageUnavailable = defineFailure('offline.queue_storage_unavailable', {
  status: 503,
  message: 'The existing offline queue could not be read.',
  remediation: 'Restore local storage access and inspect existing data before enqueueing again.',
});

/**
 * @fix Reconcile this identity before retry; a write or remote effect may already exist.
 * @verify bun run test -- __tests__/mutations/queue.test.ts
 */
export const QueueAcceptanceUnconfirmed = defineFailure('offline.queue_acceptance_unconfirmed', {
  status: 503,
  data: z.object({ id: queuedMutationId.schema, idempotencyKey: mutationIdempotencyKey.schema }),
  message: 'The queued mutation outcome could not be confirmed.',
  remediation: 'Reconcile the queue and server using this idempotency key. Never enqueue the same effect with a new key blindly.',
});

/** @fix Preserve the original bytes and repair or explicitly discard invalid local data.
 * @verify bun run test -- __tests__/mutations/queue.test.ts __tests__/mutations/replay.test.ts __tests__/mutations/storage.test.ts
 */
export const QueueStorageCorrupt = defineFailure('offline.queue_storage_corrupt', {
  status: 500,
  message: 'Stored offline data does not match its persistence contract.',
  remediation: 'Preserve the original bytes; repair or explicitly discard the invalid local data before continuing.',
});

/** @fix Reconcile local state before retrying a write whose acknowledgement was lost.
 * @verify bun run test -- __tests__/mutations/queue.test.ts __tests__/mutations/replay.test.ts __tests__/mutations/storage.test.ts
 */
export const QueuePersistenceUnconfirmed = defineFailure('offline.queue_persistence_unconfirmed', {
  status: 503,
  message: 'A local offline-state write was not confirmed.',
  remediation: 'Read and reconcile local state before repeating this persistence operation.',
});

/** @fix Submit a serializable mutation input before retrying.
 * @verify bun run test -- __tests__/mutations/queue.test.ts __tests__/mutations/replay.test.ts __tests__/mutations/storage.test.ts
 */
export const QueueEncodingFailure = defineFailure('offline.queue_encoding_failure', {
  status: 400,
  message: 'Offline state could not be serialized.',
  remediation: 'Use a serializable mutation input before retrying; no persistence was attempted.',
});

/** @fix Reconcile the accepted server effect using the original idempotency identity.
 * @verify bun run test -- __tests__/mutations/queue.test.ts __tests__/mutations/replay.test.ts __tests__/mutations/storage.test.ts
 */
export const QueueEffectUnconfirmed = defineFailure('offline.queue_effect_unconfirmed', {
  status: 503,
  data: z.object({ id: queuedMutationId.schema, idempotencyKey: mutationIdempotencyKey.schema }),
  message: 'The server accepted the mutation, but local cleanup was not confirmed.',
  remediation: 'Reconcile the server effect using this idempotency key. Retry local cleanup, never enqueue a replacement effect blindly.',
});

/** @fix Restore connectivity; the queue owns retries using the original idempotency key.
 * @verify bun run test -- __tests__/mutations/queue.test.ts __tests__/mutations/replay.test.ts __tests__/mutations/storage.test.ts
 */
export const QueueTransportUnavailable = defineFailure('offline.queue_transport_unavailable', {
  status: 503,
  message: 'The RPC transport is temporarily unavailable.',
  remediation: 'Restore connectivity. Let the queue retry using the original idempotency key.',
});

export const QUEUE_STORAGE_FAILURES = [QueueStorageUnavailable, QueueStorageCorrupt, QueuePersistenceUnconfirmed, QueueEncodingFailure, UnexpectedDefect] as const;
export type QueueStorageFailure = FailureOf<(typeof QUEUE_STORAGE_FAILURES)[number]>;
export const DRAIN_FAILURES = [...QUEUE_STORAGE_FAILURES, QueueEffectUnconfirmed] as const;
export type DrainFailure = FailureOf<(typeof DRAIN_FAILURES)[number]>;
export const ENQUEUE_FAILURES = [...QUEUE_STORAGE_FAILURES, QueueAcceptanceUnconfirmed, ...ID_GENERATION_FAILURES] as const;
export type EnqueueFailure = FailureOf<(typeof ENQUEUE_FAILURES)[number]>;
export const OFFLINE_QUEUE_FAILURES = [...ENQUEUE_FAILURES, QueueEffectUnconfirmed] as const;
export type OfflineQueueFailure = FailureOf<(typeof OFFLINE_QUEUE_FAILURES)[number]>;
