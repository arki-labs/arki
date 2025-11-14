/**
 * StreetViewPanorama component
 *
 * Displays Google Street View at a given location.
 * Must be used inside GoogleMapsProvider.
 */

'use client';

import { useEffect, useId } from 'react';

import type { Coordinates } from '../../types';

export interface StreetViewPanoramaProps {
  /**
   * Location to display Street View
   */
  location: Coordinates;

  /**
   * Point of view configuration
   */
  pov?: {
    heading: number;
    pitch: number;
  };

  /**
   * Initial zoom level
   * @default 1
   */
  zoom?: number;

  /**
   * Custom container ID (auto-generated if not provided)
   */
  containerId?: string;

  /**
   * Container className
   */
  className?: string;
}

/**
 * StreetViewPanorama component
 *
 * Renders a Google Street View panorama at the specified location.
 *
 * @example
 * ```tsx
 * <StreetViewPanorama
 *   location={{ lat: 37.7749, lng: -122.4194 }}
 *   pov={{ heading: 34, pitch: 10 }}
 *   zoom={1}
 * />
 * ```
 */
export function StreetViewPanorama({
  location,
  pov = { heading: 34, pitch: 10 },
  zoom = 1,
  containerId: customContainerId,
  className = 'h-full w-full',
}: StreetViewPanoramaProps) {
  const autoId = useId();
  const containerId = customContainerId || `street-view-${autoId}`;

  useEffect(() => {
    if (typeof google !== 'undefined' && google.maps?.StreetViewPanorama) {
      const container = document.getElementById(containerId);

      if (container) {
        new google.maps.StreetViewPanorama(container, {
          position: location,
          pov,
          zoom,
        });
      }
    }
  }, [location, containerId, pov, zoom]);

  return <div id={containerId} className={className} />;
}
