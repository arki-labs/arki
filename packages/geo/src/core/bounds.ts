import { calculateDestination, calculateDistance } from './distance.js';
import { BoundsError } from './errors.js';
import type { Bounds, Coordinates } from './types.js';

/**
 * Create bounds from an array of coordinates
 * @param coordinates - Array of coordinates
 * @returns Bounding box
 * @throws BoundsError if array is empty
 */
export function createBoundsFromCoordinates(coordinates: Coordinates[]): Bounds {
  if (coordinates.length === 0) {
    throw new BoundsError('Cannot create bounds from empty coordinates array');
  }

  let north = -90;
  let south = 90;
  let east = -180;
  let west = 180;

  for (const coord of coordinates) {
    north = Math.max(north, coord.lat);
    south = Math.min(south, coord.lat);
    east = Math.max(east, coord.lng);
    west = Math.min(west, coord.lng);
  }

  return { north, south, east, west };
}

/**
 * Create bounds from a center point and radius
 * @param center - Center coordinate
 * @param radiusKm - Radius in kilometers
 * @returns Bounding box
 */
export function createBoundsFromRadius(center: Coordinates, radiusKm: number): Bounds {
  // Calculate corners using bearing
  const north = calculateDestination(center, radiusKm, 0).lat;
  const south = calculateDestination(center, radiusKm, 180).lat;
  const east = calculateDestination(center, radiusKm, 90).lng;
  const west = calculateDestination(center, radiusKm, 270).lng;

  return { north, south, east, west };
}

/**
 * Check if a coordinate is within bounds
 * @param coord - Coordinate to check
 * @param bounds - Bounding box
 * @returns true if coordinate is within bounds
 */
export function isCoordinateInBounds(coord: Coordinates, bounds: Bounds): boolean {
  return (
    coord.lat >= bounds.south &&
    coord.lat <= bounds.north &&
    coord.lng >= bounds.west &&
    coord.lng <= bounds.east
  );
}

/**
 * Get the center coordinate of bounds
 * @param bounds - Bounding box
 * @returns Center coordinate
 */
export function getBoundsCenter(bounds: Bounds): Coordinates {
  return {
    lat: (bounds.north + bounds.south) / 2,
    lng: (bounds.east + bounds.west) / 2,
  };
}

/**
 * Get the approximate radius of bounds in kilometers
 * Uses the distance from center to the furthest corner
 * @param bounds - Bounding box
 * @returns Radius in kilometers
 */
export function getBoundsRadius(bounds: Bounds): number {
  const center = getBoundsCenter(bounds);

  // Calculate distance to all four corners and find the maximum
  const corners: Coordinates[] = [
    { lat: bounds.north, lng: bounds.east },
    { lat: bounds.north, lng: bounds.west },
    { lat: bounds.south, lng: bounds.east },
    { lat: bounds.south, lng: bounds.west },
  ];

  let maxDistance = 0;
  for (const corner of corners) {
    const distance = calculateDistance(center, corner, 'km');
    maxDistance = Math.max(maxDistance, distance);
  }

  return maxDistance;
}

/**
 * Extend bounds to include a coordinate
 * @param bounds - Existing bounds
 * @param coord - Coordinate to include
 * @returns Extended bounds
 */
export function extendBounds(bounds: Bounds, coord: Coordinates): Bounds {
  return {
    north: Math.max(bounds.north, coord.lat),
    south: Math.min(bounds.south, coord.lat),
    east: Math.max(bounds.east, coord.lng),
    west: Math.min(bounds.west, coord.lng),
  };
}

/**
 * Check if two bounds intersect
 * @param bounds1 - First bounds
 * @param bounds2 - Second bounds
 * @returns true if bounds intersect
 */
export function boundsIntersect(bounds1: Bounds, bounds2: Bounds): boolean {
  return !(
    bounds1.north < bounds2.south ||
    bounds1.south > bounds2.north ||
    bounds1.east < bounds2.west ||
    bounds1.west > bounds2.east
  );
}

/**
 * Check if bounds1 contains bounds2
 * @param bounds1 - Outer bounds
 * @param bounds2 - Inner bounds
 * @returns true if bounds1 completely contains bounds2
 */
export function boundsContains(bounds1: Bounds, bounds2: Bounds): boolean {
  return (
    bounds1.north >= bounds2.north &&
    bounds1.south <= bounds2.south &&
    bounds1.east >= bounds2.east &&
    bounds1.west <= bounds2.west
  );
}

/**
 * Pad bounds by a percentage
 * @param bounds - Bounds to pad
 * @param percent - Percentage to pad (e.g., 0.1 for 10%)
 * @returns Padded bounds
 */
export function padBounds(bounds: Bounds, percent: number): Bounds {
  const latPadding = (bounds.north - bounds.south) * percent;
  const lngPadding = (bounds.east - bounds.west) * percent;

  return {
    north: Math.min(90, bounds.north + latPadding),
    south: Math.max(-90, bounds.south - latPadding),
    east: Math.min(180, bounds.east + lngPadding),
    west: Math.max(-180, bounds.west - lngPadding),
  };
}

/**
 * Format bounds as a string
 * @param bounds - Bounds to format
 * @param precision - Number of decimal places (default: 6)
 * @returns Formatted string like "N:40.7128 S:40.7000 E:-74.0000 W:-74.0060"
 */
export function formatBounds(bounds: Bounds, precision = 6): string {
  return (
    `N:${bounds.north.toFixed(precision)} ` +
    `S:${bounds.south.toFixed(precision)} ` +
    `E:${bounds.east.toFixed(precision)} ` +
    `W:${bounds.west.toFixed(precision)}`
  );
}
