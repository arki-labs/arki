/**
 * @arki/geo/react/google-maps - Google Maps integration
 *
 * Complete abstraction layer over @vis.gl/react-google-maps.
 * Applications should never import from @vis.gl directly.
 *
 * @module @arki/geo/react/google-maps
 */

// ============================================
// Primitives (direct wrappers of @vis.gl)
// ============================================

export { GoogleMapsProvider, GoogleMap, GoogleMarker, GooglePin, GoogleInfoWindow } from './primitives/index.js';

export type { GoogleMapsProviderProps, GoogleMapProps, GoogleMarkerProps, GooglePinProps, GoogleInfoWindowProps } from './primitives/index.js';

// ============================================
// Hooks
// ============================================

export { useGoogleMaps, useGoogleMap, useApiIsLoaded, useMapBounds, usePolylineAnimation } from './hooks/index.js';

export type { GoogleMapsLibrary, GoogleMapInstance, UseMapBoundsOptions, PolylineData, UsePolylineAnimationOptions } from './hooks/index.js';

// ============================================
// Types (ALL types re-exported)
// ============================================

export type * from './types/index.js';

// ============================================
// Utilities
// ============================================

export * from './utils/index.js';

// ============================================
// Constants
// ============================================

export * from './constants.js';

// ============================================
// Components (High-level, extracted from apps)
// ============================================

export { LocationPicker, StreetViewChecker, StreetViewPanorama, useMapOverlay } from './components/index.js';

export type { LocationPickerProps, StreetViewCheckerProps, StreetViewPanoramaProps, MapSize, UseMapOverlayReturn, UseMapOverlayOptions } from './components/index.js';

// Note: Additional components to be extracted:
// export { ResultsMap } from './components/ResultsMap';
