/**
 * Color utilities for map markers and elements
 */

import { MARKER_COLORS } from '../constants';

/**
 * Get a color from the marker palette by index
 */
export function getMarkerColor(index: number): string {
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
