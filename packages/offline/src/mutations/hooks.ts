/**
 * React hooks for the OfflineMutationQueue.
 *
 * Both hooks read from OfflineQueueProvider context.
 * useQueueStatus uses useSyncExternalStore for React 18+ correctness.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import type { Identified, InputOf } from '@arki/contracts/orpc';

import type { OfflineSafeOperation, QueueEvent } from './queue.ts';
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

export type UseOfflineMutationResult<TInput> = {
  readonly mutate: (input: TInput) => Promise<{ idempotencyKey: string }>;
  readonly isQueued: boolean;
};

/**
 * Queue calls to an offline-safe procedure. Pass its utils leaf from
 * `createOrpcUtils` — `useOfflineMutation(orpc.posts.create)`. It compiles
 * only when the contract marked the procedure `offlineSafe(p)`; the input
 * type comes from the contract. The replay loop sends each call with an
 * `Idempotency-Key`, which the server's `idempotency(repo)` middleware uses
 * to dedupe replays.
 */
export function useOfflineMutation<Op extends OfflineSafeOperation>(
  carrier: Identified<Op>,
): UseOfflineMutationResult<InputOf<Op>> {
  const { queue } = useOfflineQueue();
  const status = useQueueStatus();

  const mutate = useCallback(
    async (input: InputOf<Op>): Promise<{ idempotencyKey: string }> => {
      const result = await queue.enqueue(carrier, input);
      return { idempotencyKey: result.idempotencyKey };
    },
    [queue, carrier],
  );

  return {
    mutate,
    isQueued: status.queued > 0,
  };
}
