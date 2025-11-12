# Map Providers Integration Guide - @arki/geo

## 🗺️ Overview

This guide covers all supported map providers in `@arki/geo`, including installation, usage patterns, and best practices for each provider.

## 📦 Supported Providers

### 1. Google Maps (@vis.gl/react-google-maps) ⭐ Recommended

**Best for**: General purpose, places search, Street View, comprehensive features

#### Installation

```bash
pnpm add @arki/geo @vis.gl/react-google-maps
```

#### Basic Usage

```typescript
'use client';

import { APIProvider, Map, AdvancedMarker } from '@vis.gl/react-google-maps';
import type { Coordinates } from '@arki/geo';

export function GoogleMapExample() {
  const center: Coordinates = { lat: 40.7128, lng: -74.0060 };

  return (
    <APIProvider apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!}>
      <Map
        defaultCenter={center}
        defaultZoom={12}
        mapId="YOUR_MAP_ID" // Required for advanced features
        style={{ width: '100%', height: '500px' }}
      >
        <AdvancedMarker position={center} />
      </Map>
    </APIProvider>
  );
}
```

#### With @arki/geo Utilities

```typescript
'use client';

import { APIProvider, Map, AdvancedMarker } from '@vis.gl/react-google-maps';
import { useDistance, calculateBounds } from '@arki/geo/client';
import type { Coordinates } from '@arki/geo';

export function GoogleMapWithDistance() {
  const userLocation: Coordinates = { lat: 40.7128, lng: -74.0060 };
  const destination: Coordinates = { lat: 40.7589, lng: -73.9851 };

  const { distance, formatted } = useDistance(userLocation, destination, {
    unit: 'km',
    precision: 2,
  });

  return (
    <div>
      <p>Distance: {formatted}</p>
      <APIProvider apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!}>
        <Map
          defaultCenter={userLocation}
          defaultZoom={12}
          mapId="YOUR_MAP_ID"
          style={{ width: '100%', height: '500px' }}
        >
          <AdvancedMarker position={userLocation} />
          <AdvancedMarker position={destination} />
        </Map>
      </APIProvider>
    </div>
  );
}
```

#### Advanced Features

```typescript
'use client';

import {
  APIProvider,
  Map,
  AdvancedMarker,
  InfoWindow,
  useMapsLibrary
} from '@vis.gl/react-google-maps';
import { useEffect, useState } from 'react';
import type { Coordinates } from '@arki/geo';

export function GoogleMapAdvanced() {
  const [selectedMarker, setSelectedMarker] = useState<string | null>(null);

  // Load Places library dynamically
  const placesLib = useMapsLibrary('places');
  const [places, setPlaces] = useState<google.maps.places.PlaceResult[]>([]);

  useEffect(() => {
    if (!placesLib) return;

    const service = new placesLib.PlacesService(
      document.createElement('div')
    );

    // Search nearby places
    service.nearbySearch({
      location: { lat: 40.7128, lng: -74.0060 },
      radius: 1000,
      type: 'restaurant'
    }, (results, status) => {
      if (status === google.maps.places.PlacesServiceStatus.OK && results) {
        setPlaces(results);
      }
    });
  }, [placesLib]);

  return (
    <APIProvider apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY!}>
      <Map
        defaultCenter={{ lat: 40.7128, lng: -74.0060 }}
        defaultZoom={14}
        mapId="YOUR_MAP_ID"
        style={{ width: '100%', height: '500px' }}
      >
        {places.map((place, index) => (
          <AdvancedMarker
            key={index}
            position={place.geometry?.location}
            onClick={() => setSelectedMarker(place.place_id || null)}
          >
            {selectedMarker === place.place_id && (
              <InfoWindow
                position={place.geometry?.location}
                onCloseClick={() => setSelectedMarker(null)}
              >
                <div>
                  <h3>{place.name}</h3>
                  <p>{place.vicinity}</p>
                </div>
              </InfoWindow>
            )}
          </AdvancedMarker>
        ))}
      </Map>
    </APIProvider>
  );
}
```

### 2. Apple Maps (MapKit JS)

**Best for**: Apple ecosystem apps, Safari optimization, native iOS/macOS feel

#### Installation

```bash
pnpm add @arki/geo
# No additional package needed - MapKit JS loads via CDN
```

#### Setup

1. Get Apple Maps key from [developer.apple.com](https://developer.apple.com)
2. Create MapKit JS token endpoint

#### Basic Usage

```typescript
'use client';

import { useEffect, useRef } from 'react';
import type { Coordinates } from '@arki/geo';

declare global {
  interface Window {
    mapkit: any;
  }
}

export function AppleMapExample() {
  const mapRef = useRef<HTMLDivElement>(null);
  const center: Coordinates = { lat: 40.7128, lng: -74.0060 };

  useEffect(() => {
    if (!mapRef.current) return;

    // Load MapKit JS
    const script = document.createElement('script');
    script.src = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js';
    script.crossOrigin = 'anonymous';

    script.onload = () => {
      window.mapkit.init({
        authorizationCallback: (done) => {
          // Fetch token from your API
          fetch('/api/mapkit-token')
            .then(res => res.json())
            .then(data => done(data.token));
        }
      });

      const map = new window.mapkit.Map(mapRef.current);
      map.center = new window.mapkit.Coordinate(center.lat, center.lng);
      map.zoom = 12;

      // Add annotation (marker)
      const annotation = new window.mapkit.MarkerAnnotation(
        new window.mapkit.Coordinate(center.lat, center.lng),
        {
          title: 'Marker',
          color: '#FF0000'
        }
      );
      map.addAnnotation(annotation);
    };

    document.head.appendChild(script);

    return () => {
      script.remove();
    };
  }, [center]);

  return <div ref={mapRef} style={{ width: '100%', height: '500px' }} />;
}
```

#### Wrapper Component (Recommended)

```typescript
// src/maps/providers/apple/AppleMap.tsx
'use client';

import { useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import type { Coordinates } from '@arki/geo';

export type AppleMapProps = {
  center: Coordinates;
  zoom?: number;
  markers?: Array<{ position: Coordinates; title?: string }>;
  onMapLoad?: (map: any) => void;
  style?: React.CSSProperties;
};

export const AppleMap = forwardRef<any, AppleMapProps>((props, ref) => {
  const { center, zoom = 12, markers = [], onMapLoad, style } = props;
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);

  useImperativeHandle(ref, () => mapInstanceRef.current);

  useEffect(() => {
    if (!mapRef.current || window.mapkit) return;

    const script = document.createElement('script');
    script.src = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js';
    script.crossOrigin = 'anonymous';

    script.onload = () => {
      window.mapkit.init({
        authorizationCallback: (done: (token: string) => void) => {
          fetch('/api/mapkit-token')
            .then(res => res.json())
            .then(data => done(data.token))
            .catch(err => console.error('Failed to get MapKit token:', err));
        }
      });

      const map = new window.mapkit.Map(mapRef.current);
      map.center = new window.mapkit.Coordinate(center.lat, center.lng);
      map.zoom = zoom;

      mapInstanceRef.current = map;

      // Add markers
      markers.forEach(marker => {
        const annotation = new window.mapkit.MarkerAnnotation(
          new window.mapkit.Coordinate(marker.position.lat, marker.position.lng),
          { title: marker.title || '' }
        );
        map.addAnnotation(annotation);
      });

      onMapLoad?.(map);
    };

    document.head.appendChild(script);
  }, [center, zoom, markers, onMapLoad]);

  return (
    <div
      ref={mapRef}
      style={{ width: '100%', height: '500px', ...style }}
    />
  );
});

AppleMap.displayName = 'AppleMap';
```

### 3. Mapbox (react-map-gl)

**Best for**: Custom map styling, 3D maps, data visualization, animations

#### Installation

```bash
pnpm add @arki/geo react-map-gl mapbox-gl
```

#### Basic Usage

```typescript
'use client';

import Map, { Marker } from 'react-map-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Coordinates } from '@arki/geo';

export function MapboxExample() {
  const center: Coordinates = { lat: 40.7128, lng: -74.0060 };

  return (
    <Map
      mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN!}
      initialViewState={{
        longitude: center.lng,
        latitude: center.lat,
        zoom: 12
      }}
      style={{ width: '100%', height: '500px' }}
      mapStyle="mapbox://styles/mapbox/streets-v12"
    >
      <Marker
        longitude={center.lng}
        latitude={center.lat}
        anchor="bottom"
      >
        <div style={{ color: 'red', fontSize: '24px' }}>📍</div>
      </Marker>
    </Map>
  );
}
```

#### With Custom Styling

```typescript
'use client';

import Map, { Marker, Popup, NavigationControl } from 'react-map-gl';
import { useState } from 'react';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Coordinates } from '@arki/geo';

export function MapboxCustom() {
  const [viewState, setViewState] = useState({
    longitude: -74.0060,
    latitude: 40.7128,
    zoom: 12
  });

  const [selectedMarker, setSelectedMarker] = useState<Coordinates | null>(null);

  const markers: Array<{ position: Coordinates; title: string }> = [
    { position: { lat: 40.7128, lng: -74.0060 }, title: 'Marker 1' },
    { position: { lat: 40.7589, lng: -73.9851 }, title: 'Marker 2' },
  ];

  return (
    <Map
      {...viewState}
      onMove={evt => setViewState(evt.viewState)}
      mapboxAccessToken={process.env.NEXT_PUBLIC_MAPBOX_TOKEN!}
      style={{ width: '100%', height: '500px' }}
      mapStyle="mapbox://styles/mapbox/dark-v11" // Custom style
    >
      <NavigationControl position="top-right" />

      {markers.map((marker, index) => (
        <Marker
          key={index}
          longitude={marker.position.lng}
          latitude={marker.position.lat}
          anchor="bottom"
          onClick={(e) => {
            e.originalEvent.stopPropagation();
            setSelectedMarker(marker.position);
          }}
        >
          <div style={{ color: '#00ff00', fontSize: '24px' }}>📍</div>
        </Marker>
      ))}

      {selectedMarker && (
        <Popup
          longitude={selectedMarker.lng}
          latitude={selectedMarker.lat}
          anchor="bottom"
          onClose={() => setSelectedMarker(null)}
        >
          <div>Selected Location</div>
        </Popup>
      )}
    </Map>
  );
}
```

### 4. Leaflet (react-leaflet)

**Best for**: Open source projects, lightweight apps, OpenStreetMap integration

#### Installation

```bash
pnpm add @arki/geo react-leaflet leaflet @types/leaflet
```

#### Basic Usage

```typescript
'use client';

import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import type { Coordinates } from '@arki/geo';

// Fix default marker icons (required for Next.js)
import L from 'leaflet';
import icon from 'leaflet/dist/images/marker-icon.png';
import iconShadow from 'leaflet/dist/images/marker-shadow.png';

const DefaultIcon = L.icon({
  iconUrl: icon.src,
  shadowUrl: iconShadow.src,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

L.Marker.prototype.options.icon = DefaultIcon;

export function LeafletExample() {
  const center: Coordinates = { lat: 40.7128, lng: -74.0060 };

  return (
    <MapContainer
      center={[center.lat, center.lng]}
      zoom={12}
      style={{ width: '100%', height: '500px' }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <Marker position={[center.lat, center.lng]}>
        <Popup>
          New York City
        </Popup>
      </Marker>
    </MapContainer>
  );
}
```

#### With Multiple Tile Providers

```typescript
'use client';

import { MapContainer, TileLayer, Marker, LayersControl } from 'react-leaflet';
import { useState } from 'react';
import 'leaflet/dist/leaflet.css';
import type { Coordinates } from '@arki/geo';

export function LeafletMultiProvider() {
  const center: Coordinates = { lat: 40.7128, lng: -74.0060 };
  const [selectedProvider, setSelectedProvider] = useState('osm');

  const providers = {
    osm: {
      name: 'OpenStreetMap',
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; OpenStreetMap contributors'
    },
    satellite: {
      name: 'Esri Satellite',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      attribution: 'Tiles &copy; Esri'
    },
    topo: {
      name: 'OpenTopoMap',
      url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      attribution: 'Map data: &copy; OpenTopoMap'
    }
  };

  return (
    <div>
      <div style={{ marginBottom: '10px' }}>
        <select
          value={selectedProvider}
          onChange={(e) => setSelectedProvider(e.target.value)}
          style={{ padding: '8px' }}
        >
          {Object.entries(providers).map(([key, provider]) => (
            <option key={key} value={key}>
              {provider.name}
            </option>
          ))}
        </select>
      </div>

      <MapContainer
        center={[center.lat, center.lng]}
        zoom={12}
        style={{ width: '100%', height: '500px' }}
      >
        <TileLayer
          attribution={providers[selectedProvider as keyof typeof providers].attribution}
          url={providers[selectedProvider as keyof typeof providers].url}
        />
        <Marker position={[center.lat, center.lng]} />
      </MapContainer>
    </div>
  );
}
```

### 5. HERE Maps

**Best for**: Enterprise apps, logistics, routing, traffic data

#### Installation

```bash
pnpm add @arki/geo
# HERE Maps loads via CDN
```

#### Basic Usage

```typescript
'use client';

import { useEffect, useRef } from 'react';
import type { Coordinates } from '@arki/geo';

declare global {
  interface Window {
    H: any;
  }
}

export function HereMapExample() {
  const mapRef = useRef<HTMLDivElement>(null);
  const center: Coordinates = { lat: 40.7128, lng: -74.0060 };

  useEffect(() => {
    if (!mapRef.current) return;

    // Load HERE Maps scripts
    const loadScript = (src: string) => {
      return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    };

    Promise.all([
      loadScript('https://js.api.here.com/v3/3.1/mapsjs-core.js'),
      loadScript('https://js.api.here.com/v3/3.1/mapsjs-service.js'),
      loadScript('https://js.api.here.com/v3/3.1/mapsjs-ui.js'),
      loadScript('https://js.api.here.com/v3/3.1/mapsjs-mapevents.js'),
    ]).then(() => {
      const platform = new window.H.service.Platform({
        apikey: process.env.NEXT_PUBLIC_HERE_API_KEY
      });

      const defaultLayers = platform.createDefaultLayers();

      const map = new window.H.Map(
        mapRef.current,
        defaultLayers.vector.normal.map,
        {
          center: { lat: center.lat, lng: center.lng },
          zoom: 12,
          pixelRatio: window.devicePixelRatio || 1
        }
      );

      // Enable map interactions
      const behavior = new window.H.mapevents.Behavior(
        new window.H.mapevents.MapEvents(map)
      );

      // Add UI controls
      const ui = window.H.ui.UI.createDefault(map, defaultLayers);

      // Add marker
      const marker = new window.H.map.Marker({
        lat: center.lat,
        lng: center.lng
      });
      map.addObject(marker);
    });
  }, [center]);

  return <div ref={mapRef} style={{ width: '100%', height: '500px' }} />;
}
```

## 🔄 Unified Map Component

For apps that want provider flexibility:

```typescript
// src/maps/unified/UnifiedMap.tsx
'use client';

import { lazy, Suspense } from 'react';
import type { Coordinates } from '@arki/geo';

export type MapProvider = 'google' | 'apple' | 'mapbox' | 'leaflet' | 'here';

export type UnifiedMapProps = {
  provider: MapProvider;
  center: Coordinates;
  zoom?: number;
  markers?: Array<{ position: Coordinates; title?: string }>;
  style?: React.CSSProperties;
};

const GoogleMap = lazy(() => import('../providers/google/GoogleMap'));
const AppleMap = lazy(() => import('../providers/apple/AppleMap'));
const MapboxMap = lazy(() => import('../providers/mapbox/MapboxMap'));
const LeafletMap = lazy(() => import('../providers/leaflet/LeafletMap'));
const HereMap = lazy(() => import('../providers/here/HereMap'));

export function UnifiedMap(props: UnifiedMapProps) {
  const { provider, ...mapProps } = props;

  const MapComponent = {
    google: GoogleMap,
    apple: AppleMap,
    mapbox: MapboxMap,
    leaflet: LeafletMap,
    here: HereMap,
  }[provider];

  return (
    <Suspense fallback={<div style={props.style}>Loading map...</div>}>
      <MapComponent {...mapProps} />
    </Suspense>
  );
}
```

Usage:

```typescript
'use client';

import { UnifiedMap } from '@arki/geo/maps';
import type { Coordinates } from '@arki/geo';

export function FlexibleMapExample() {
  const center: Coordinates = { lat: 40.7128, lng: -74.0060 };

  return (
    <UnifiedMap
      provider="google" // Easy to switch!
      center={center}
      zoom={12}
      markers={[{ position: center, title: 'NYC' }]}
      style={{ width: '100%', height: '500px' }}
    />
  );
}
```

## 🖥️ Server-Side Map Utilities

### Static Map URLs

```typescript
// src/maps/server/static-maps.ts
import type { Coordinates } from '@arki/geo';

export type StaticMapProvider = 'google' | 'mapbox' | 'here';

export type StaticMapOptions = {
  center: Coordinates;
  zoom: number;
  width: number;
  height: number;
  markers?: Array<{ position: Coordinates; label?: string; color?: string }>;
  apiKey?: string;
};

export function generateStaticMapUrl(provider: StaticMapProvider, options: StaticMapOptions): string {
  const { center, zoom, width, height, markers = [], apiKey } = options;

  switch (provider) {
    case 'google': {
      const markersParam = markers
        .map(m => `markers=color:${m.color || 'red'}|label:${m.label || ''}|${m.position.lat},${m.position.lng}`)
        .join('&');

      return `https://maps.googleapis.com/maps/api/staticmap?center=${center.lat},${center.lng}&zoom=${zoom}&size=${width}x${height}&${markersParam}&key=${apiKey}`;
    }

    case 'mapbox': {
      const markersParam = markers.map(m => `pin-s+${m.color || 'red'}(${m.position.lng},${m.position.lat})`).join(',');

      return `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${markersParam}/${center.lng},${center.lat},${zoom}/${width}x${height}?access_token=${apiKey}`;
    }

    case 'here': {
      // HERE static maps implementation
      return `https://image.maps.ls.hereapi.com/mia/1.6/mapview?c=${center.lat},${center.lng}&z=${zoom}&w=${width}&h=${height}&apiKey=${apiKey}`;
    }

    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
```

Usage in Server Components:

```typescript
import { generateStaticMapUrl } from '@arki/geo/maps/server';
import type { Coordinates } from '@arki/geo';

export function StaticMapImage() {
  const center: Coordinates = { lat: 40.7128, lng: -74.0060 };

  const mapUrl = generateStaticMapUrl('google', {
    center,
    zoom: 12,
    width: 600,
    height: 400,
    markers: [{ position: center, label: 'A', color: 'blue' }],
    apiKey: process.env.GOOGLE_MAPS_API_KEY,
  });

  return <img src={mapUrl} alt="Map" width={600} height={400} />;
}
```

## 📊 Provider Selection Guide

| Use Case                 | Recommended Provider | Reason                          |
| ------------------------ | -------------------- | ------------------------------- |
| **Games (Then & There)** | Google Maps          | Best markers, comprehensive API |
| **Real Estate**          | Mapbox or Google     | Custom styling or places search |
| **Logistics/Delivery**   | HERE Maps            | Best routing and traffic data   |
| **Travel Apps**          | Google Maps          | Street View, places, transit    |
| **Apple App**            | Apple Maps           | Native feel, performance        |
| **Budget/Startup**       | Leaflet + OSM        | Free, no API key needed         |
| **Data Viz**             | Mapbox               | Custom styles, 3D support       |
| **Enterprise**           | HERE or Google       | SLAs, support contracts         |

## 🎯 Next Steps

1. Choose your provider(s)
2. Install required packages
3. Set up API keys/tokens
4. Implement basic map
5. Add markers and interactions
6. Integrate with @arki/geo utilities

## 📚 Additional Resources

- [Google Maps React Docs](https://visgl.github.io/react-google-maps/)
- [Apple MapKit JS Docs](https://developer.apple.com/documentation/mapkitjs)
- [Mapbox GL JS Docs](https://docs.mapbox.com/mapbox-gl-js/)
- [React Leaflet Docs](https://react-leaflet.js.org/)
- [HERE Maps Docs](https://developer.here.com/documentation)
