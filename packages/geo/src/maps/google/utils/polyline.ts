/**
 * Polyline utilities
 */

import { POLYLINE_ANIMATION_INTERVAL, POLYLINE_DASH_LENGTH, POLYLINE_GAP_LENGTH } from '../constants.js';
import type { Coordinates } from '../types/index.js';

/**
 * Create marching ants animation for a polyline
 *
 * @param polyline The Google Maps polyline instance
 * @param interval Animation interval in milliseconds
 * @returns Cleanup function to stop the animation
 */
export function createMarchingAntsAnimation(
  polyline: google.maps.Polyline,
  interval: number = POLYLINE_ANIMATION_INTERVAL,
): () => void {
  let offset = 0;
  const icons = polyline.get('icons') as google.maps.IconSequence[];

  const animationInterval = setInterval(() => {
    offset = (offset + 1) % (POLYLINE_DASH_LENGTH + POLYLINE_GAP_LENGTH);

    if (icons && icons.length > 0 && icons[0]) {
      icons[0].offset = `${offset}px`;
      polyline.set('icons', icons);
    }
  }, interval);

  // Return cleanup function
  return () => clearInterval(animationInterval);
}

/**
 * Create dashed polyline configuration
 */
export function createDashedPolylineConfig(color = '#FFA07A'): google.maps.PolylineOptions {
  return {
    strokeOpacity: 0,
    icons: [
      {
        icon: {
          path: 'M 0,-1 0,1',
          strokeOpacity: 1,
          strokeColor: color,
          scale: 2,
        },
        offset: '0',
        repeat: `${POLYLINE_DASH_LENGTH + POLYLINE_GAP_LENGTH}px`,
      },
    ],
  };
}

/**
 * Create solid polyline configuration
 */
export function createSolidPolylineConfig(color = '#FFA07A', weight = 2): google.maps.PolylineOptions {
  return {
    strokeColor: color,
    strokeOpacity: 0.8,
    strokeWeight: weight,
  };
}

/**
 * Create polyline path from two points
 */
export function createPolylinePath(start: Coordinates, end: Coordinates): google.maps.LatLng[] {
  return [new google.maps.LatLng(start.lat, start.lng), new google.maps.LatLng(end.lat, end.lng)];
}
