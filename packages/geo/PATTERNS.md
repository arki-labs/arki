# @arki/geo - Common Patterns & Best Practices

## Loading States

### For React Components

```typescript
'use client';

import { useState } from 'react';
import { GoogleMap } from '@arki/geo/react/google-maps';
import { Spinner } from '@arki/ui/base';

export function MapWithLoading() {
  const [isLoading, setIsLoading] = useState(true);

  return (
    <div className="relative h-full w-full">
      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
          <Spinner />
        </div>
      )}
      <GoogleMap
        center={{ lat: 40.7128, lng: -74.006 }}
        zoom={12}
        onLoad={() => setIsLoading(false)}
        onError={() => setIsLoading(false)}
      />
    </div>
  );
}
```

## Error Boundaries

### React Error Boundary for Maps

```typescript
'use client';

import { Component, type ReactNode } from 'react';
import { MapProviderError } from '@arki/geo';
import { Alert } from '@arki/ui/base';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class MapErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const isMapError = this.state.error instanceof MapProviderError;
      return (
        <Alert variant="destructive">
          <h3 className="font-semibold">Map Loading Error</h3>
          <p>
            {isMapError
              ? `Failed to load ${this.state.error.provider} maps. Please check your API key.`
              : 'An unexpected error occurred while loading the map.'}
          </p>
        </Alert>
      );
    }

    return this.props.children;
  }
}

// Usage
export function MapPage() {
  return (
    <MapErrorBoundary>
      <GoogleMap center={{ lat: 0, lng: 0 }} zoom={2} />
    </MapErrorBoundary>
  );
}
```

## Performance Optimization

### Memoizing Distance Calculations

```typescript
import { useMemo } from 'react';
import { calculateDistance } from '@arki/geo';
import type { Coordinates } from '@arki/geo';

export function useDistance(
  point1: Coordinates | null,
  point2: Coordinates | null,
  unit: 'km' | 'mi' = 'km',
) {
  return useMemo(() => {
    if (!point1 || !point2) return null;
    return calculateDistance(point1, point2, unit);
  }, [point1?.lat, point1?.lng, point2?.lat, point2?.lng, unit]);
}

// Usage
function LocationDistance({ from, to }: { from: Coordinates; to: Coordinates }) {
  const distance = useDistance(from, to, 'km');
  return <div>{distance?.toFixed(2)} km</div>;
}
```

### Lazy Loading Map Components

```typescript
import { lazy, Suspense } from 'react';
import { Spinner } from '@arki/ui/base';

// Lazy load the map component to reduce initial bundle size
const GoogleMapLazy = lazy(() =>
  import('@arki/geo/react/google-maps').then((mod) => ({ default: mod.GoogleMap })),
);

export function MapWithLazyLoading() {
  return (
    <Suspense fallback={<Spinner className="h-96" />}>
      <GoogleMapLazy center={{ lat: 40.7128, lng: -74.006 }} zoom={12} />
    </Suspense>
  );
}
```

## Mobile Optimization

### Touch-Friendly Map Configuration

```typescript
import { GoogleMap } from '@arki/geo/react/google-maps';

export function MobileOptimizedMap() {
  return (
    <GoogleMap
      center={{ lat: 40.7128, lng: -74.006 }}
      zoom={12}
      gestureHandling="greedy" // Allow single-finger panning on mobile
      mapOptions={{
        disableDefaultUI: true, // Remove default controls on mobile
        zoomControl: true, // Keep zoom control
        fullscreenControl: false, // Remove fullscreen on mobile
      }}
      className="h-[70vh] w-full" // Responsive height
    />
  );
}
```

### Responsive Marker Sizes

```typescript
import { useMediaQuery } from '@arki/react-hooks';
import { GoogleMap, Marker } from '@arki/geo/react/google-maps';

export function ResponsiveMarkers() {
  const isMobile = useMediaQuery('(max-width: 768px)');
  const markerScale = isMobile ? 0.8 : 1;

  return (
    <GoogleMap center={{ lat: 40.7128, lng: -74.006 }} zoom={12}>
      <Marker
        position={{ lat: 40.7128, lng: -74.006 }}
        scale={markerScale}
        title="Mobile-optimized marker"
      />
    </GoogleMap>
  );
}
```

## Accessibility

### ARIA Labels for Maps

```typescript
import { GoogleMap } from '@arki/geo/react/google-maps';

export function AccessibleMap() {
  return (
    <div role="region" aria-label="Interactive map showing office locations">
      <GoogleMap
        center={{ lat: 40.7128, lng: -74.006 }}
        zoom={12}
        aria-label="Office locations map"
      />
    </div>
  );
}
```

### Keyboard Navigation for Map Controls

```typescript
'use client';

import { useRef } from 'react';
import { GoogleMap } from '@arki/geo/react/google-maps';
import type { Coordinates } from '@arki/geo';
import { Button } from '@arki/ui/base';

export function KeyboardNavigableMap() {
  const mapRef = useRef<google.maps.Map>(null);

  const handleZoomIn = () => {
    if (mapRef.current) {
      const currentZoom = mapRef.current.getZoom() ?? 10;
      mapRef.current.setZoom(currentZoom + 1);
    }
  };

  const handleZoomOut = () => {
    if (mapRef.current) {
      const currentZoom = mapRef.current.getZoom() ?? 10;
      mapRef.current.setZoom(currentZoom - 1);
    }
  };

  return (
    <div>
      <div className="mb-2 flex gap-2" role="toolbar" aria-label="Map controls">
        <Button
          onClick={handleZoomIn}
          aria-label="Zoom in"
          onKeyDown={(e) => e.key === 'Enter' && handleZoomIn()}
        >
          +
        </Button>
        <Button
          onClick={handleZoomOut}
          aria-label="Zoom out"
          onKeyDown={(e) => e.key === 'Enter' && handleZoomOut()}
        >
          −
        </Button>
      </div>
      <GoogleMap
        ref={mapRef}
        center={{ lat: 40.7128, lng: -74.006 }}
        zoom={12}
      />
    </div>
  );
}
```

## Integration with Existing Packages

### Using with @arki/ui Components

```typescript
import { Card, CardContent, CardHeader, CardTitle } from '@arki/ui/base';
import { GoogleMap, Marker } from '@arki/geo/react/google-maps';

export function MapCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Office Location</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-96 w-full">
          <GoogleMap center={{ lat: 40.7128, lng: -74.006 }} zoom={14}>
            <Marker position={{ lat: 40.7128, lng: -74.006 }} title="Our Office" />
          </GoogleMap>
        </div>
      </CardContent>
    </Card>
  );
}
```

### Using with @arki/contracts Types

```typescript
import { z } from 'zod';

import type { Coordinates } from '@arki/geo';
import { isValidCoordinates } from '@arki/geo';

// Use in tRPC router
import { createTRPCRouter, publicProcedure } from '~/core/trpc';

// Define location contract
export const locationSchema = z.object({
  id: z.string(),
  name: z.string(),
  coordinates: z.custom<Coordinates>(val => {
    return isValidCoordinates(val as Coordinates);
  }, 'Invalid coordinates'),
  address: z.string(),
});

export type Location = z.infer<typeof locationSchema>;

export const locationRouter = createTRPCRouter({
  getNearby: publicProcedure
    .input(
      z.object({
        coordinates: z.custom<Coordinates>(val => {
          return isValidCoordinates(val as Coordinates);
        }),
        radiusKm: z.number().positive(),
      }),
    )
    .query(async ({ input, ctx }) => {
      // Find locations within radius
      return ctx.repo.location.findNearby(input.coordinates, input.radiusKm);
    }),
});
```

## Real-World Usage: Search with Map

```typescript
'use client';

import { useState } from 'react';
import { GoogleMap, Marker, InfoWindow } from '@arki/geo/react/google-maps';
import { useDistance } from '@arki/geo/react';
import type { Coordinates } from '@arki/geo';
import { Input, Card } from '@arki/ui/base';

interface Location {
  id: string;
  name: string;
  coordinates: Coordinates;
}

export function LocationSearchMap({ locations }: { locations: Location[] }) {
  const [userLocation, setUserLocation] = useState<Coordinates | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<Location | null>(null);

  const distance = useDistance(
    userLocation,
    selectedLocation?.coordinates ?? null,
    'km',
  );

  // Get user's current location
  const getCurrentLocation = () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((position) => {
        setUserLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      });
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <button onClick={getCurrentLocation} className="btn-primary">
          Use My Location
        </button>
        {userLocation && (
          <p className="mt-2 text-sm text-muted-foreground">
            Your location: {userLocation.lat.toFixed(4)}, {userLocation.lng.toFixed(4)}
          </p>
        )}
      </Card>

      <div className="h-96 w-full">
        <GoogleMap
          center={userLocation ?? { lat: 40.7128, lng: -74.006 }}
          zoom={12}
        >
          {userLocation && (
            <Marker
              position={userLocation}
              title="Your Location"
              icon={{
                url: '/icons/user-location.svg',
                scaledSize: { width: 40, height: 40 },
              }}
            />
          )}

          {locations.map((location) => (
            <Marker
              key={location.id}
              position={location.coordinates}
              title={location.name}
              onClick={() => setSelectedLocation(location)}
            />
          ))}

          {selectedLocation && (
            <InfoWindow
              position={selectedLocation.coordinates}
              onClose={() => setSelectedLocation(null)}
            >
              <div>
                <h3 className="font-semibold">{selectedLocation.name}</h3>
                {distance && (
                  <p className="text-sm text-muted-foreground">
                    {distance.toFixed(2)} km away
                  </p>
                )}
              </div>
            </InfoWindow>
          )}
        </GoogleMap>
      </div>
    </div>
  );
}
```

## Offline Support (Future)

```typescript
// Future implementation for offline map caching
import { useEffect, useState } from 'react';

export function useOfflineMapTiles(bounds: google.maps.LatLngBounds) {
  const [cachedTiles, setCachedTiles] = useState<string[]>([]);

  useEffect(() => {
    // Cache map tiles for offline use
    const cacheTiles = async () => {
      // Implementation would use Service Workers or IndexedDB
      // to cache map tiles within bounds
    };

    cacheTiles();
  }, [bounds]);

  return cachedTiles;
}
```
