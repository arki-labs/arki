/**
 * Coordinate and map-related formatters
 */

import type { Coordinates } from '../types';

/**
 * Format coordinates to a readable string
 *
 * @example
 * formatCoordinates({ lat: 37.7749, lng: -122.4194 })
 * // Returns: "37.7749, -122.4194"
 */
export function formatCoordinates(coords: Coordinates, precision = 4): string {
  return `${coords.lat.toFixed(precision)}, ${coords.lng.toFixed(precision)}`;
}

/**
 * Format coordinates with cardinal directions
 *
 * @example
 * formatCoordinatesWithCardinals({ lat: 37.7749, lng: -122.4194 })
 * // Returns: "37.7749°N, 122.4194°W"
 */
export function formatCoordinatesWithCardinals(coords: Coordinates, precision = 4): string {
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

/**
 * Parse coordinates from string
 *
 * @example
 * parseCoordinates("37.7749, -122.4194")
 * // Returns: { lat: 37.7749, lng: -122.4194 }
 */
export function parseCoordinates(coordString: string): Coordinates | null {
  const parts = coordString.split(',').map(s => s.trim());

  if (parts.length !== 2) return null;

  const lat = Number.parseFloat(parts[0]!);
  const lng = Number.parseFloat(parts[1]!);

  if (isNaN(lat) || isNaN(lng)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lng < -180 || lng > 180) return null;

  return { lat, lng };
}
