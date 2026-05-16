/**
 * React hooks for the OfflineMutationQueue.
 *
 * Both hooks read from OfflineQueueProvider context.
 * useQueueStatus uses useSyncExternalStore for React 18+ correctness.
 */
import { useSyncExternalStore, useCallback } from 'react';

import type { OfflineSafeProcedure, InferOfflineSafeInput } from '../orpc/offline-safe-marker.ts';
import { useOfflineQueue } from './OfflineQueueProvider.tsx';
import type { QueueEvent } from './queue.ts';

// ---------------------------------------------------------------------------
// useQueueStatus
// ---------------------------------------------------------------------------

export interface QueueStatus {
  queued: number;
  sending: boolean;
  deadLettered: number;
}

/**
 * Subscribes to queue events and returns a live status snapshot.
 * Uses useSyncExternalStore for React 18+ concurrent-mode correctness.
 */
export function useQueueStatus(): QueueStatus {
  const { queue } = useOfflineQueue();

  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      return queue.subscribe((_event: QueueEvent) => {
        onStoreChange();
      });
    },
    [queue],
  );

  const getSnapshot = useCallback((): QueueStatus => {
    return queue.status();
  }, [queue]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// useOfflineMutation
// ---------------------------------------------------------------------------

export interface UseOfflineMutationResult<TProc extends OfflineSafeProcedure> {
  mutate: (input: InferOfflineSafeInput<TProc>) => Promise<{ idempotencyKey: string }>;
  isQueued: boolean;
}

/**
 * Returns a mutate function that enqueues the given offline-safe procedure.
 * isQueued reflects whether there are pending mutations in the queue.
 */
export function useOfflineMutation<TProc extends OfflineSafeProcedure>(
  procedure: TProc,
): UseOfflineMutationResult<TProc> {
  const { queue } = useOfflineQueue();

  const status = useQueueStatus();

  const mutate = useCallback(
    async (input: InferOfflineSafeInput<TProc>): Promise<{ idempotencyKey: string }> => {
      const result = await queue.enqueue(procedure, input);
      return { idempotencyKey: result.idempotencyKey };
    },
    [queue, procedure],
  );

  return {
    mutate,
    isQueued: status.queued > 0,
  };
}
