import { InvalidCoordinates } from './failures.js';
import { parseCoordinates } from './coordinates.js';
import type { Coordinates } from './types.js';

/**
 * Convert Degrees, Minutes, Seconds to Decimal Degrees
 * @param degrees - Degrees value
 * @param minutes - Minutes value (0-59)
 * @param seconds - Seconds value (0-59)
 * @param direction - Direction ('N', 'S', 'E', 'W')
 * @returns Decimal degrees
 */
export function dmsToDecimal(
  degrees: number,
  minutes: number,
  seconds: number,
  direction: 'N' | 'S' | 'E' | 'W',
): number {
  let decimal = degrees + minutes / 60 + seconds / 3600;

  if (direction === 'S' || direction === 'W') {
    decimal = -decimal;
  }

  return decimal;
}

/**
 * Convert Decimal Degrees to Degrees, Minutes, Seconds
 * @param decimal - Decimal degrees value
 * @returns Object with degrees, minutes, seconds, and direction
 */
export function decimalToDMS(decimal: number): {
  degrees: number;
  minutes: number;
  seconds: number;
  direction: 'N' | 'S' | 'E' | 'W';
} {
  const absolute = Math.abs(decimal);
  const degrees = Math.floor(absolute);
  const minutesDecimal = (absolute - degrees) * 60;
  const minutes = Math.floor(minutesDecimal);
  const seconds = (minutesDecimal - minutes) * 60;

  // Determine direction based on whether it's latitude or longitude
  // This is a simplified version - caller should specify if lat or lng
  const direction = decimal >= 0 ? ('N' as const) : ('S' as const);

  return {
    degrees,
    minutes,
    seconds,
    direction,
  };
}

/**
 * Convert coordinates from one format to Google Maps format
 * Handles various input formats:
 * - {latitude, longitude}
 * - {lat, lng}
 * - {lat, lon}
 * @param coords - Coordinates in any common format
 * @returns Standardized coordinates {lat, lng}, or `InvalidCoordinates` when a value is missing
 */
export function toStandardCoordinates(coords: {
  lat?: number;
  lng?: number;
  lon?: number;
  latitude?: number;
  longitude?: number;
}): Coordinates | InvalidCoordinates {
  const lat = coords.lat ?? coords.latitude;
  const lng = coords.lng ?? coords.lon ?? coords.longitude;

  if (lat === undefined || lng === undefined) {
    return InvalidCoordinates({
      reason: 'missing a value. Expected an object with lat/lng, latitude/longitude, or lat/lon properties.',
    });
  }

  return { lat, lng };
}

/**
 * Convert standard coordinates to alternative formats
 * @param coords - Standard coordinates
 * @param format - Target format
 * @returns Coordinates in requested format
 */
export function fromStandardCoordinates(
  coords: Coordinates,
  format: 'latLng' | 'latitudeLongitude' | 'latLon',
):
  | { lat: number; lng: number }
  | { latitude: number; longitude: number }
  | { lat: number; lon: number } {
  switch (format) {
    case 'latLng': {
      return { lat: coords.lat, lng: coords.lng };
    }
    case 'latitudeLongitude': {
      return { latitude: coords.lat, longitude: coords.lng };
    }
    case 'latLon': {
      return { lat: coords.lat, lon: coords.lng };
    }
    default: {
      return { lat: coords.lat, lng: coords.lng };
    }
  }
}

/**
 * Convert coordinates to URL-safe string
 * @param coords - Coordinates to encode
 * @returns URL-safe string like "40.7128,-74.006"
 */
export function coordinatesToUrl(coords: Coordinates): string {
  return `${coords.lat},${coords.lng}`;
}

/**
 * Parse coordinates from URL parameter
 * @param urlParam - URL parameter string like "40.7128,-74.006"
 * @returns Parsed coordinates, or `InvalidCoordinates` when the text is not "lat,lng" in range
 */
export function coordinatesFromUrl(urlParam: string): Coordinates | InvalidCoordinates {
  if (urlParam.split(',').length !== 2) {
    return InvalidCoordinates({ reason: `invalid URL coordinate format: ${urlParam}` });
  }
  return parseCoordinates(urlParam);
}
