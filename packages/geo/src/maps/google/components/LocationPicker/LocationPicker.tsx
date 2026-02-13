/**
 * LocationPicker component
 *
 * Interactive map for selecting geographic locations.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

import { DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM } from '../../constants';
import { GoogleMap, GoogleMarker, GooglePin } from '../../primitives';
import type { Coordinates, MapCameraChangedEvent } from '../../types';
import type { LocationPickerProps } from './types';
import { StreetViewChecker } from './StreetViewChecker';

/**
 * LocationPicker component
 *
 * An interactive map that allows users to select a location by clicking.
 * Optionally shows an actual/correct location and supports Street View checking.
 *
 * @example
 * ```tsx
 * const [selected, setSelected] = useState<Coordinates | null>(null);
 *
 * <LocationPicker
 *   onLocationSelect={setSelected}
 *   selectedLocation={selected}
 *   enableStreetView
 * />
 * ```
 */
export function LocationPicker({
  onLocationSelect,
  selectedLocation,
  actualLocation,
  showActual = false,
  disabled = false,
  className,
  centerOnSelected = false,
  zoom: externalZoom,
  center: externalCenter,
  onZoomChange,
  onCenterChange,
  selectedMarkerColor = '#3b82f6', // Blue
  actualMarkerColor = '#22c55e', // Green
  enableStreetView = false,
}: LocationPickerProps) {
  // Internal state for map center and zoom
  const [internalMapCenter, setInternalMapCenter] = useState<Coordinates>(DEFAULT_MAP_CENTER);
  const [internalMapZoom, setInternalMapZoom] = useState(DEFAULT_MAP_ZOOM);
  const [streetViewAvailable, setStreetViewAvailable] = useState(false);

  // Use external control if provided, otherwise use internal state
  const mapCenter = externalCenter || internalMapCenter;
  const mapZoom = externalZoom === undefined ? internalMapZoom : externalZoom;

  /**
   * Handle map center changes
   */
  const handleCenterChanged = useCallback(
    (e: MapCameraChangedEvent) => {
      const center = e.detail?.center;
      if (center?.lat !== undefined && center?.lng !== undefined) {
        const newCenter = { lat: center.lat, lng: center.lng };

        if (onCenterChange) {
          onCenterChange(newCenter);
        } else {
          setInternalMapCenter(newCenter);
        }
      }
    },
    [onCenterChange],
  );

  /**
   * Handle map zoom changes
   */
  const handleZoomChanged = useCallback(
    (e: MapCameraChangedEvent) => {
      const zoom = e.detail?.zoom;
      if (zoom !== undefined) {
        if (onZoomChange) {
          onZoomChange(zoom);
        } else {
          setInternalMapZoom(zoom);
        }
      }
    },
    [onZoomChange],
  );

  /**
   * Handle Street View availability changes
   */
  const handleStreetViewAvailabilityChange = useCallback((available: boolean) => {
    setStreetViewAvailable(available);
  }, []);

  /**
   * Center map on selected location when enabled
   */
  useEffect(() => {
    if (centerOnSelected && selectedLocation) {
      const newCenter = selectedLocation;
      const newZoom = 6;

      if (onCenterChange) {
        onCenterChange(newCenter);
      } else {
        setInternalMapCenter(newCenter);
      }

      if (onZoomChange) {
        onZoomChange(newZoom);
      } else {
        setInternalMapZoom(newZoom);
      }
    }
  }, [centerOnSelected, selectedLocation, onCenterChange, onZoomChange]);

  /**
   * Handle map click to select location
   */
  const handleMapClick = useCallback(
    (coords: Coordinates) => {
      if (!disabled) {
        onLocationSelect(coords);
      }
    },
    [disabled, onLocationSelect],
  );

  return (
    <div className={className || 'space-y-2'}>
      <div className={`w-full overflow-hidden rounded-lg border-none ${className ? 'h-full' : 'h-[300px]'}`}>
        {enableStreetView && showActual && actualLocation && (
          <StreetViewChecker location={actualLocation} onAvailabilityChange={handleStreetViewAvailabilityChange} />
        )}

        <GoogleMap
          center={mapCenter}
          zoom={mapZoom}
          onCameraChanged={e => {
            handleCenterChanged(e);
            handleZoomChanged(e);
          }}
          mapId="location-picker-map"
          onClick={handleMapClick}
          gestureHandling={disabled ? 'none' : 'greedy'}
          disableDefaultUI={false}
          clickableIcons={false}
          className="h-full w-full"
        >
          {/* Selected location marker */}
          {selectedLocation && (
            <GoogleMarker position={selectedLocation}>
              <GooglePin
                background={selectedMarkerColor}
                borderColor={selectedMarkerColor}
                glyphColor="#ffffff"
                scale={1.2}
              />
            </GoogleMarker>
          )}

          {/* Actual location marker (optional) */}
          {showActual && actualLocation && (
            <GoogleMarker position={actualLocation}>
              <GooglePin background={actualMarkerColor} borderColor={actualMarkerColor} glyphColor="#ffffff" scale={1.2} />
            </GoogleMarker>
          )}
        </GoogleMap>
      </div>

      {/* Street View indicator (for debugging/info) */}
      {enableStreetView && showActual && actualLocation && streetViewAvailable && (
        <div className="text-xs text-muted-foreground">Street View available at this location</div>
      )}
    </div>
  );
}
