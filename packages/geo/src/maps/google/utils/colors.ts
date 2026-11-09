/**
 * Color utilities for map markers and elements
 */

import { invariant } from '@arki/failure';

import { MARKER_COLORS } from '../constants.js';

/**
 * Get a color from the marker palette by index; indexes past the end wrap around.
 *
 * @param index - A whole number of at least 0. Anything else (negative, a fraction, `NaN`) throws the
 *   invariant failure `ARKI_FAILURE_E008`, a caller bug (it returned `undefined`).
 */
export function getMarkerColor(index: number): string {
  invariant(
    Number.isSafeInteger(index) && index >= 0,
    () => `getMarkerColor: index must be a whole number of at least 0, got ${index}.`,
  );
  return MARKER_COLORS[index % MARKER_COLORS.length]!;
}

/**
 * Get all marker colors
 */
export function getAllMarkerColors(): readonly string[] {
  return MARKER_COLORS;
}

/**
 * Predefined color sets for different use cases
 */
export const COLOR_SETS = {
  /**
   * Default marker colors (8-color palette)
   */
  markers: MARKER_COLORS,

  /**
   * Status colors
   */
  status: {
    success: '#10B981',
    warning: '#F59E0B',
    error: '#EF4444',
    info: '#3B82F6',
  },

  /**
   * Polyline colors (for connections)
   */
  polylines: {
    guess: '#4ECDC4',
    actual: '#FF6B6B',
    connection: '#FFA07A',
  },
} as const;
