/**
 * Default configuration constants for Google Maps
 */

import type { Coordinates } from '../../core/types';

/**
 * Default map center (middle of the world)
 */
export const DEFAULT_MAP_CENTER: Coordinates = {
  lat: 20,
  lng: 0,
};

/**
 * Default map zoom level
 */
export const DEFAULT_MAP_ZOOM = 2;

/**
 * Default map ID for standard maps
 */
export const DEFAULT_MAP_ID = 'arki-map';

/**
 * Default bounds padding in pixels
 */
export const DEFAULT_BOUNDS_PADDING = 40;

/**
 * Highlighted bounds padding (more zoom for detail)
 */
export const HIGHLIGHTED_BOUNDS_PADDING = 100;

/**
 * Default marker colors (8-color palette for rounds/items)
 */
export const MARKER_COLORS = [
  '#FF6B6B', // Red
  '#4ECDC4', // Teal
  '#45B7D1', // Blue
  '#FFA07A', // Light Salmon
  '#98D8C8', // Mint
  '#F7DC6F', // Yellow
  '#BB8FCE', // Purple
  '#85C1E2', // Light Blue
] as const;

/**
 * Default polyline animation interval (ms)
 */
export const POLYLINE_ANIMATION_INTERVAL = 50;

/**
 * Default polyline dash length
 */
export const POLYLINE_DASH_LENGTH = 10;

/**
 * Default polyline gap length
 */
export const POLYLINE_GAP_LENGTH = 10;
