import type { Coordinates, Direction, DistanceUnit } from './types';
import { CONVERSION_FACTORS, EARTH_RADIUS_KM } from './types';

/**
 * Converts degrees to radians
 */
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Converts radians to degrees
 */
function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/**
 * Calculate the great-circle distance between two points using the Haversine formula
 * @param point1 - First coordinate
 * @param point2 - Second coordinate
 * @param unit - Unit of measurement (default: 'km')
 * @returns Distance in specified unit
 */
export function calculateDistance(
  point1: Coordinates,
  point2: Coordinates,
  unit: DistanceUnit = 'km',
): number {
  const lat1Rad = toRadians(point1.lat);
  const lat2Rad = toRadians(point2.lat);
  const deltaLatRad = toRadians(point2.lat - point1.lat);
  const deltaLngRad = toRadians(point2.lng - point1.lng);

  const a =
    Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
    Math.cos(lat1Rad) *
      Math.cos(lat2Rad) *
      Math.sin(deltaLngRad / 2) *
      Math.sin(deltaLngRad / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  // Calculate distance in kilometers
  const distanceKm = EARTH_RADIUS_KM * c;

  // Convert to requested unit
  switch (unit) {
    case 'km': {
      return distanceKm;
    }
    case 'mi': {
      return distanceKm * CONVERSION_FACTORS.KM_TO_MI;
    }
    case 'm': {
      return distanceKm * CONVERSION_FACTORS.KM_TO_M;
    }
    case 'ft': {
      return distanceKm * CONVERSION_FACTORS.KM_TO_MI * CONVERSION_FACTORS.MI_TO_FT;
    }
    default: {
      return distanceKm;
    }
  }
}

/**
 * Calculate the bearing (direction) from point1 to point2
 * @param point1 - Starting coordinate
 * @param point2 - Ending coordinate
 * @returns Bearing in degrees (0-360, where 0/360 is North)
 */
export function calculateBearing(point1: Coordinates, point2: Coordinates): number {
  const lat1Rad = toRadians(point1.lat);
  const lat2Rad = toRadians(point2.lat);
  const deltaLngRad = toRadians(point2.lng - point1.lng);

  const y = Math.sin(deltaLngRad) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(deltaLngRad);

  const bearingRad = Math.atan2(y, x);
  const bearingDeg = toDegrees(bearingRad);

  // Normalize to 0-360
  return (bearingDeg + 360) % 360;
}

/**
 * Get compass direction from bearing
 * @param bearing - Bearing in degrees (0-360)
 * @returns Cardinal or intercardinal direction
 */
export function bearingToDirection(bearing: number): Direction {
  const normalized = ((bearing % 360) + 360) % 360;
  const index = Math.round(normalized / 22.5) % 16;

  const directions: Direction[] = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ];

  return directions[index]!;
}

/**
 * Calculate the midpoint between two coordinates
 * @param point1 - First coordinate
 * @param point2 - Second coordinate
 * @returns Midpoint coordinates
 */
export function calculateMidpoint(point1: Coordinates, point2: Coordinates): Coordinates {
  const lat1Rad = toRadians(point1.lat);
  const lat2Rad = toRadians(point2.lat);
  const lng1Rad = toRadians(point1.lng);
  const deltaLngRad = toRadians(point2.lng - point1.lng);

  const bx = Math.cos(lat2Rad) * Math.cos(deltaLngRad);
  const by = Math.cos(lat2Rad) * Math.sin(deltaLngRad);

  const lat3Rad = Math.atan2(
    Math.sin(lat1Rad) + Math.sin(lat2Rad),
    Math.sqrt((Math.cos(lat1Rad) + bx) * (Math.cos(lat1Rad) + bx) + by * by),
  );

  const lng3Rad = lng1Rad + Math.atan2(by, Math.cos(lat1Rad) + bx);

  return {
    lat: toDegrees(lat3Rad),
    lng: toDegrees(lng3Rad),
  };
}

/**
 * Calculate destination point given distance and bearing from start point
 * @param point - Starting coordinate
 * @param distance - Distance in kilometers
 * @param bearing - Bearing in degrees (0-360)
 * @returns Destination coordinates
 */
export function calculateDestination(
  point: Coordinates,
  distance: number,
  bearing: number,
): Coordinates {
  const angularDistance = distance / EARTH_RADIUS_KM;
  const bearingRad = toRadians(bearing);
  const lat1Rad = toRadians(point.lat);
  const lng1Rad = toRadians(point.lng);

  const lat2Rad = Math.asin(
    Math.sin(lat1Rad) * Math.cos(angularDistance) +
      Math.cos(lat1Rad) * Math.sin(angularDistance) * Math.cos(bearingRad),
  );

  const lng2Rad =
    lng1Rad +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(angularDistance) * Math.cos(lat1Rad),
      Math.cos(angularDistance) - Math.sin(lat1Rad) * Math.sin(lat2Rad),
    );

  return {
    lat: toDegrees(lat2Rad),
    lng: toDegrees(lng2Rad),
  };
}

/**
 * Convert distance between units
 * @param distance - Distance value
 * @param fromUnit - Source unit
 * @param toUnit - Target unit
 * @returns Converted distance
 */
export function convertDistance(
  distance: number,
  fromUnit: DistanceUnit,
  toUnit: DistanceUnit,
): number {
  if (fromUnit === toUnit) return distance;

  // Convert to kilometers first
  let distanceKm: number;
  switch (fromUnit) {
    case 'km': {
      distanceKm = distance;
      break;
    }
    case 'mi': {
      distanceKm = distance * CONVERSION_FACTORS.MI_TO_KM;
      break;
    }
    case 'm': {
      distanceKm = distance * CONVERSION_FACTORS.M_TO_KM;
      break;
    }
    case 'ft': {
      distanceKm =
        distance * CONVERSION_FACTORS.FT_TO_MI * CONVERSION_FACTORS.MI_TO_KM;
      break;
    }
  }

  // Convert from kilometers to target unit
  switch (toUnit) {
    case 'km': {
      return distanceKm;
    }
    case 'mi': {
      return distanceKm * CONVERSION_FACTORS.KM_TO_MI;
    }
    case 'm': {
      return distanceKm * CONVERSION_FACTORS.KM_TO_M;
    }
    case 'ft': {
      return distanceKm * CONVERSION_FACTORS.KM_TO_MI * CONVERSION_FACTORS.MI_TO_FT;
    }
  }
}
