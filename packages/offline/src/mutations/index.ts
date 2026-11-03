/**
 * @arki/offline/mutations
 *
 * IDB-backed offline mutation queue with FIFO replay, strict idempotency,
 * dead-letter handling, and React hooks.
 */

// Core types and factory
export type {
  QueuedMutation,
  QueueErrorCode,
  QueueEvent,
  AnyRpcClient,
  OfflineSafeOperation,
  OfflineMutationQueueOptions,
  OfflineMutationQueue,
} from './queue.js';
export { createOfflineMutationQueue } from './queue.js';

// Storage primitives (exported for testing / custom integrations)
export type { QueueStorage } from './storage.js';
export { createQueueStorage } from './storage.js';

// Dead-letter store
export type { DeadLetterStore, DeadLetterEntry } from './dead-letter.js';
export { createDeadLetterStore } from './dead-letter.js';

// Replay loop
export type { ReplayLoop, ReplayLoopOptions } from './replay.js';
export { createReplayLoop } from './replay.js';

// React provider + context hook
export type { OfflineQueueProviderProps } from './OfflineQueueProvider.js';
export { OfflineQueueProvider, useOfflineQueue } from './OfflineQueueProvider.js';

// React hooks
export type { QueueStatus, UseOfflineMutationResult } from './hooks.js';
export { useQueueStatus, useOfflineMutation } from './hooks.js';

export { queuedMutationId, mutationIdempotencyKey } from './identity.js';
export type { QueuedMutationId, MutationIdempotencyKey } from './identity.js';
export { ENQUEUE_FAILURES, DRAIN_FAILURES, QUEUE_STORAGE_FAILURES, OFFLINE_QUEUE_FAILURES, QueueStorageUnavailable, QueueAcceptanceUnconfirmed, QueueStorageCorrupt, QueuePersistenceUnconfirmed, QueueEncodingFailure, QueueEffectUnconfirmed, QueueTransportUnavailable } from './failures.js';
export type { EnqueueFailure, DrainFailure, QueueStorageFailure, OfflineQueueFailure } from './failures.js';
export type { EnqueueReceipt, QueueSnapshot } from './queue.js';
