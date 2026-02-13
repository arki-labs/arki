import { InvalidCoordinatesError } from './errors';
import type { Coordinates } from './types';

/**
 * Validate if coordinates are within valid ranges
 * @param coords - Coordinates to validate
 * @returns true if valid
 * @throws InvalidCoordinatesError if invalid
 */
export function isValidCoordinates(coords: Coordinates): boolean {
  if (typeof coords !== 'object' || coords === null) {
    return false;
  }

  if (typeof coords.lat !== 'number' || typeof coords.lng !== 'number') {
    return false;
  }

  if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) {
    return false;
  }

  if (coords.lat < -90 || coords.lat > 90) {
    return false;
  }

  if (coords.lng < -180 || coords.lng > 180) {
    return false;
  }

  return true;
}

/**
 * Validate coordinates and throw if invalid
 * @param coords - Coordinates to validate
 * @throws InvalidCoordinatesError if invalid
 */
export function validateCoordinates(coords: Coordinates): void {
  if (!isValidCoordinates(coords)) {
    throw new InvalidCoordinatesError(
      `Invalid coordinates: lat=${coords.lat}, lng=${coords.lng}. ` +
        'Latitude must be between -90 and 90, longitude between -180 and 180.',
    );
  }
}

/**
 * Normalize longitude to -180 to 180 range
 * @param lng - Longitude to normalize
 * @returns Normalized longitude
 */
export function normalizeLongitude(lng: number): number {
  while (lng > 180) lng -= 360;
  while (lng < -180) lng += 360;
  return lng;
}

/**
 * Normalize latitude to -90 to 90 range (clamped)
 * @param lat - Latitude to normalize
 * @returns Normalized latitude
 */
export function normalizeLatitude(lat: number): number {
  return Math.max(-90, Math.min(90, lat));
}

/**
 * Normalize coordinates to valid ranges
 * @param coords - Coordinates to normalize
 * @returns Normalized coordinates
 */
export function normalizeCoordinates(coords: Coordinates): Coordinates {
  return {
    lat: normalizeLatitude(coords.lat),
    lng: normalizeLongitude(coords.lng),
  };
}

/**
 * Format coordinates as a human-readable string
 * @param coords - Coordinates to format
 * @param precision - Number of decimal places (default: 6)
 * @returns Formatted string like "40.7128, -74.0060"
 */
export function formatCoordinates(coords: Coordinates, precision = 6): string {
  return `${coords.lat.toFixed(precision)}, ${coords.lng.toFixed(precision)}`;
}

/**
 * Format coordinates in Degrees, Minutes, Seconds (DMS) format
 * @param coords - Coordinates to format
 * @returns Formatted string like "40°42'46.3"N 74°00'21.6"W"
 */
export function formatCoordinatesDMS(coords: Coordinates): string {
  const formatDMS = (value: number, positive: string, negative: string): string => {
    const direction = value >= 0 ? positive : negative;
    const absolute = Math.abs(value);
    const degrees = Math.floor(absolute);
    const minutesDecimal = (absolute - degrees) * 60;
    const minutes = Math.floor(minutesDecimal);
    const seconds = (minutesDecimal - minutes) * 60;

    return `${degrees}°${minutes}'${seconds.toFixed(1)}"${direction}`;
  };

  const lat = formatDMS(coords.lat, 'N', 'S');
  const lng = formatDMS(coords.lng, 'E', 'W');

  return `${lat} ${lng}`;
}

/**
 * Parse coordinates from a string
 * Supports formats:
 * - "40.7128, -74.0060"
 * - "40.7128,-74.0060"
 * - "40.7128 -74.0060"
 * @param str - String to parse
 * @returns Parsed coordinates
 * @throws InvalidCoordinatesError if string cannot be parsed
 */
export function parseCoordinates(str: string): Coordinates {
  const cleaned = str.trim().replaceAll(/[,\s]+/g, ' ');
  const parts = cleaned.split(' ');

  if (parts.length !== 2) {
    throw new InvalidCoordinatesError(
      `Cannot parse coordinates from string: "${str}". Expected format: "lat, lng"`,
    );
  }

  const lat = Number.parseFloat(parts[0]!);
  const lng = Number.parseFloat(parts[1]!);

  const coords = { lat, lng };
  validateCoordinates(coords);

  return coords;
}

/**
 * Check if two coordinates are approximately equal
 * @param coords1 - First coordinate
 * @param coords2 - Second coordinate
 * @param epsilon - Maximum difference to consider equal (default: 0.000001, ~0.1m)
 * @returns true if coordinates are approximately equal
 */
export function coordinatesEqual(
  coords1: Coordinates,
  coords2: Coordinates,
  epsilon = 0.000_001,
): boolean {
  return (
    Math.abs(coords1.lat - coords2.lat) < epsilon &&
    Math.abs(coords1.lng - coords2.lng) < epsilon
  );
}

/**
 * Round coordinates to specified precision
 * @param coords - Coordinates to round
 * @param precision - Number of decimal places (default: 6)
 * @returns Rounded coordinates
 */
export function roundCoordinates(coords: Coordinates, precision = 6): Coordinates {
  const factor = 10 ** precision;
  return {
    lat: Math.round(coords.lat * factor) / factor,
    lng: Math.round(coords.lng * factor) / factor,
  };
}
