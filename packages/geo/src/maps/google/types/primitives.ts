/**
 * Type re-exports from @vis.gl/react-google-maps
 *
 * This file re-exports all types from the underlying Google Maps library
 * so consuming applications never need to import from @vis.gl directly.
 */

export type {
  // Core Map types
  MapProps,
  MapCameraChangedEvent,
  MapCameraProps,
  MapEvent,
  MapMouseEvent,

  // Marker types
  AdvancedMarkerProps,
  AdvancedMarkerRef,
  MarkerProps,

  // Info Window types
  InfoWindowProps,

  // Pin types
  PinProps,

  // Polyline types (from google.maps)
  // Note: Polyline is custom implemented

  // API Provider types
  APIProviderProps,
  APIProviderContextValue,
} from '@vis.gl/react-google-maps';
