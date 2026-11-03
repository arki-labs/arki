import { InvalidCoordinates } from './failures.js';
import type { Coordinates } from './types.js';

/**
 * Check whether coordinates are finite and within range
 * @param coords - Coordinates to validate
 * @returns true if valid
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
 * Validate coordinates
 * @param coords - Coordinates to validate
 * @returns the same coordinates, or `InvalidCoordinates` when out of range or not finite
 */
export function validateCoordinates(coords: Coordinates): Coordinates | InvalidCoordinates {
  if (isValidCoordinates(coords)) return coords;
  return InvalidCoordinates({
    reason:
      `lat=${coords.lat}, lng=${coords.lng}. ` +
      'Latitude must be between -90 and 90, longitude between -180 and 180.',
  });
}

/**
 * Normalize longitude to the -180 to 180 range by wrapping around the globe.
 * Runs in constant time for any finite input.
 * @param lng - Longitude to normalize
 * @returns Normalized longitude, or `InvalidCoordinates` when `lng` is not a finite number
 */
export function normalizeLongitude(lng: number): number | InvalidCoordinates {
  if (!Number.isFinite(lng)) {
    return InvalidCoordinates({ reason: `longitude ${lng} is not a finite number.` });
  }
  if (lng >= -180 && lng <= 180) return lng;
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  // 180 and -180 are the same meridian; keep +180 for +180 + k * 360.
  return wrapped === -180 && lng > 0 ? 180 : wrapped;
}

/**
 * Normalize latitude to -90 to 90 range (clamped)
 * @param lat - Latitude to normalize
 * @returns Normalized latitude, or `InvalidCoordinates` when `lat` is not a finite number
 */
export function normalizeLatitude(lat: number): number | InvalidCoordinates {
  if (!Number.isFinite(lat)) {
    return InvalidCoordinates({ reason: `latitude ${lat} is not a finite number.` });
  }
  return Math.max(-90, Math.min(90, lat));
}

/**
 * Normalize coordinates to valid ranges
 * @param coords - Coordinates to normalize
 * @returns Normalized coordinates, or `InvalidCoordinates` when a value is not finite
 */
export function normalizeCoordinates(coords: Coordinates): Coordinates | InvalidCoordinates {
  const lat = normalizeLatitude(coords.lat);
  if (InvalidCoordinates.is(lat)) return lat;
  const lng = normalizeLongitude(coords.lng);
  if (InvalidCoordinates.is(lng)) return lng;
  return { lat, lng };
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

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Parse coordinates from a string
 * Supports formats:
 * - "40.7128, -74.0060"
 * - "40.7128,-74.0060"
 * - "40.7128 -74.0060"
 * @param str - String to parse
 * @returns Parsed coordinates, or `InvalidCoordinates` when the text is not two plain decimal numbers in range
 */
export function parseCoordinates(str: string): Coordinates | InvalidCoordinates {
  const cleaned = str.trim().replaceAll(/[,\s]+/g, ' ');
  const parts = cleaned.split(' ');
  const [latText, lngText] = parts;

  if (
    parts.length !== 2 ||
    latText === undefined ||
    lngText === undefined ||
    !DECIMAL_NUMBER.test(latText) ||
    !DECIMAL_NUMBER.test(lngText)
  ) {
    return InvalidCoordinates({
      reason: `cannot parse "${str}". Expected format: "lat, lng" with plain decimal numbers.`,
    });
  }

  return validateCoordinates({ lat: Number(latText), lng: Number(lngText) });
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
