'use client';

import { useMemo } from 'react';

import { calculateDistance } from '../../core/distance';
import type { Coordinates, DistanceUnit } from '../../core/types';

/**
 * Hook to calculate distance between two coordinates
 * @param point1 - First coordinate
 * @param point2 - Second coordinate
 * @param unit - Unit of measurement (default: 'km')
 * @returns Distance in specified unit, or null if either coordinate is null
 */
export function useDistance(
  point1: Coordinates | null,
  point2: Coordinates | null,
  unit: DistanceUnit = 'km',
): number | null {
  return useMemo(() => {
    if (!point1 || !point2) return null;
    return calculateDistance(point1, point2, unit);
  }, [point1?.lat, point1?.lng, point2?.lat, point2?.lng, unit]);
}
