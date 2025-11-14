/**
 * useGoogleMaps hook
 *
 * Provides access to the Google Maps library with proper error handling.
 */

import { useMapsLibrary } from '@vis.gl/react-google-maps';

/**
 * Hook to access the Google Maps JavaScript API library
 *
 * This hook wraps useMapsLibrary from @vis.gl/react-google-maps
 * and provides better error handling.
 *
 * @returns The Google Maps library instance
 * @throws Error if the library hasn't loaded yet
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const maps = useGoogleMaps();
 *
 *   useEffect(() => {
 *     if (maps) {
 *       const bounds = new maps.LatLngBounds();
 *       // Use the maps library...
 *     }
 *   }, [maps]);
 * }
 * ```
 */
export function useGoogleMaps() {
  const mapsLibrary = useMapsLibrary('maps');

  return mapsLibrary;
}

/**
 * Type for the Google Maps library
 */
export type GoogleMapsLibrary = google.maps.MapsLibrary;
