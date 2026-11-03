/**
 * GoogleMap - Wrapper for Map component
 *
 * This component wraps @vis.gl/react-google-maps' Map component with:
 * - Sensible defaults for common use cases
 * - Simplified coordinate handling
 * - Better click event handling
 */

import type { ReactNode } from 'react';
import { Map } from '@vis.gl/react-google-maps';

import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ID, DEFAULT_MAP_ZOOM } from '../constants.js';
import type { Coordinates } from '../types/index.js';
import type { MapCameraChangedEvent, MapMouseEvent } from '../types/index.js';

export type GoogleMapProps = {
  /**
   * Map center coordinates
   * @default { lat: 20, lng: 0 }
   */
  center?: Coordinates;

  /**
   * Map zoom level (0-21)
   * @default 2
   */
  zoom?: number;

  /**
   * Map ID for styling
   * @default 'arki-map'
   */
  mapId?: string;

  /**
   * Map type
   * @default 'roadmap'
   */
  mapTypeId?: 'roadmap' | 'satellite' | 'hybrid' | 'terrain';

  /**
   * Gesture handling mode
   * @default 'greedy'
   */
  gestureHandling?: 'greedy' | 'cooperative' | 'none';

  /**
   * Whether to disable default UI controls
   * @default true
   */
  disableDefaultUI?: boolean;

  /**
   * Whether to disable clickable POI icons
   * @default true
   */
  clickableIcons?: boolean;

  /**
   * Called when user clicks the map
   */
  onClick?: (coords: Coordinates, event: MapMouseEvent) => void;

  /**
   * Called when the camera (center/zoom) changes
   */
  onCameraChanged?: (event: MapCameraChangedEvent) => void;

  /**
   * Child elements (markers, info windows, etc.)
   */
  children?: ReactNode;

  /**
   * Additional className for styling
   */
  className?: string;

  /**
   * Map container style
   */
  style?: React.CSSProperties;
}

/**
 * GoogleMap component
 *
 * A simplified wrapper around Google Maps with sensible defaults.
 *
 * @example
 * ```tsx
 * <GoogleMap
 *   center={{ lat: 37.7749, lng: -122.4194 }}
 *   zoom={12}
 *   onClick={(coords) => console.log('Clicked:', coords)}
 * >
 *   <GoogleMarker position={{ lat: 37.7749, lng: -122.4194 }} />
 * </GoogleMap>
 * ```
 */
export function GoogleMap({
  center = DEFAULT_MAP_CENTER,
  zoom = DEFAULT_MAP_ZOOM,
  mapId = DEFAULT_MAP_ID,
  mapTypeId = 'roadmap',
  gestureHandling = 'greedy',
  disableDefaultUI = true,
  clickableIcons = false,
  onClick,
  onCameraChanged,
  children,
  className,
  style = { width: '100%', height: '100%' },
}: GoogleMapProps) {
  const handleClick = (event: MapMouseEvent) => {
    if (onClick && event.detail.latLng) {
      const coords: Coordinates = {
        lat: event.detail.latLng.lat,
        lng: event.detail.latLng.lng,
      };
      onClick(coords, event);
    }
  };

  return (
    <Map
      mapId={mapId}
      defaultCenter={center}
      defaultZoom={zoom}
      mapTypeId={mapTypeId}
      gestureHandling={gestureHandling}
      disableDefaultUI={disableDefaultUI}
      clickableIcons={clickableIcons}
      onClick={handleClick}
      onCameraChanged={onCameraChanged}
      className={className}
      style={style}
    >
      {children}
    </Map>
  );
}
