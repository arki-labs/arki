'use client';

import { useCallback, useState } from 'react';

import { getLogger } from '@arki/log';

import { normalizeCoordinates, validateCoordinates } from '../../core/coordinates.js';
import { InvalidCoordinates } from '../../core/failures.js';
import type { Coordinates } from '../../core/types.js';

const log = getLogger('arki:geo');

export type UseCoordinatesReturn = {
  coordinates: Coordinates | null;
  setCoordinates: (coords: Coordinates) => void;
  updateLatitude: (lat: number) => void;
  updateLongitude: (lng: number) => void;
  isValid: boolean;
  /** Why the last change was refused, or null when the last change was accepted. The previous value is kept. */
  error: InvalidCoordinates | null;
  normalize: () => void;
  clear: () => void;
}

/**
 * Hook to manage coordinate state with validation.
 * A refused change keeps the old coordinates and sets `error`.
 * @param initialCoordinates - Initial coordinates
 * @returns Coordinate state and update functions
 */
export function useCoordinates(
  initialCoordinates: Coordinates | null = null,
): UseCoordinatesReturn {
  const [coordinates, setCoordinatesState] = useState<Coordinates | null>(
    initialCoordinates,
  );
  const [error, setError] = useState<InvalidCoordinates | null>(null);

  const accept = useCallback((candidate: Coordinates) => {
    const checked = validateCoordinates(candidate);
    if (InvalidCoordinates.is(checked)) {
      log.warn('Refused coordinates: {reason}', { reason: checked.data.reason });
      setError(checked);
      return;
    }
    setError(null);
    setCoordinatesState(checked);
  }, []);

  const setCoordinates = useCallback((coords: Coordinates) => accept(coords), [accept]);

  const updateLatitude = useCallback(
    (lat: number) => accept({ lat, lng: coordinates?.lng ?? 0 }),
    [accept, coordinates],
  );

  const updateLongitude = useCallback(
    (lng: number) => accept({ lat: coordinates?.lat ?? 0, lng }),
    [accept, coordinates],
  );

  const normalize = useCallback(() => {
    if (!coordinates) return;
    const normalized = normalizeCoordinates(coordinates);
    if (InvalidCoordinates.is(normalized)) {
      setError(normalized);
      return;
    }
    setError(null);
    setCoordinatesState(normalized);
  }, [coordinates]);

  const clear = useCallback(() => {
    setError(null);
    setCoordinatesState(null);
  }, []);

  const isValid = coordinates ? !InvalidCoordinates.is(validateCoordinates(coordinates)) : false;

  return {
    coordinates,
    setCoordinates,
    updateLatitude,
    updateLongitude,
    isValid,
    error,
    normalize,
    clear,
  };
}
