import { useSyncExternalStore } from 'react';

// Test the features, not `window`: React Native sets `window = global` and a `navigator` with neither
// `onLine` nor events. There `onLine` is undefined, so it counts as online.
const isOnline = (): boolean =>
  typeof navigator === 'undefined' || navigator.onLine !== false;

const hasOnlineEvents = typeof globalThis.addEventListener === 'function';

function subscribeToOnlineStatus(callback: () => void): () => void {
  if (!hasOnlineEvents) return () => {
    /* nothing to unsubscribe */
  };
  globalThis.addEventListener('online', callback);
  globalThis.addEventListener('offline', callback);
  return () => {
    globalThis.removeEventListener('online', callback);
    globalThis.removeEventListener('offline', callback);
  };
}

export type OnlineStatus = {
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
// listeners where the global object has events (browsers).
if (hasOnlineEvents) {
  const refresh = () => {
    cachedSnapshot = { online: isOnline(), lastChange: Date.now() };
  };
  globalThis.addEventListener('online', refresh);
  globalThis.addEventListener('offline', refresh);
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
