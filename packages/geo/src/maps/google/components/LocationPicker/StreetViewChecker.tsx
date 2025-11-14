/**
 * StreetViewChecker component
 *
 * Checks if Street View is available at a given location.
 * Must be used inside GoogleMapsProvider.
 */

'use client';

import { useEffect } from 'react';

import type { Coordinates } from '../../types';
import { useApiIsLoaded } from '../../hooks';

export interface StreetViewCheckerProps {
  /**
   * Location to check for Street View availability
   */
  location: Coordinates;

  /**
   * Called when availability is determined
   */
  onAvailabilityChange: (available: boolean) => void;

  /**
   * Search radius in meters
   * @default 50
   */
  radius?: number;
}

/**
 * StreetViewChecker component
 *
 * Asynchronously checks if Google Street View is available at the specified location.
 *
 * @example
 * ```tsx
 * const [streetViewAvailable, setStreetViewAvailable] = useState(false);
 *
 * <StreetViewChecker
 *   location={{ lat: 37.7749, lng: -122.4194 }}
 *   onAvailabilityChange={setStreetViewAvailable}
 * />
 * ```
 */
export function StreetViewChecker({ location, onAvailabilityChange, radius = 50 }: StreetViewCheckerProps) {
  const apiIsLoaded = useApiIsLoaded();

  useEffect(() => {
    if (apiIsLoaded && typeof google !== 'undefined' && google.maps?.StreetViewService) {
      const streetViewService = new google.maps.StreetViewService();

      streetViewService.getPanorama(
        {
          location,
          radius,
        },
        (_data, status) => {
          const available = status === google.maps.StreetViewStatus.OK;
          onAvailabilityChange(available);
        },
      );
    }
  }, [apiIsLoaded, location, onAvailabilityChange, radius]);

  return null;
}
