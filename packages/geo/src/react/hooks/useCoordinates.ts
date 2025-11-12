'use client';

import { useCallback, useState } from 'react';

import {
  isValidCoordinates,
  normalizeCoordinates,
  validateCoordinates,
} from '../../core/coordinates';
import type { Coordinates } from '../../core/types';

export interface UseCoordinatesReturn {
  coordinates: Coordinates | null;
  setCoordinates: (coords: Coordinates) => void;
  updateLatitude: (lat: number) => void;
  updateLongitude: (lng: number) => void;
  isValid: boolean;
  normalize: () => void;
  clear: () => void;
}

/**
 * Hook to manage coordinate state with validation
 * @param initialCoordinates - Initial coordinates
 * @returns Coordinate state and update functions
 */
export function useCoordinates(
  initialCoordinates: Coordinates | null = null,
): UseCoordinatesReturn {
  const [coordinates, setCoordinatesState] = useState<Coordinates | null>(
    initialCoordinates,
  );

  const setCoordinates = useCallback((coords: Coordinates) => {
    try {
      validateCoordinates(coords);
      setCoordinatesState(coords);
    } catch (error) {
      console.error('Invalid coordinates:', error);
    }
  }, []);

  const updateLatitude = useCallback(
    (lat: number) => {
      if (coordinates) {
        const updated = { ...coordinates, lat };
        if (isValidCoordinates(updated)) {
          setCoordinatesState(updated);
        }
      } else {
        setCoordinatesState({ lat, lng: 0 });
      }
    },
    [coordinates],
  );

  const updateLongitude = useCallback(
    (lng: number) => {
      if (coordinates) {
        const updated = { ...coordinates, lng };
        if (isValidCoordinates(updated)) {
          setCoordinatesState(updated);
        }
      } else {
        setCoordinatesState({ lat: 0, lng });
      }
    },
    [coordinates],
  );

  const normalize = useCallback(() => {
    if (coordinates) {
      setCoordinatesState(normalizeCoordinates(coordinates));
    }
  }, [coordinates]);

  const clear = useCallback(() => {
    setCoordinatesState(null);
  }, []);

  const isValid = coordinates ? isValidCoordinates(coordinates) : false;

  return {
    coordinates,
    setCoordinates,
    updateLatitude,
    updateLongitude,
    isValid,
    normalize,
    clear,
  };
}
