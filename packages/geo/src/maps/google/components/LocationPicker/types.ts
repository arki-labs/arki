/**
 * LocationPicker component types
 */

import type { Coordinates } from '../../types/index.js';

export type LocationPickerProps = {
  /**
   * Called when user selects a location by clicking the map
   */
  onLocationSelect: (coords: Coordinates) => void;

  /**
   * Currently selected location (controlled)
   */
  selectedLocation: Coordinates | null;

  /**
   * Optional actual/correct location to display
   */
  actualLocation?: Coordinates;

  /**
   * Whether to show the actual location marker
   * @default false
   */
  showActual?: boolean;

  /**
   * Whether the map is disabled (no clicking)
   * @default false
   */
  disabled?: boolean;

  /**
   * Additional className for the container
   */
  className?: string;

  /**
   * Whether to automatically center on selected location
   * @default false
   */
  centerOnSelected?: boolean;

  /**
   * Map zoom level (controlled)
   */
  zoom?: number;

  /**
   * Map center (controlled)
   */
  center?: Coordinates;

  /**
   * Called when zoom changes
   */
  onZoomChange?: (zoom: number) => void;

  /**
   * Called when center changes
   */
  onCenterChange?: (center: Coordinates) => void;

  /**
   * Color for selected location marker
   * @default '#3b82f6' (blue)
   */
  selectedMarkerColor?: string;

  /**
   * Color for actual location marker
   * @default '#22c55e' (green)
   */
  actualMarkerColor?: string;

  /**
   * Whether to enable Street View checking
   * @default false
   */
  enableStreetView?: boolean;
}
