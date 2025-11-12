/**
 * Represents geographic coordinates using WGS84 datum
 * @property lat - Latitude in decimal degrees (-90 to 90)
 * @property lng - Longitude in decimal degrees (-180 to 180)
 */
export interface Coordinates {
  lat: number;
  lng: number;
}

/**
 * Represents a geographic bounding box
 */
export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * Distance units
 */
export type DistanceUnit = 'km' | 'mi' | 'm' | 'ft';

/**
 * Cardinal and intercardinal directions
 */
export type Direction =
  | 'N'
  | 'NNE'
  | 'NE'
  | 'ENE'
  | 'E'
  | 'ESE'
  | 'SE'
  | 'SSE'
  | 'S'
  | 'SSW'
  | 'SW'
  | 'WSW'
  | 'W'
  | 'WNW'
  | 'NW'
  | 'NNW';

/**
 * Earth radius in kilometers
 */
export const EARTH_RADIUS_KM = 6371;

/**
 * Earth radius in miles
 */
export const EARTH_RADIUS_MI = 3959;

/**
 * Conversion factors
 */
export const CONVERSION_FACTORS = {
  KM_TO_MI: 0.621371,
  MI_TO_KM: 1.60934,
  KM_TO_M: 1000,
  M_TO_KM: 0.001,
  MI_TO_FT: 5280,
  FT_TO_MI: 0.000189394,
} as const;
