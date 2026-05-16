import { useSyncExternalStore } from 'react';

const isOnline = (): boolean =>
  typeof navigator !== 'undefined' ? navigator.onLine : true;

function subscribeToOnlineStatus(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('online', callback);
  window.addEventListener('offline', callback);
  return () => {
    window.removeEventListener('online', callback);
    window.removeEventListener('offline', callback);
  };
}

export interface OnlineStatus {
  online: boolean;
  lastChange: number;
}

let lastChange = Date.now();

// Track timestamp of the last online/offline change process-wide.
// SSR-safe: only wires events in browser environments.
if (typeof window !== 'undefined') {
  const markChange = () => {
    lastChange = Date.now();
  };
  window.addEventListener('online', markChange);
  window.addEventListener('offline', markChange);
}

function getOnlineSnapshot(): OnlineStatus {
  return { online: isOnline(), lastChange };
}

/**
 * Returns the current online status and the timestamp of the last change.
 *
 * Uses `useSyncExternalStore` so the value is consistent across concurrent
 * React renders — no stale reads mid-flight.
 */
export function useOnlineStatus(): OnlineStatus {
  return useSyncExternalStore(
    subscribeToOnlineStatus,
    getOnlineSnapshot,
    // Server snapshot: assume online (avoids mismatched hydration)
    () => ({ online: true, lastChange: 0 }),
  );
}
