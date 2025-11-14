/**
 * @arki/geo/maps/google - Google Maps integration
 *
 * Complete abstraction layer over @vis.gl/react-google-maps.
 * Applications should never import from @vis.gl directly.
 *
 * @module @arki/geo/maps/google
 */

// ============================================
// Primitives (direct wrappers of @vis.gl)
// ============================================

export { GoogleMapsProvider, GoogleMap, GoogleMarker, GooglePin, GoogleInfoWindow } from './primitives';

export type { GoogleMapsProviderProps, GoogleMapProps, GoogleMarkerProps, GooglePinProps, GoogleInfoWindowProps } from './primitives';

// ============================================
// Hooks
// ============================================

export { useGoogleMaps, useGoogleMap, useApiIsLoaded, useMapBounds, usePolylineAnimation } from './hooks';

export type { GoogleMapsLibrary, GoogleMapInstance, UseMapBoundsOptions, PolylineData, UsePolylineAnimationOptions } from './hooks';

// ============================================
// Types (ALL types re-exported)
// ============================================

export type * from './types';

// ============================================
// Utilities
// ============================================

export * from './utils';

// ============================================
// Constants
// ============================================

export * from './constants';

// ============================================
// Components (High-level, extracted from apps)
// ============================================

export { LocationPicker, StreetViewChecker, StreetViewPanorama, useMapOverlay } from './components';

export type { LocationPickerProps, StreetViewCheckerProps, StreetViewPanoramaProps, MapSize, UseMapOverlayReturn, UseMapOverlayOptions } from './components';

// Note: Additional components to be extracted:
// export { ResultsMap } from './components/ResultsMap';
