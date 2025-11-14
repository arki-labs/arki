/**
 * useApiIsLoaded hook
 *
 * Checks if the Google Maps API has finished loading.
 */

import { useApiIsLoaded as useVisGlApiIsLoaded } from '@vis.gl/react-google-maps';

/**
 * Hook to check if the Google Maps API is loaded
 *
 * This hook re-exports useApiIsLoaded from @vis.gl/react-google-maps.
 *
 * @returns true if the API is fully loaded, false otherwise
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const apiLoaded = useApiIsLoaded();
 *
 *   if (!apiLoaded) {
 *     return <div>Loading Google Maps...</div>;
 *   }
 *
 *   return <GoogleMap />;
 * }
 * ```
 */
export function useApiIsLoaded() {
  return useVisGlApiIsLoaded();
}
