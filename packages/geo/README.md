# @arki/geo Package - Quick Reference

## 📋 Summary

Create a unified geospatial package that:

- **Consolidates** existing geocoding from `@arki/geo/geocoding`
- **Extracts** scattered distance calculation utilities
- **Separates** server-side (Node.js) and client-side (React) code
- **Prepares** for future maps, geofencing, and spatial features

## 🎯 Key Benefits

1. **No Bundle Bloat** - Frontend imports only lightweight utilities (~2KB), not Node.js geocoding libraries (~150KB)
2. **Single Source of Truth** - One Haversine distance implementation instead of 2+ scattered versions
3. **Type Safety** - Standardized `Coordinates` type across all apps
4. **Future Ready** - Clear structure for adding maps, clustering, routing
5. **Backward Compatible** - Migration maintains all existing APIs

## 📦 Package Structure

```
@arki/geo
├── Main export (server + shared)     → import from '@arki/geo'
├── Client export (React + core)      → import from '@arki/geo/react'
├── Core utilities (isomorphic)       → import from '@arki/geo/core'
└── Geocoding (server-only)           → import from '@arki/geo/geocoding'
```

## 🔑 Core Types

```typescript
// Standard coordinates (WGS84)
type Coordinates = {
  lat: number; // -90 to 90
  lng: number; // -180 to 180
};

// Geocoding result
type GeocodeResult = {
  coordinates: Coordinates;
  formattedAddress: string;
  addressComponents: AddressComponents;
  placeId?: string;
  provider: string;
};

// Bounding box
type Bounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};
```

## 🚀 Usage Patterns

### Backend: Geocoding

```typescript
import { AddressNotFound } from '@arki/geo';
import { createGeocodingServiceFromEnv } from '@arki/geo/geocoding';

const geocoding = createGeocodingServiceFromEnv(env, kv);
const result = await geocoding.geocode('1600 Amphitheatre Parkway');
if (AddressNotFound.is(result)) return result; // no provider knows this address
```

`geocode` returns `AddressNotFound` (`geo.address_not_found`, status 404, data `{ address }`) when every provider that answered found nothing. A provider with no results passes to the next one first. A missing address is not cached. When no provider answers, `geocode` returns `ProviderRateLimited` (with `retryAfterMs` from `Retry-After`), `ProviderUnreachable` (outage or timeout, `timeoutMs` in the config, default 10 s) or `ProviderRejected` (bad key), each with the list of attempts. A caller that aborts gets `GeocodingCancelled`. Import the failures from `@arki/geo`. `batchGeocode` maps each address to what `geocode` returned for it, or returns `GeocodingCancelled`.

`reverseGeocode(lat, lon)` follows the same rules. It returns `NoAddressAtLocation` (`geo.no_address_at_location`, status 404, data `{ latitude, longitude }`) when every provider that answered found no address there, such as a point at sea (Null Island, at 0, 0, is a good one). It is not cached either. Import it from `@arki/geo`. node-geocoder reports Google's `ZERO_RESULTS` and Nominatim's "Unable to geocode" as errors, not as an empty list. `reverseGeocode` treats those two as "nothing here" too. Any other provider error is a fault.

### Backend: Distance

```typescript
import { calculateDistance } from '@arki/geo';

const distance = calculateDistance(shop, adasHouse, 'km');
const isNearby = isWithinRadius(shop, adasHouse, 5); // inside the delivery zone
```

### Frontend: Distance Hook

```typescript
import { useDistance } from '@arki/geo/react';

const { distance, bearing, formatted } = useDistance(from, to, {
  unit: 'km',
  precision: 2,
});
```

### Frontend: Pure Calculations

```typescript
import { calculateDistance, formatCoordinates } from '@arki/geo/react';

const dist = calculateDistance(shop, adasHouse, 'mi');
```

## 🔄 Migration Checklist

### Backend Apps

- [ ] Replace `@arki/geo/geocoding` → `@arki/geo/geocoding`
- [ ] Replace local distance functions → `@arki/geo`
- [ ] Update `Coordinates` type to standard format
- [ ] Update package.json dependencies

### Frontend Apps

- [ ] Replace local distance functions → `@arki/geo/react`
- [ ] Update `Coordinates` type to standard format
- [ ] Never import from `@arki/geo` (server-only)
- [ ] Test bundle size (should be ~2KB)

## ⚠️ Critical Rules

### ✅ DO

- Import from `@arki/geo/react` in frontend code
- Use standard `{ lat, lng }` coordinates everywhere
- Use `calculateDistance()` from package, not local implementations

### ❌ DON'T

- Import `@arki/geo` in frontend (will bundle Node.js code)
- Import `@arki/geo/geocoding` in frontend
- Create new distance calculation implementations

## 📊 Current Duplications

**Distance Calculations (same Haversine formula):**

1. `apps/games-platform/web` - Frontend (Then & There game)
2. `apps/kapodopera/backend` - Backend (Location search)

**Will consolidate to:** `@arki/geo/core/distance.ts`

## �️ Map Providers (Enhanced)

### Supported Providers

1. **Google Maps** (@vis.gl/react-google-maps) - Comprehensive, best-in-class
2. **Apple Maps** (MapKit JS) - Native Apple ecosystem integration
3. **Mapbox** (react-map-gl) - Custom styling, 3D maps
4. **Leaflet** (react-leaflet) - Open source, lightweight
5. **HERE Maps** - Enterprise-grade logistics and routing

### Quick Start

```typescript
// Google Maps
import { APIProvider, Map, AdvancedMarker } from '@vis.gl/react-google-maps';

<APIProvider apiKey={key}>
  <Map defaultCenter={{lat: 40.7, lng: -74}} defaultZoom={12}>
    <AdvancedMarker position={{lat: 40.7, lng: -74}} />
  </Map>
</APIProvider>

// Mapbox
import Map, { Marker } from 'react-map-gl';

<Map
  mapboxAccessToken={token}
  initialViewState={{longitude: -74, latitude: 40.7, zoom: 12}}
  mapStyle="mapbox://styles/mapbox/streets-v12"
>
  <Marker longitude={-74} latitude={40.7} />
</Map>

// Leaflet (with OSM - no API key!)
import { MapContainer, TileLayer, Marker } from 'react-leaflet';

<MapContainer center={[40.7, -74]} zoom={12}>
  <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
  <Marker position={[40.7, -74]} />
</MapContainer>
```

### Provider Comparison

| Provider    | Best For        | Free Tier      | Bundle Size | API Key  |
| ----------- | --------------- | -------------- | ----------- | -------- |
| Google Maps | General purpose | 28k loads/mo   | ~120KB      | Required |
| Apple Maps  | Apple devices   | 250k views/day | ~80KB       | Required |
| Mapbox      | Custom styling  | 50k loads/mo   | ~200KB      | Required |
| Leaflet     | Open source     | Unlimited      | ~40KB       | Optional |
| HERE        | Enterprise      | 250k txns/mo   | ~150KB      | Required |

### Server-Side Features

```typescript
// Generate static map URLs
import { generateStaticMapUrl } from '@arki/geo/maps/server';

const mapUrl = generateStaticMapUrl('google', {
  center: { lat: 40.7, lng: -74 },
  zoom: 12,
  width: 600,
  height: 400,
  markers: [{ position: { lat: 40.7, lng: -74 }, label: 'A' }],
  apiKey: process.env.GOOGLE_MAPS_API_KEY,
});

// Use in Server Components
<img src={mapUrl} alt="Map" />
```

See **`MAP_PROVIDERS_GUIDE.md`** for complete implementation examples.

## 🔮 Future Features

- **Geofencing**: Point-in-polygon, radius checks
- **Clustering**: K-means, DBSCAN for marker clustering
- **Routing**: Simple distance-based routing
- **Geocoding UI**: Address autocomplete components

## 📅 Timeline

- **Week 1-2**: Create package structure + core utilities
- **Week 2-3**: Migrate geocoding service
- **Week 3**: Create React hooks
- **Week 4-5**: Update all consumers
- **Week 5**: Documentation
- **Week 6**: Deprecate `@arki/geo/geocoding`

**Total: 3-4 weeks**

## 📚 Full Documentation

See `GEO_IMPLEMENTATION_PLAN.md` for complete details.
