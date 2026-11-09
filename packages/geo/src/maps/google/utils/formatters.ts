/**
 * Coordinate and map-related formatters
 */

import type { Coordinates } from '../types/index.js';
import { assertPrecision } from '../../../core/precision.js';

/**
 * Format coordinates to a readable string
 *
 * `precision` (default 4) is a finite number from 0 to 100; anything else throws the invariant
 * failure `ARKI_FAILURE_E008`, a caller bug.
 *
 * @example
 * formatCoordinates({ lat: 37.7749, lng: -122.4194 })
 * // Returns: "37.7749, -122.4194"
 */
export function formatCoordinates(coords: Coordinates, precision = 4): string {
  assertPrecision('formatCoordinates', precision);
  return `${coords.lat.toFixed(precision)}, ${coords.lng.toFixed(precision)}`;
}

/**
 * Format coordinates with cardinal directions
 *
 * `precision` (default 4) is a finite number from 0 to 100; anything else throws the invariant
 * failure `ARKI_FAILURE_E008`, a caller bug.
 *
 * @example
 * formatCoordinatesWithCardinals({ lat: 37.7749, lng: -122.4194 })
 * // Returns: "37.7749°N, 122.4194°W"
 */
export function formatCoordinatesWithCardinals(coords: Coordinates, precision = 4): string {
  assertPrecision('formatCoordinatesWithCardinals', precision);
  const lat = Math.abs(coords.lat).toFixed(precision);
  const lng = Math.abs(coords.lng).toFixed(precision);
  const latDir = coords.lat >= 0 ? 'N' : 'S';
  const lngDir = coords.lng >= 0 ? 'E' : 'W';

  return `${lat}°${latDir}, ${lng}°${lngDir}`;
}

/**
 * Format zoom level to descriptive text
 */
export function formatZoomLevel(zoom: number): string {
  if (zoom < 3) return 'World';
  if (zoom < 7) return 'Continent';
  if (zoom < 10) return 'Country';
  if (zoom < 13) return 'City';
  if (zoom < 16) return 'Street';
  return 'Building';
}

export { parseCoordinates } from '../../../core/coordinates.js';
