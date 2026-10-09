import { useEffect, useState } from 'react';

/**
 * Hook to detect if we're on the client side after hydration.
 * Returns false during SSR and initial hydration, true after first effect runs.
 *
 * This is useful for:
 * - Conditionally rendering client-only content
 * - Avoiding hydration mismatches for dynamic content
 */
export function useIsClient(): boolean {
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  return isClient;
}
