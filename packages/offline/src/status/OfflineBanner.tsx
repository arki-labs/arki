import type { ReactNode } from 'react';
import { useSyncExternalStore, useCallback } from 'react';
import { useOnlineStatus } from './useOnlineStatus.ts';
import { useOfflineQueueOptional } from '../mutations/OfflineQueueProvider.tsx';
import type { QueueEvent } from '../mutations/queue.ts';

export interface OfflineBannerState {
  online: boolean;
  queued: number;
  deadLettered: number;
}

export interface OfflineBannerProps {
  children: (state: OfflineBannerState) => ReactNode;
}

/**
 * Headless render-prop component that exposes offline + queue state to the caller.
 *
 * The caller owns all visual presentation — OfflineBanner only provides data.
 * This keeps @arki/offline decoupled from any particular design system.
 *
 * Works with or without `OfflineQueueProvider`. When no queue provider is present,
 * `queued` and `deadLettered` default to 0.
 *
 * @example
 * <OfflineBanner>
 *   {({ online, queued }) =>
 *     !online ? <Banner>You are offline — {queued} changes pending</Banner> : null
 *   }
 * </OfflineBanner>
 */
export function OfflineBanner({ children }: OfflineBannerProps): ReactNode {
  const { online } = useOnlineStatus();
  const queueCtx = useOfflineQueueOptional();

  // Wire queue events → re-render only when a queue is present.
  const subscribeToQueue = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (!queueCtx) return () => undefined;
      return queueCtx.queue.subscribe((_event: QueueEvent) => onStoreChange());
    },
    [queueCtx],
  );

  // Return primitives, not objects. useSyncExternalStore compares snapshots
  // with Object.is, so a fresh object literal on every call breaks the
  // contract and triggers React error #185 ("Maximum update depth exceeded").
  const getQueuedSnapshot = useCallback(
    () => (queueCtx ? queueCtx.queue.status().queued : 0),
    [queueCtx],
  );
  const getDeadLetteredSnapshot = useCallback(
    () => (queueCtx ? queueCtx.queue.status().deadLettered : 0),
    [queueCtx],
  );

  const queued = useSyncExternalStore(
    subscribeToQueue,
    getQueuedSnapshot,
    getServerZero,
  );
  const deadLettered = useSyncExternalStore(
    subscribeToQueue,
    getDeadLetteredSnapshot,
    getServerZero,
  );

  return children({ online, queued, deadLettered });
}

// Stable server-snapshot getter (referentially constant across renders).
const getServerZero = (): number => 0;
