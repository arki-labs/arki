/**
 * React context provider for OfflineMutationQueue.
 *
 * Wrap your app (or the relevant subtree) with this provider so that
 * useOfflineMutation and useQueueStatus can access the queue instance.
 *
 * @example
 * ```tsx
 * const queue = createOfflineMutationQueue({ rpc: myRpcClient, actorId: () => signedInUserId });
 *
 * function App() {
 *   return (
 *     <OfflineQueueProvider queue={queue}>
 *       <YourApp />
 *     </OfflineQueueProvider>
 *   );
 * }
 * ```
 */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import type { OfflineMutationQueue } from './queue.ts';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface OfflineQueueContextValue {
  queue: OfflineMutationQueue;
}

const OfflineQueueContext = createContext<OfflineQueueContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface OfflineQueueProviderProps {
  queue: OfflineMutationQueue;
  children: ReactNode;
}

export function OfflineQueueProvider({
  queue,
  children,
}: OfflineQueueProviderProps): React.JSX.Element {
  return (
    <OfflineQueueContext.Provider value={{ queue }}>
      {children}
    </OfflineQueueContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Context hook
// ---------------------------------------------------------------------------

export function useOfflineQueue(): OfflineQueueContextValue {
  const ctx = useContext(OfflineQueueContext);
  if (!ctx) {
    throw new Error(
      'useOfflineQueue must be used within an <OfflineQueueProvider>. ' +
        'Wrap your app with <OfflineQueueProvider queue={queue}> to fix this.',
    );
  }
  return ctx;
}

/**
 * Like `useOfflineQueue` but returns `null` when no provider is present.
 * Use this in components that are queue-optional (e.g. `OfflineBanner`).
 */
export function useOfflineQueueOptional(): OfflineQueueContextValue | null {
  return useContext(OfflineQueueContext);
}
