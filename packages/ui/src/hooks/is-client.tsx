/** `useIsClient`: false on the server and during hydration, true after the first effect. */
import { useSyncExternalStore } from 'react';

const subscribeToNothing = () => () => {
  /* The value never changes after hydration, so there is nothing to unsubscribe. */
};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/**
 * Hook to detect if we're on the client side after hydration.
 * Returns false during SSR and initial hydration, true after first effect runs.
 *
 * This is useful for:
 * - Conditionally rendering client-only content
 * - Avoiding hydration mismatches for dynamic content
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(subscribeToNothing, clientSnapshot, serverSnapshot);
}
