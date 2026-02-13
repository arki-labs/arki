/**
 * Google Maps event type definitions
 */

import type { Coordinates } from '../../../core/types';

// Re-export event types from @vis.gl
export type { MapCameraChangedEvent, MapEvent, MapMouseEvent } from './primitives';

/**
 * Custom coordinate event (simplified from MapMouseEvent)
 */
export type CoordinateEvent = {
  /**
   * Clicked coordinates
   */
  coords: Coordinates;

  /**
   * Original event
   */
  domEvent: MouseEvent;
}

/**
 * Camera change details
 */
export type CameraChangeDetails = {
  /**
   * New center coordinates
   */
  center: Coordinates;

  /**
   * New zoom level
   */
  zoom: number;

  /**
   * New heading (0-360 degrees)
   */
  heading: number;

  /**
   * New tilt (0-90 degrees)
   */
  tilt: number;
}
