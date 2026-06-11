/**
 * React hooks for the OfflineMutationQueue.
 *
 * Both hooks read from OfflineQueueProvider context.
 * useQueueStatus uses useSyncExternalStore for React 18+ correctness.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type { QueueEvent } from './queue.ts';
import { useOfflineQueue } from './OfflineQueueProvider.tsx';

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

  const getQueuedSnapshot = useCallback((): number => queue.status().queued, [queue]);
  const getSendingSnapshot = useCallback((): boolean => queue.status().sending, [queue]);
  const getDeadLetteredSnapshot = useCallback((): number => queue.status().deadLettered, [queue]);

  const queued = useSyncExternalStore(subscribe, getQueuedSnapshot, getServerZero);
  const sending = useSyncExternalStore(subscribe, getSendingSnapshot, getServerFalse);
  const deadLettered = useSyncExternalStore(subscribe, getDeadLetteredSnapshot, getServerZero);

  return useMemo(() => ({ queued, sending, deadLettered }), [queued, sending, deadLettered]);
}

const getServerZero = (): number => 0;
const getServerFalse = (): boolean => false;

// ---------------------------------------------------------------------------
// useOfflineMutation
// ---------------------------------------------------------------------------

export interface UseOfflineMutationOptions {
  /**
   * Dot-path of the procedure on the server router (e.g. `['highlights', 'create']`).
   *
   * Kept explicit rather than inferred because oRPC's client erases path metadata
   * at the leaf — the procedure callable carries the path only in a closure.
   */
  path: readonly string[];
}

export interface UseOfflineMutationResult<TInput> {
  mutate: (input: TInput) => Promise<{ idempotencyKey: string }>;
  isQueued: boolean;
}

/**
 * Enqueues a mutation by procedure path. The replay loop uses the queue's
 * configured `rpc.call(path, input, headers)` to actually invoke the server.
 *
 * The caller's server-side procedure MUST be marked with `.use(offlineSafe())`
 * — otherwise replays are not deduped. There is no compile-time enforcement
 * of this contract (oRPC client procedures do not carry meta typings); it is
 * the developer's responsibility to keep client and server in sync.
 */
export function useOfflineMutation<TInput = unknown>(
  options: UseOfflineMutationOptions,
): UseOfflineMutationResult<TInput> {
  const { queue } = useOfflineQueue();
  const status = useQueueStatus();
  const { path } = options;

  const mutate = useCallback(
    async (input: TInput): Promise<{ idempotencyKey: string }> => {
      const result = await queue.enqueue<TInput>({ path, input });
      return { idempotencyKey: result.idempotencyKey };
    },
    [queue, path],
  );

  return {
    mutate,
    isQueued: status.queued > 0,
  };
}
