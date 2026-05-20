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

// Cached snapshot — useSyncExternalStore compares with Object.is, so we MUST
// return the same reference until the underlying state actually changes.
// Returning a fresh object on every call triggers React error #185
// ("Maximum update depth exceeded").
let cachedSnapshot: OnlineStatus = {
  online: isOnline(),
  lastChange: Date.now(),
};

// Refresh the cached snapshot on online/offline events. SSR-safe: only wires
// listeners in browser environments.
if (typeof window !== 'undefined') {
  const refresh = () => {
    cachedSnapshot = { online: isOnline(), lastChange: Date.now() };
  };
  window.addEventListener('online', refresh);
  window.addEventListener('offline', refresh);
}

function getOnlineSnapshot(): OnlineStatus {
  return cachedSnapshot;
}

// Stable server snapshot — referentially constant across renders so the
// useSyncExternalStore contract holds during SSR/hydration.
const SERVER_SNAPSHOT: OnlineStatus = { online: true, lastChange: 0 };
const getServerSnapshot = (): OnlineStatus => SERVER_SNAPSHOT;

/**
 * Returns the current online status and the timestamp of the last change.
 *
 * Uses `useSyncExternalStore` so the value is consistent across concurrent
 * React renders — no stale reads mid-flight.
 */
export function useOnlineStatus(): OnlineStatus {
  return useSyncExternalStore(subscribeToOnlineStatus, getOnlineSnapshot, getServerSnapshot);
}
