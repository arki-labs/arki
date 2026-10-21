import { useSyncExternalStore } from 'react';

function ignore(): void {
  // Nothing to unsubscribe from: the answer never changes after hydration.
}

const subscribeNever = () => ignore;

/** False on the server and during hydration, true after: controls that need JavaScript wait for it. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}
