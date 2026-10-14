# @arki/geo Package Implementation & Migration Plan

## 📋 Executive Summary

Create a comprehensive geospatial package `@arki/geo` that consolidates geocoding, distance calculations, coordinate utilities, and future map-related functionality. The package will be split into server-side and client-side (React) modules to ensure optimal bundle sizes and prevent unnecessary dependencies in frontend code.

## 🎯 Goals

1. **Consolidate** existing geocoding functionality from `@arki/geo/geocoding`
2. **Extract** reusable geospatial utilities from apps (distance calculations, coordinate transformations)
3. **Separate** server-side and client-side code for optimal tree-shaking
4. **Future-proof** architecture for maps, geofencing, and spatial queries
5. **Maintain** backward compatibility during migration

## 📦 Current State Analysis

### Existing `@arki/geo/geocoding` Package

**Location:** `packages/geocoding/`

**Features:**

- Multi-provider geocoding (Google, Mapbox, Nominatim, LocationIQ, HERE, OpenCage, Geocodio)
- Provider fallback chain
- KV-based caching (30-day TTL)
- Batch geocoding with concurrency control
- **Server-side only** (uses `node-geocoder` which requires Node.js)

**Dependencies:**

- `node-geocoder` (Node.js only)
- `@arki/kv` (server-side)
- `@arki/contracts`

**Usage:**

- `apps/kapodopera/backend` - Location geocoding
- `apps/games-platform/backend` - Then & There game reverse geocoding

### Scattered Geospatial Utilities

**Distance Calculations (Haversine Formula):**

1. `apps/games-platform/web/src/features/then-there/shared/data/historical-images.ts`
   - Frontend implementation for game scoring
   - Uses `Coordinates` type with `lat/lng` properties

2. `apps/kapodopera/backend/src/features/_shared/locations/repository.ts`
   - Backend implementation for proximity search
   - Uses raw `lat1, lon1, lat2, lon2` parameters
   - Part of location management system

**Coordinate Systems:**

- Frontend: `{ lat: number, lng: number }` (games-platform)
- Backend: separate parameters or string storage in DB

## 🏗️ Proposed Package Structure

```
packages/geo/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                    # Main exports (server + shared)
│   ├── client.ts                   # React-specific exports
│   │
│   ├── core/                       # Shared utilities (isomorphic)
│   │   ├── index.ts
│   │   ├── types.ts                # Common types (Coordinates, Bounds, etc.)
│   │   ├── distance.ts             # Haversine formula, bearing calculations
│   │   ├── coordinates.ts          # Coordinate validation, normalization
│   │   ├── conversions.ts          # DMS to decimal, unit conversions
│   │   └── bounds.ts               # Bounding box calculations
│   │
│   ├── geocoding/                  # Server-side geocoding (Node.js only)
│   │   ├── index.ts
│   │   ├── service.ts              # Main GeocodingService class
│   │   ├── types.ts                # Provider types, configs
│   │   ├── env.ts                  # T3 Env configuration
│   │   └── providers/              # Future: individual provider implementations
│   │       ├── google.ts
│   │       ├── mapbox.ts
│   │       └── nominatim.ts
│   │
│   ├── react/                      # React components and hooks
│   │   ├── index.ts
│   │   ├── hooks/
│   │   │   ├── useCoordinates.ts   # Coordinate state management
│   │   │   ├── useDistance.ts      # Distance calculations
│   │   │   └── useBounds.ts        # Bounding box utilities
│   │   └── components/             # Future: Map components
│   │       └── index.ts
│   │
│   └── future/                     # Placeholder for future features
│       ├── geofencing.ts           # Point-in-polygon, geofences
│       ├── clustering.ts           # Marker clustering algorithms
│       └── routing.ts              # Simple routing utilities
```

## 📝 Type Definitions

### Core Types (`src/core/types.ts`)

```typescript
/**
 * Standard coordinate representation (WGS84)
 * Uses 'lat' and 'lng' for consistency with Google Maps, Mapbox, Leaflet
 */
export type Coordinates = {
  lat: number; // Latitude: -90 to 90
  lng: number; // Longitude: -180 to 180
};

/**
 * Alternative coordinate representation for compatibility
 */
export type LatLon = {
  latitude: number;
  longitude: number;
};

/**
 * Geographic bounding box
 */
export type Bounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

/**
 * Point with optional metadata
 */
export type GeoPoint = Coordinates & {
  id?: string;
  label?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Distance result with units
 */
export type Distance = {
  value: number;
  unit: 'km' | 'mi' | 'm' | 'ft';
};

/**
 * Address components (Schema.org PostalAddress structure)
 */
export type AddressComponents = {
  streetAddress?: string;
  locality?: string; // City
  region?: string; // State/Province
  postalCode?: string;
  country?: string; // ISO 3166-1 alpha-2 country code
};

/**
 * Geocoding result
 */
export type GeocodeResult = {
  coordinates: Coordinates;
  formattedAddress: string;
  addressComponents: AddressComponents;
  placeId?: string;
  provider: string;
  confidence?: number;
};
```

## 🔧 Implementation Details

### 1. Core Distance Module (`src/core/distance.ts`)

**Server-side safe, frontend-optimized**

```typescript
import type { Coordinates, Distance } from './types';

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param from - Starting coordinates
 * @param to - Ending coordinates
 * @param unit - Distance unit (default: 'km')
 * @returns Distance value
 */
export function calculateDistance(from: Coordinates, to: Coordinates, unit: 'km' | 'mi' | 'm' | 'ft' = 'km'): number {
  const R = unit === 'km' ? 6371 : unit === 'mi' ? 3959 : unit === 'm' ? 6371000 : 20902231;

  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((from.lat * Math.PI) / 180) * Math.cos((to.lat * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculate bearing (direction) from one point to another
 * @returns Bearing in degrees (0-360)
 */
export function calculateBearing(from: Coordinates, to: Coordinates): number {
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const bearing = Math.atan2(y, x) * (180 / Math.PI);

  return (bearing + 360) % 360;
}

/**
 * Get midpoint between two coordinates
 */
export function getMidpoint(from: Coordinates, to: Coordinates): Coordinates {
  const lat1 = (from.lat * Math.PI) / 180;
  const lng1 = (from.lng * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const dLng = ((to.lng - from.lng) * Math.PI) / 180;

  const bx = Math.cos(lat2) * Math.cos(dLng);
  const by = Math.cos(lat2) * Math.sin(dLng);

  const lat = Math.atan2(
    Math.sin(lat1) + Math.sin(lat2),
    Math.sqrt((Math.cos(lat1) + bx) * (Math.cos(lat1) + bx) + by * by),
  );
  const lng = lng1 + Math.atan2(by, Math.cos(lat1) + bx);

  return {
    lat: (lat * 180) / Math.PI,
    lng: (lng * 180) / Math.PI,
  };
}

/**
 * Check if a point is within a certain radius of a center point
 */
export function isWithinRadius(center: Coordinates, point: Coordinates, radiusKm: number): boolean {
  return calculateDistance(center, point, 'km') <= radiusKm;
}
```

### 2. Coordinate Utilities (`src/core/coordinates.ts`)

```typescript
import type { Bounds, Coordinates, LatLon } from './types';

/**
 * Validate coordinates
 */
export function isValidCoordinates(coords: Partial<Coordinates>): coords is Coordinates {
  return (
    typeof coords.lat === 'number' &&
    typeof coords.lng === 'number' &&
    coords.lat >= -90 &&
    coords.lat <= 90 &&
    coords.lng >= -180 &&
    coords.lng <= 180
  );
}

/**
 * Normalize longitude to -180 to 180 range
 */
export function normalizeLongitude(lng: number): number {
  return ((lng + 180) % 360) - 180;
}

/**
 * Convert LatLon to Coordinates
 */
export function toCoordinates(latLon: LatLon): Coordinates {
  return {
    lat: latLon.latitude,
    lng: latLon.longitude,
  };
}

/**
 * Convert Coordinates to LatLon
 */
export function toLatLon(coords: Coordinates): LatLon {
  return {
    latitude: coords.lat,
    longitude: coords.lng,
  };
}

/**
 * Parse coordinates from string (e.g., "40.7128,-74.0060")
 */
export function parseCoordinates(str: string): Coordinates | null {
  const parts = str.split(',').map(s => parseFloat(s.trim()));
  if (parts.length !== 2 || parts.some(isNaN)) return null;

  const coords = { lat: parts[0]!, lng: parts[1]! };
  return isValidCoordinates(coords) ? coords : null;
}

/**
 * Format coordinates as string
 */
export function formatCoordinates(coords: Coordinates, precision: number = 6): string {
  return `${coords.lat.toFixed(precision)},${coords.lng.toFixed(precision)}`;
}
```

### 3. Bounding Box Utilities (`src/core/bounds.ts`)

```typescript
import type { Bounds, Coordinates } from './types';

/**
 * Calculate bounding box from center point and radius
 */
export function getBoundsFromRadius(center: Coordinates, radiusKm: number): Bounds {
  // Approximate degrees per km
  const latDegPerKm = 1 / 111;
  const lngDegPerKm = 1 / (111 * Math.cos((center.lat * Math.PI) / 180));

  return {
    north: center.lat + radiusKm * latDegPerKm,
    south: center.lat - radiusKm * latDegPerKm,
    east: center.lng + radiusKm * lngDegPerKm,
    west: center.lng - radiusKm * lngDegPerKm,
  };
}

/**
 * Calculate bounding box from array of coordinates
 */
export function getBoundsFromPoints(points: Coordinates[]): Bounds | null {
  if (points.length === 0) return null;

  return points.reduce(
    (bounds, point) => ({
      north: Math.max(bounds.north, point.lat),
      south: Math.min(bounds.south, point.lat),
      east: Math.max(bounds.east, point.lng),
      west: Math.min(bounds.west, point.lng),
    }),
    {
      north: points[0]!.lat,
      south: points[0]!.lat,
      east: points[0]!.lng,
      west: points[0]!.lng,
    },
  );
}

/**
 * Check if coordinates are within bounds
 */
export function isWithinBounds(coords: Coordinates, bounds: Bounds): boolean {
  return (
    coords.lat >= bounds.south && coords.lat <= bounds.north && coords.lng >= bounds.west && coords.lng <= bounds.east
  );
}

/**
 * Get center of bounding box
 */
export function getBoundsCenter(bounds: Bounds): Coordinates {
  return {
    lat: (bounds.north + bounds.south) / 2,
    lng: (bounds.east + bounds.west) / 2,
  };
}
```

### 4. React Hooks (`src/react/hooks/useDistance.ts`)

```typescript
'use client';

import { useMemo } from 'react';

import type { Coordinates } from '../../core/types';
import { calculateBearing, calculateDistance } from '../../core/distance';

export type UseDistanceOptions = {
  unit?: 'km' | 'mi' | 'm' | 'ft';
  precision?: number;
};

export function useDistance(from: Coordinates | null, to: Coordinates | null, options: UseDistanceOptions = {}) {
  const { unit = 'km', precision = 2 } = options;

  const distance = useMemo(() => {
    if (!from || !to) return null;
    return calculateDistance(from, to, unit);
  }, [from, to, unit]);

  const bearing = useMemo(() => {
    if (!from || !to) return null;
    return calculateBearing(from, to);
  }, [from, to]);

  const formatted = useMemo(() => {
    if (distance === null) return null;
    return `${distance.toFixed(precision)} ${unit}`;
  }, [distance, precision, unit]);

  return {
    distance,
    bearing,
    formatted,
    unit,
  };
}
```

### 5. Geocoding Service (Server-only) (`src/geocoding/service.ts`)

**Migrate from `@arki/geo/geocoding` with minimal changes**

## 📦 Package Configuration

```json
{
  "name": "@arki/geo",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    },
    "./client": {
      "types": "./src/client.ts",
      "default": "./src/client.ts"
    },
    "./core": {
      "types": "./src/core/index.ts",
      "default": "./src/core/index.ts"
    },
    "./geocoding": {
      "types": "./src/geocoding/index.ts",
      "default": "./src/geocoding/index.ts"
    },
    "./maps/google": {
      "types": "./src/maps/providers/google/index.ts",
      "default": "./src/maps/providers/google/index.ts"
    },
    "./maps/apple": {
      "types": "./src/maps/providers/apple/index.ts",
      "default": "./src/maps/providers/apple/index.ts"
    },
    "./maps/mapbox": {
      "types": "./src/maps/providers/mapbox/index.ts",
      "default": "./src/maps/providers/mapbox/index.ts"
    },
    "./maps/leaflet": {
      "types": "./src/maps/providers/leaflet/index.ts",
      "default": "./src/maps/providers/leaflet/index.ts"
    },
    "./maps/here": {
      "types": "./src/maps/providers/here/index.ts",
      "default": "./src/maps/providers/here/index.ts"
    },
    "./maps": {
      "types": "./src/maps/unified/index.ts",
      "default": "./src/maps/unified/index.ts"
    },
    "./maps/server": {
      "types": "./src/maps/server/index.ts",
      "default": "./src/maps/server/index.ts"
    }
  },
  "scripts": {
    "clean": "git clean -xdf .cache .turbo dist node_modules",
    "dev": "tsc",
    "format": "prettier --check . --ignore-path ../../.gitignore",
    "lint": "eslint",
    "typecheck": "tsc --noEmit --emitDeclarationOnly false",
    "build": "tsc"
  },
  "dependencies": {
    "@arki/contracts": "workspace:*",
    "@arki/kv": "workspace:*",
    "@t3-oss/env-core": "catalog:env",
    "node-geocoder": "catalog:",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@arki/eslint-config": "workspace:*",
    "@arki/prettier-config": "workspace:*",
    "@arki/tsconfig": "workspace:*",
    "@arki/vitest-config": "workspace:*",
    "@types/node-geocoder": "catalog:types",
    "@types/react": "catalog:react18",
    "react": "catalog:react18",
    "typescript": "catalog:"
  },
  "peerDependencies": {
    "react": "^18.0.0 || ^19.0.0",
    "@vis.gl/react-google-maps": "^1.7.0",
    "react-map-gl": "^7.1.0",
    "mapbox-gl": "^3.0.0",
    "react-leaflet": "^4.2.0",
    "leaflet": "^1.9.0"
  },
  "peerDependenciesMeta": {
    "react": {
      "optional": true
    },
    "@vis.gl/react-google-maps": {
      "optional": true
    },
    "react-map-gl": {
      "optional": true
    },
    "mapbox-gl": {
      "optional": true
    },
    "react-leaflet": {
      "optional": true
    },
    "leaflet": {
      "optional": true
    }
  }
}
```

### Installation Strategy

Users install only the map providers they need:

```bash
# Core package (required)
pnpm add @arki/geo

# Google Maps
pnpm add @vis.gl/react-google-maps

# Mapbox
pnpm add react-map-gl mapbox-gl

# Leaflet
pnpm add react-leaflet leaflet @types/leaflet

# Apple Maps (no additional package needed - uses CDN)

# HERE Maps (custom implementation - no package needed)
```

### Export Strategy

**Main export (`src/index.ts`)** - Server + Shared:

```typescript
// Core utilities (isomorphic - safe for frontend)
export * from './core';

// Server-only geocoding
export * from './geocoding';
```

**Client export (`src/client.ts`)** - React only:

```typescript
// Only export client-safe modules
export * from './core';
export * from './react';

// Re-export useful core utilities
export { calculateDistance, calculateBearing } from './core/distance';
export { isValidCoordinates, formatCoordinates } from './core/coordinates';
```

## 🔄 Migration Plan

### Phase 1: Create Package Structure ✅

**Timeline:** Week 1

1. Create `packages/geo` directory
2. Set up `package.json` with proper exports
3. Set up `tsconfig.json`
4. Create folder structure

### Phase 2: Migrate Core Utilities ✅

**Timeline:** Week 1-2

1. **Extract distance calculations:**
   - From `apps/games-platform/web/src/features/then-there/shared/data/historical-images.ts`
   - From `apps/kapodopera/backend/src/features/_shared/locations/repository.ts`
   - Standardize to single implementation in `src/core/distance.ts`

2. **Create coordinate utilities:**
   - Validation functions
   - Conversion functions
   - Format/parse functions

3. **Create bounding box utilities:**
   - From radius calculations
   - From point arrays
   - Containment checks

4. **Add comprehensive tests:**
   - Test Haversine formula accuracy
   - Test edge cases (poles, date line)
   - Test coordinate validation

### Phase 3: Migrate Geocoding Service ✅

**Timeline:** Week 2-3

1. **Copy `@arki/geo/geocoding` to `src/geocoding/`:**
   - Move service class
   - Move types
   - Move environment config
   - Update imports

2. **Update dependencies:**
   - Keep `node-geocoder` dependency
   - Keep `@arki/kv` dependency

3. **Maintain backward compatibility:**
   - Keep same API surface
   - Same function signatures
   - Same return types

### Phase 4: Create React Hooks ✅

**Timeline:** Week 3

1. **Implement hooks:**
   - `useDistance()` - Distance calculations
   - `useCoordinates()` - Coordinate state
   - `useBounds()` - Bounding box calculations

2. **Ensure proper React patterns:**
   - Use `useMemo` for expensive calculations
   - Proper dependency arrays
   - TypeScript types

### Phase 5: Update Consumers (Breaking Changes) ⚠️

**Timeline:** Week 4-5

#### Backend Applications

**`apps/kapodopera/backend`:**

```diff
- import { createGeocodingServiceFromEnv } from '@arki/geo/geocoding';
+ import { createGeocodingServiceFromEnv } from '@arki/geo/geocoding';

- import type { GeocodeResult } from '@arki/geo/geocoding';
+ import type { GeocodeResult } from '@arki/geo';
```

**Update location repository:**

```diff
- private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
-   const R = 6371;
-   // ... Haversine implementation
- }
+ import { calculateDistance } from '@arki/geo/core';
+
+ private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
+   return calculateDistance({ lat: lat1, lng: lon1 }, { lat: lat2, lng: lon2 }, 'km');
+ }
```

**`apps/games-platform/backend`:**

```diff
- import { GeocodingService } from '@arki/geo/geocoding';
+ import { GeocodingService } from '@arki/geo/geocoding';
```

#### Frontend Applications

**`apps/games-platform/web`:**

```diff
- import { calculateDistance } from '../../shared/data/historical-images';
+ import { calculateDistance } from '@arki/geo/react';

// Update Coordinates type if needed
- type Coordinates = { lat: number; lng: number };
+ import type { Coordinates } from '@arki/geo';
```

**Update scoring utilities:**

```diff
- export function calculateDistance(coord1: Coordinates, coord2: Coordinates): number {
-   const R = 6371;
-   // ... implementation
- }
+ // Remove local implementation, import from @arki/geo
+ import { calculateDistance } from '@arki/geo/react';
```

### Phase 6: Update Documentation ✅

**Timeline:** Week 5

1. Update README files
2. Add migration guide
3. Update JSDoc comments
4. Add usage examples

### Phase 7: Deprecate Old Package 🔚

**Timeline:** Week 6

1. Mark `@arki/geo/geocoding` as deprecated
2. Add deprecation notices
3. Update package.json
4. Plan removal timeline

## 🎯 Usage Examples

### Backend: Geocoding

```typescript
import { createGeocodingServiceFromEnv } from '@arki/geo/geocoding';
import { kv } from '@arki/kv';

import { env } from './env';

const geocoding = createGeocodingServiceFromEnv(env, kv);

const result = await geocoding.geocode('1600 Amphitheatre Parkway, Mountain View, CA');
console.log(result.coordinates); // { lat: 37.4224764, lng: -122.0842499 }
```

### Backend: Distance Calculations

```typescript
import type { Coordinates } from '@arki/geo';
import { calculateDistance, isWithinRadius } from '@arki/geo';

const userLocation: Coordinates = { lat: 40.7128, lng: -74.006 };
const storeLocation: Coordinates = { lat: 40.7589, lng: -73.9851 };

const distance = calculateDistance(userLocation, storeLocation, 'km');
console.log(`Store is ${distance.toFixed(2)} km away`);

const isNearby = isWithinRadius(userLocation, storeLocation, 5);
console.log(`Store is nearby: ${isNearby}`);
```

### Frontend: React Hook

```typescript
'use client';

import { useDistance } from '@arki/geo/react';
import type { Coordinates } from '@arki/geo';

export function DistanceDisplay({
  from,
  to
}: {
  from: Coordinates;
  to: Coordinates
}) {
  const { distance, bearing, formatted } = useDistance(from, to, {
    unit: 'km',
    precision: 2,
  });

  return (
    <div>
      <p>Distance: {formatted}</p>
      <p>Bearing: {bearing?.toFixed(0)}°</p>
    </div>
  );
}
```

### Frontend: Core Utilities Only

```typescript
import { calculateDistance, formatCoordinates } from '@arki/geo/react';

// No React needed for pure calculations
const distance = calculateDistance({ lat: 40.7128, lng: -74.006 }, { lat: 34.0522, lng: -118.2437 }, 'mi');

console.log(`Distance: ${distance.toFixed(0)} miles`);
```

## 🔒 Bundle Size Optimization

### Import Paths Strategy

✅ **Correct - Client-safe imports:**

```typescript
// Frontend - only imports core utilities, no node-geocoder
import { calculateDistance, useDistance } from '@arki/geo/react';
```

✅ **Correct - Server imports:**

```typescript
// Backend - can import everything
import { calculateDistance, createGeocodingServiceFromEnv } from '@arki/geo';
```

❌ **Wrong - Frontend importing server code:**

```typescript
// Will cause build error or bloat bundle
import { GeocodingService } from '@arki/geo';
```

### Tree-Shaking Verification

Test with:

```bash
# Analyze bundle size
pnpm build --filter=@app/web
npx bundle-analyzer .next/static/chunks/*.js
```

Expected results:

- `@arki/geo/react` imports: ~2KB (core utilities only)
- `@arki/geo` imports: ~150KB (includes node-geocoder)

## 📊 Testing Strategy

### Unit Tests (`src/core/distance.test.ts`)

```typescript
import { describe, expect, it } from 'vitest';

import { calculateBearing, calculateDistance } from './distance';

describe('calculateDistance', () => {
  it('calculates distance between two points', () => {
    const nyc = { lat: 40.7128, lng: -74.006 };
    const la = { lat: 34.0522, lng: -118.2437 };

    const distance = calculateDistance(nyc, la, 'km');
    expect(distance).toBeCloseTo(3936, 0); // ~3936 km
  });

  it('handles same point', () => {
    const point = { lat: 40.7128, lng: -74.006 };
    expect(calculateDistance(point, point)).toBe(0);
  });

  it('handles antipodal points', () => {
    const north = { lat: 45, lng: 0 };
    const south = { lat: -45, lng: 180 };
    const distance = calculateDistance(north, south, 'km');
    expect(distance).toBeCloseTo(20015, 0); // Half Earth's circumference
  });
});
```

## 🚨 Breaking Changes

### For Consumers of `@arki/geo/geocoding`

1. **Import paths changed:**

   ```diff
   - import { ... } from '@arki/geo/geocoding';
   + import { ... } from '@arki/geo/geocoding';
   ```

2. **Type names unchanged** - All existing types remain the same

3. **API unchanged** - All functions have the same signatures

### For Apps Using Distance Calculations

1. **Must standardize on `Coordinates` type:**

   ```typescript
   type Coordinates = { lat: number; lng: number };
   ```

2. **Remove local implementations** - Use centralized version

## �️ Map Provider Integration

### Supported Providers

#### 1. **Google Maps** (Primary - @vis.gl/react-google-maps)

- **React Library**: `@vis.gl/react-google-maps` (Official, modern, TypeScript-first)
- **Why**: Most feature-complete, best documentation, official support
- **Features**:
  - Advanced markers
  - InfoWindows
  - Drawing tools
  - Street View
  - Places API integration
  - Excellent TypeScript support
- **Pricing**: Free tier: $200/month credit (~28k map loads)

#### 2. **Apple Maps** (MapKit JS)

- **React Library**: Custom wrapper around MapKit JS SDK
- **Why**: Best for Apple ecosystem integration, Safari optimization
- **Features**:
  - Native iOS/macOS look and feel
  - Annotations (markers)
  - Overlays
  - Directions
  - Search
- **Pricing**: Free tier: 250k map views/day, 25k service requests/day
- **Note**: Requires Apple Developer account

#### 3. **Mapbox** (react-map-gl)

- **React Library**: `react-map-gl` (Official Mapbox wrapper)
- **Why**: Best for custom styling, vector tiles, 3D maps
- **Features**:
  - Custom map styles
  - 3D buildings
  - Terrain
  - Satellite imagery
  - Animation support
- **Pricing**: Free tier: 50k map loads/month

#### 4. **Leaflet** (react-leaflet)

- **React Library**: `react-leaflet` (Most popular open-source)
- **Why**: Open source, largest plugin ecosystem, lightweight
- **Features**:
  - 1000+ plugins
  - Mobile-friendly
  - Works with any tile provider
  - No API key required (with OSM tiles)
- **Pricing**: Free (with OpenStreetMap tiles)

#### 5. **HERE Maps**

- **React Library**: Custom wrapper around HERE Maps API
- **Why**: Excellent for logistics, routing, large enterprise apps
- **Features**:
  - Excellent routing
  - Traffic data
  - Indoor maps
  - Fleet management
- **Pricing**: Free tier: 250k transactions/month

### Provider Comparison Matrix

| Feature           | Google Maps     | Apple Maps      | Mapbox         | Leaflet      | HERE                 |
| ----------------- | --------------- | --------------- | -------------- | ------------ | -------------------- |
| **Best For**      | General purpose | Apple devices   | Custom styling | Open source  | Enterprise/Logistics |
| **TypeScript**    | ✅ Excellent    | ⚠️ Manual types | ✅ Excellent   | ✅ Good      | ⚠️ Manual types      |
| **Free Tier**     | 28k loads/mo    | 250k views/day  | 50k loads/mo   | Unlimited    | 250k txns/mo         |
| **Bundle Size**   | ~120KB          | ~80KB           | ~200KB         | ~40KB        | ~150KB               |
| **React Support** | ✅ Official     | ⚠️ Custom       | ✅ Official    | ✅ Community | ⚠️ Custom            |
| **3D Support**    | ✅              | ❌              | ✅             | ❌           | ⚠️ Limited           |
| **Custom Tiles**  | ❌              | ❌              | ✅             | ✅           | ❌                   |
| **Offline**       | ❌              | ✅              | ✅             | ✅           | ⚠️ Limited           |

### Recommended Usage by App Type

**Games/Interactive**: Google Maps or Mapbox
**Apple Ecosystem Apps**: Apple Maps
**Budget/Open Source**: Leaflet + OSM
**Enterprise/Logistics**: HERE Maps
**Custom Styling**: Mapbox
**General Purpose**: Google Maps

## 📦 Enhanced Package Dependencies

### Maps Integration (Enhanced)

```
src/maps/
├── core/                       # Map abstraction layer
│   ├── types.ts                # Common map types (MapProvider, MapConfig, etc.)
│   ├── base-map.tsx            # Abstract base map component
│   └── provider-factory.ts     # Map provider factory
├── providers/
│   ├── google/                 # Google Maps (@vis.gl/react-google-maps)
│   │   ├── GoogleMap.tsx
│   │   ├── GoogleMarker.tsx
│   │   ├── GoogleInfoWindow.tsx
│   │   └── types.ts
│   ├── apple/                  # Apple MapKit JS
│   │   ├── AppleMap.tsx
│   │   ├── AppleMarker.tsx
│   │   ├── AppleAnnotation.tsx
│   │   └── types.ts
│   ├── mapbox/                 # Mapbox GL JS (react-map-gl)
│   │   ├── MapboxMap.tsx
│   │   ├── MapboxMarker.tsx
│   │   ├── MapboxPopup.tsx
│   │   └── types.ts
│   ├── leaflet/                # Leaflet (react-leaflet)
│   │   ├── LeafletMap.tsx
│   │   ├── LeafletMarker.tsx
│   │   ├── LeafletPopup.tsx
│   │   └── types.ts
│   └── here/                   # HERE Maps
│       ├── HereMap.tsx
│       ├── HereMarker.tsx
│       └── types.ts
├── unified/                    # Unified API (provider-agnostic)
│   ├── UnifiedMap.tsx          # Adapter that wraps any provider
│   ├── UnifiedMarker.tsx
│   └── UnifiedInfoWindow.tsx
└── server/                     # Server-side map utilities
    ├── static-maps.ts          # Generate static map URLs
    ├── embed-urls.ts           # Generate embed URLs
    └── thumbnails.ts           # Map thumbnail generation
```

### Geofencing

```typescript
// src/geofencing/polygon.ts
export function isPointInPolygon(point: Coordinates, polygon: Coordinates[]): boolean {
  // Ray casting algorithm
}
```

### Spatial Queries

```typescript
// src/spatial/clustering.ts
export function clusterPoints(points: GeoPoint[], maxDistance: number): GeoPoint[][] {
  // K-means or DBSCAN clustering
}
```

## ✅ Acceptance Criteria

### For Migration Completion

- [ ] All existing `@arki/geo/geocoding` functionality works in `@arki/geo`
- [ ] All apps using geocoding migrated to new package
- [ ] All apps using distance calculations migrated to shared utilities
- [ ] Frontend bundles do NOT include `node-geocoder`
- [ ] All tests passing
- [ ] Documentation complete
- [ ] Zero breaking changes for end users

### For Package Quality

- [ ] TypeScript strict mode enabled
- [ ] 100% type coverage
- [ ] All public functions have JSDoc
- [ ] README with examples
- [ ] Test coverage > 80%

## 📅 Timeline Summary

| Phase                  | Duration      | Status     |
| ---------------------- | ------------- | ---------- |
| 1. Package Structure   | 1-2 days      | ⏳ Pending |
| 2. Core Utilities      | 3-4 days      | ⏳ Pending |
| 3. Geocoding Migration | 3-4 days      | ⏳ Pending |
| 4. React Hooks         | 2-3 days      | ⏳ Pending |
| 5. Consumer Updates    | 5-7 days      | ⏳ Pending |
| 6. Documentation       | 2-3 days      | ⏳ Pending |
| 7. Deprecation         | 1 day         | ⏳ Pending |
| **Total**              | **3-4 weeks** |            |

## 🎓 Key Decisions

1. **Use `lat/lng` not `latitude/longitude`** - More concise, matches Google Maps API
2. **Separate client/server exports** - Prevents accidental Node.js imports in frontend
3. **Keep geocoding service intact** - Minimal changes to battle-tested code
4. **Use peerDependencies for React** - Allow optional React usage
5. **Standardize Haversine implementation** - Single source of truth

## 📚 References

- [Haversine Formula](https://en.wikipedia.org/wiki/Haversine_formula)
- [WGS84 Coordinate System](https://en.wikipedia.org/wiki/World_Geodetic_System)
- [node-geocoder Documentation](https://github.com/nchaulet/node-geocoder)
- [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/)
- [Google Maps Platform](https://developers.google.com/maps)
