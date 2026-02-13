/**
 * useMapBounds hook
 *
 * Provides utilities for calculating and fitting map bounds.
 */

import { useCallback } from 'react';

import { DEFAULT_BOUNDS_PADDING, HIGHLIGHTED_BOUNDS_PADDING } from '../constants';
import type { Coordinates } from '../types';
import { useGoogleMap } from './useGoogleMap';
import { useApiIsLoaded } from './useApiIsLoaded';

export type UseMapBoundsOptions = {
  /**
   * Padding around bounds in pixels
   * @default 40
   */
  padding?: number;
}

/**
 * Hook to manage map bounds
 *
 * Provides utilities for calculating and fitting bounds to show multiple locations.
 *
 * @param options Configuration options
 * @returns Object with bounds utilities
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { fitBounds, fitToMarkers } = useMapBounds();
 *
 *   const markers = [
 *     { lat: 37.7749, lng: -122.4194 },
 *     { lat: 34.0522, lng: -118.2437 },
 *   ];
 *
 *   useEffect(() => {
 *     fitToMarkers(markers);
 *   }, [markers, fitToMarkers]);
 * }
 * ```
 */
export function useMapBounds(options: UseMapBoundsOptions = {}) {
  const { padding = DEFAULT_BOUNDS_PADDING } = options;

  const map = useGoogleMap();
  const isLoaded = useApiIsLoaded();

  /**
   * Fit the map to show all provided coordinates
   */
  const fitToMarkers = useCallback(
    (coordinates: Coordinates[], customPadding?: number) => {
      if (!map || !isLoaded || coordinates.length === 0) return;

      const bounds = new google.maps.LatLngBounds();

      for (const coord of coordinates) {
        bounds.extend(new google.maps.LatLng(coord.lat, coord.lng));
      }

      map.fitBounds(bounds, customPadding ?? padding);
    },
    [map, isLoaded, padding],
  );

  /**
   * Fit the map to show a specific set of coordinates with highlighted padding
   */
  const fitToHighlighted = useCallback(
    (coordinates: Coordinates[]) => {
      fitToMarkers(coordinates, HIGHLIGHTED_BOUNDS_PADDING);
    },
    [fitToMarkers],
  );

  /**
   * Calculate bounds for a set of coordinates
   */
  const calculateBounds = useCallback(
    (coordinates: Coordinates[]) => {
      if (!isLoaded || coordinates.length === 0) return null;

      const bounds = new google.maps.LatLngBounds();

      for (const coord of coordinates) {
        bounds.extend(new google.maps.LatLng(coord.lat, coord.lng));
      }

      return bounds;
    },
    [isLoaded],
  );

  return {
    fitToMarkers,
    fitToHighlighted,
    calculateBounds,
  };
}
