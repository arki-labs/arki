/**
 * Google Maps type definitions
 *
 * This module re-exports all types related to Google Maps integration,
 * including types from @vis.gl/react-google-maps and custom types.
 */

// Re-export ALL types from @vis.gl/react-google-maps
export * from './primitives';

// Export custom type definitions
export * from './map';
export * from './marker';
export * from './events';

// Re-export core geo types for convenience
export type { Coordinates, Bounds, DistanceUnit, Direction } from '../../../core/types';
