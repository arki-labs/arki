'use client';

import { useMemo } from 'react';

import {
  createBoundsFromCoordinates,
  createBoundsFromRadius,
  getBoundsCenter,
  getBoundsRadius,
  isCoordinateInBounds,
} from '../../core/bounds';
import type { Bounds, Coordinates } from '../../core/types';

export interface UseBoundsReturn {
  bounds: Bounds | null;
  center: Coordinates | null;
  radius: number | null;
  contains: (coord: Coordinates) => boolean;
}

/**
 * Hook to calculate and work with bounds
 * @param coordinates - Array of coordinates to create bounds from
 * @returns Bounds information and utility functions
 */
export function useBoundsFromCoordinates(
  coordinates: Coordinates[],
): UseBoundsReturn {
  const bounds = useMemo(() => {
    if (coordinates.length === 0) return null;
    return createBoundsFromCoordinates(coordinates);
  }, [coordinates]);

  const center = useMemo(() => {
    if (!bounds) return null;
    return getBoundsCenter(bounds);
  }, [bounds]);

  const radius = useMemo(() => {
    if (!bounds) return null;
    return getBoundsRadius(bounds);
  }, [bounds]);

  const contains = useMemo(() => {
    if (!bounds) return () => false;
    return (coord: Coordinates) => isCoordinateInBounds(coord, bounds);
  }, [bounds]);

  return {
    bounds,
    center,
    radius,
    contains,
  };
}

/**
 * Hook to create bounds from a center point and radius
 * @param center - Center coordinate
 * @param radiusKm - Radius in kilometers
 * @returns Bounds information
 */
export function useBoundsFromRadius(
  center: Coordinates | null,
  radiusKm: number,
): UseBoundsReturn {
  const bounds = useMemo(() => {
    if (!center) return null;
    return createBoundsFromRadius(center, radiusKm);
  }, [center, radiusKm]);

  const contains = useMemo(() => {
    if (!bounds) return () => false;
    return (coord: Coordinates) => isCoordinateInBounds(coord, bounds);
  }, [bounds]);

  return {
    bounds,
    center,
    radius: radiusKm,
    contains,
  };
}
