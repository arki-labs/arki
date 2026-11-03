/**
 * GoogleInfoWindow - Wrapper for InfoWindow
 *
 * This component wraps @vis.gl/react-google-maps' InfoWindow with:
 * - Simplified positioning
 * - Better close handling
 */

import type { ReactNode } from 'react';
import { InfoWindow } from '@vis.gl/react-google-maps';

import type { Coordinates } from '../types/index.js';

export type GoogleInfoWindowProps = {
  /**
   * Info window position (where it should appear)
   */
  position: Coordinates;

  /**
   * Called when the close button is clicked
   */
  onClose?: () => void;

  /**
   * Info window content
   */
  children: ReactNode;

  /**
   * Pixel offset from the position
   */
  pixelOffset?: [number, number];

  /**
   * Maximum width in pixels
   */
  maxWidth?: number;

  /**
   * Additional className for styling
   */
  className?: string;

  /**
   * Custom header text
   */
  headerContent?: ReactNode;

  /**
   * Whether to show close button
   * @default true
   */
  shouldFocus?: boolean;
}

/**
 * GoogleInfoWindow component
 *
 * Displays an info window at the specified position.
 *
 * @example
 * ```tsx
 * const [selectedMarker, setSelectedMarker] = useState(null);
 *
 * <GoogleMarker
 *   position={coords}
 *   onClick={() => setSelectedMarker(coords)}
 * >
 *   <GooglePin />
 * </GoogleMarker>
 *
 * {selectedMarker && (
 *   <GoogleInfoWindow
 *     position={selectedMarker}
 *     onClose={() => setSelectedMarker(null)}
 *   >
 *     <div>
 *       <h3>Location Details</h3>
 *       <p>Lat: {selectedMarker.lat}</p>
 *       <p>Lng: {selectedMarker.lng}</p>
 *     </div>
 *   </GoogleInfoWindow>
 * )}
 * ```
 */
export function GoogleInfoWindow({
  position,
  onClose,
  children,
  pixelOffset,
  maxWidth = 300,
  className,
  headerContent,
  shouldFocus = true,
}: GoogleInfoWindowProps) {
  return (
    <InfoWindow
      position={position}
      onClose={onClose}
      pixelOffset={pixelOffset}
      maxWidth={maxWidth}
      headerContent={headerContent}
      shouldFocus={shouldFocus}
      className={className}
    >
      {children}
    </InfoWindow>
  );
}
