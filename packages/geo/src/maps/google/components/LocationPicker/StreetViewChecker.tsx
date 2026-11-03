/**
 * StreetViewChecker component
 *
 * Checks if Street View is available at a given location.
 * Must be used inside GoogleMapsProvider.
 */

'use client';

import { useEffect } from 'react';

import { getLogger } from '@arki/log';

import type { Coordinates } from '../../types/index.js';
import { useApiIsLoaded } from '../../hooks/index.js';

const log = getLogger('arki:geo');

export type StreetViewCheckerProps = {
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

      void streetViewService.getPanorama(
        {
          location,
          radius,
        },
        (_data, status) => {
          // The status values are the strings 'OK', 'ZERO_RESULTS' and 'UNKNOWN_ERROR'.
          const code: string = status;
          const available = code === 'OK';
          if (!available && code !== 'ZERO_RESULTS') {
            // ZERO_RESULTS means no Street View here; any other status is a lookup fault, not an answer.
            log.warn('Street View lookup failed with status {status}', { status });
          }
          onAvailabilityChange(available);
        },
      );
    }
  }, [apiIsLoaded, location, onAvailabilityChange, radius]);

  return null;
}
