/**
 * useGoogleMap hook
 *
 * Provides access to the current map instance.
 */

import { useMap } from '@vis.gl/react-google-maps';

/**
 * Hook to access the current Google Map instance
 *
 * This hook wraps useMap from @vis.gl/react-google-maps.
 *
 * @returns The map instance (or null if not yet initialized)
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const map = useGoogleMap();
 *
 *   useEffect(() => {
 *     if (map) {
 *       map.setCenter({ lat: 37.7749, lng: -122.4194 });
 *       map.setZoom(12);
 *     }
 *   }, [map]);
 * }
 * ```
 */
export function useGoogleMap() {
  return useMap();
}

/**
 * Type for the Google Map instance
 */
export type GoogleMapInstance = google.maps.Map;
