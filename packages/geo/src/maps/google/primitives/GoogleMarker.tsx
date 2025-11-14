/**
 * GoogleMarker - Wrapper for AdvancedMarker
 *
 * This component wraps @vis.gl/react-google-maps' AdvancedMarker with:
 * - Simplified coordinate handling
 * - Better click event handling
 */

import type { ReactNode } from 'react';
import { AdvancedMarker } from '@vis.gl/react-google-maps';

import type { Coordinates } from '../types';

export interface GoogleMarkerProps {
  /**
   * Marker position coordinates
   */
  position: Coordinates;

  /**
   * Called when marker is clicked
   */
  onClick?: () => void;

  /**
   * Marker content (e.g., Pin, custom HTML)
   */
  children?: ReactNode;

  /**
   * z-index for stacking order
   */
  zIndex?: number;

  /**
   * Additional className for styling
   */
  className?: string;

  /**
   * Title shown on hover
   */
  title?: string;
}

/**
 * GoogleMarker component
 *
 * Displays a marker on the map at the specified position.
 *
 * @example
 * ```tsx
 * // Basic marker with default pin
 * <GoogleMarker position={{ lat: 37.7749, lng: -122.4194 }}>
 *   <GooglePin />
 * </GoogleMarker>
 *
 * // Marker with custom content
 * <GoogleMarker
 *   position={{ lat: 37.7749, lng: -122.4194 }}
 *   onClick={() => console.log('Clicked!')}
 * >
 *   <div className="custom-marker">📍</div>
 * </GoogleMarker>
 * ```
 */
export function GoogleMarker({ position, onClick, children, zIndex, className, title }: GoogleMarkerProps) {
  return (
    <AdvancedMarker position={position} onClick={onClick} zIndex={zIndex} className={className} title={title}>
      {children}
    </AdvancedMarker>
  );
}
