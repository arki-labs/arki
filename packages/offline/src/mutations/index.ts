/**
 * @arki/offline/mutations
 *
 * IDB-backed offline mutation queue with FIFO replay, strict idempotency,
 * dead-letter handling, and React hooks.
 */

// Core types and factory
export type {
  QueuedMutation,
  QueueEvent,
  AnyRpcClient,
  EnqueueOptions,
  OfflineMutationQueueOptions,
  OfflineMutationQueue,
} from './queue.ts';
export { createOfflineMutationQueue } from './queue.ts';

// Storage primitives (exported for testing / custom integrations)
export type { QueueStorage } from './storage.ts';
export { createQueueStorage } from './storage.ts';

// Dead-letter store
export type { DeadLetterStore, DeadLetterEntry } from './dead-letter.ts';
export { createDeadLetterStore } from './dead-letter.ts';

// Replay loop
export type { ReplayLoop, ReplayLoopOptions } from './replay.ts';
export { createReplayLoop } from './replay.ts';

// React provider + context hook
export type { OfflineQueueProviderProps } from './OfflineQueueProvider.tsx';
export { OfflineQueueProvider, useOfflineQueue } from './OfflineQueueProvider.tsx';

// React hooks
export type {
  QueueStatus,
  UseOfflineMutationOptions,
  UseOfflineMutationResult,
} from './hooks.ts';
export { useQueueStatus, useOfflineMutation } from './hooks.ts';
