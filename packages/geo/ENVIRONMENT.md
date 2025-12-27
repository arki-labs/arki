# Environment Variables Configuration

## Required Environment Variables

### Geocoding Providers

```bash
# Google Maps
GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here

# Mapbox
MAPBOX_ACCESS_TOKEN=your_mapbox_token_here

# HERE Maps
HERE_APP_ID=your_here_app_id
HERE_APP_CODE=your_here_app_code

# OpenCage
OPENCAGE_API_KEY=your_opencage_key

# LocationIQ
LOCATIONIQ_API_KEY=your_locationiq_key

# Geocodio (US only)
GEOCODIO_API_KEY=your_geocodio_key
```

### Map Providers

```bash
# Google Maps (for @vis.gl/react-google-maps)
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=your_google_maps_api_key

# Mapbox (for react-map-gl)
NEXT_PUBLIC_MAPBOX_TOKEN=your_mapbox_token

# Apple Maps (for MapKit JS)
NEXT_PUBLIC_APPLE_MAPS_TOKEN=your_apple_maps_jwt_token
APPLE_MAPS_TEAM_ID=your_apple_team_id
APPLE_MAPS_KEY_ID=your_apple_key_id
APPLE_MAPS_PRIVATE_KEY=your_apple_private_key

# HERE Maps
NEXT_PUBLIC_HERE_API_KEY=your_here_api_key
```

## Environment Variable Setup with T3 Env

### Backend Environment (`packages/geo/src/geocoding/env.ts`)

```typescript
import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const geoEnv = createEnv({
  server: {
    // Geocoding providers (server-side only)
    GOOGLE_MAPS_API_KEY: z.string().optional(),
    MAPBOX_ACCESS_TOKEN: z.string().optional(),
    HERE_APP_ID: z.string().optional(),
    HERE_APP_CODE: z.string().optional(),
    OPENCAGE_API_KEY: z.string().optional(),
    LOCATIONIQ_API_KEY: z.string().optional(),
    GEOCODIO_API_KEY: z.string().optional(),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.CI || !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === 'lint',
});
```

### Frontend Environment (App-level, e.g., `apps/*/web/src/env.ts`)

```typescript
import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

export const env = createEnv({
  client: {
    // Map providers (client-side - exposed to browser)
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: z.string().optional(),
    NEXT_PUBLIC_MAPBOX_TOKEN: z.string().optional(),
    NEXT_PUBLIC_APPLE_MAPS_TOKEN: z.string().optional(),
    NEXT_PUBLIC_HERE_API_KEY: z.string().optional(),
  },
  runtimeEnv: {
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY,
    NEXT_PUBLIC_MAPBOX_TOKEN: process.env.NEXT_PUBLIC_MAPBOX_TOKEN,
    NEXT_PUBLIC_APPLE_MAPS_TOKEN: process.env.NEXT_PUBLIC_APPLE_MAPS_TOKEN,
    NEXT_PUBLIC_HERE_API_KEY: process.env.NEXT_PUBLIC_HERE_API_KEY,
  },
  skipValidation: !!process.env.CI || !!process.env.SKIP_ENV_VALIDATION || process.env.npm_lifecycle_event === 'lint',
});
```

## API Key Restrictions

### Google Maps API Key Restrictions

**Application Restrictions:**

- HTTP referrers (for web): `your-domain.com/*`
- IP addresses (for backend): Your server IPs

**API Restrictions:**

- Maps JavaScript API (for frontend)
- Geocoding API (for backend)
- Places API (if using autocomplete)

### Mapbox Token Scopes

Required scopes:

- `styles:read` - Read map styles
- `fonts:read` - Read fonts
- `tiles:read` - Read vector tiles

Optional scopes:

- `geocoding:read` - For geocoding
- `directions:read` - For routing

### Apple Maps Setup

1. Create a Maps ID at [Apple Developer Console](https://developer.apple.com/maps/)
2. Generate a JWT token using your private key:

```typescript
// Server-side token generation
import fs from 'fs';
import jwt from 'jsonwebtoken';

function generateAppleMapsToken() {
  const privateKey = fs.readFileSync('path/to/AuthKey_XXXXX.p8', 'utf8');

  const token = jwt.sign(
    {
      iss: process.env.APPLE_MAPS_TEAM_ID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 15778800, // 6 months
    },
    privateKey,
    {
      algorithm: 'ES256',
      header: {
        kid: process.env.APPLE_MAPS_KEY_ID,
        typ: 'JWT',
      },
    },
  );

  return token;
}
```

## Security Best Practices

### 1. Never Commit API Keys

Add to `.gitignore`:

```
.env
.env.local
.env.*.local
```

### 2. Use Different Keys for Development and Production

```bash
# .env.local (development)
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=dev_key_here

# .env.production (production - in deployment platform)
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=prod_key_here
```

### 3. Rotate Keys Regularly

- Set up calendar reminders to rotate API keys quarterly
- Keep old keys active for a brief overlap period during rotation
- Update all deployments before disabling old keys

### 4. Monitor API Usage

Set up alerts for:

- Unexpected spikes in API calls
- Approaching quota limits
- Unauthorized access attempts

### 5. Use Environment-Specific Restrictions

**Development:**

```
HTTP referrers: localhost:3000/*, 127.0.0.1:3000/*
```

**Staging:**

```
HTTP referrers: staging.your-domain.com/*
```

**Production:**

```
HTTP referrers: your-domain.com/*
```

## Troubleshooting

### "API key not valid" Error

1. Check key is correctly set in environment file
2. Verify key restrictions match your domain
3. Ensure API is enabled in cloud console
4. Wait 5 minutes after creating/updating key

### Geocoding Returns No Results

1. Verify geocoding API key has correct permissions
2. Check you're using correct provider for your region
3. Ensure rate limits haven't been exceeded
4. Validate input address format

### Map Not Loading

1. Check `NEXT_PUBLIC_*` prefix for client-side variables
2. Verify environment file is loaded (restart dev server)
3. Check browser console for specific error messages
4. Ensure map provider dependencies are installed

## Example .env.local File

```bash
# Backend geocoding (server-side)
GOOGLE_MAPS_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
MAPBOX_ACCESS_TOKEN=pk.eyJ1IjoieW91ciIsImEiOiJYWFhYWFhYWFgifQ.XXXXX

# Frontend maps (client-side)
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
NEXT_PUBLIC_MAPBOX_TOKEN=pk.eyJ1IjoieW91ciIsImEiOiJYWFhYWFhYWFgifQ.XXXXX

# Redis for geocoding cache (optional)
REDIS_URL=redis://localhost:6379

# Postgres for spatial data (optional)
DB_URL=postgresql://user:pass@localhost:5432/db
```

## Loading Environment Variables in Different Contexts

### Next.js (App Router)

```typescript
// app/layout.tsx - Server Component
import { geoEnv } from '@arki/geo/geocoding/env';

// Server-side geocoding
const geocodingService = new GeocodingService({
  providers: [
    {
      name: 'google',
      apiKey: geoEnv.GOOGLE_MAPS_API_KEY,
    },
  ],
});
```

### tRPC Backend

```typescript
// backend/src/env.ts
import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const env = createEnv({
  server: {
    GOOGLE_MAPS_API_KEY: z.string().min(1),
    MAPBOX_ACCESS_TOKEN: z.string().min(1),
  },
  runtimeEnv: process.env,
});
```

### React Client Components

```typescript
'use client';

// Must use NEXT_PUBLIC_ prefix to expose to browser
const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

if (!apiKey) {
  throw new Error('Google Maps API key not configured');
}
```
