import { defineEnv } from '@arki/env/core';
import { z } from 'zod';

export const geocodingEnv = defineEnv({
  name: '@arki/geo',
  server: {
    // Primary provider configuration
    GEOCODING_PROVIDER: z
      .enum(['google', 'mapbox', 'nominatim', 'locationiq', 'here', 'opencage', 'geocodio'])
      .default('nominatim'),
    GEOCODING_FALLBACK_PROVIDERS: z.string().default('nominatim'),

    // Provider API keys
    GOOGLE_MAPS_API_KEY: z.string().optional(),
    MAPBOX_ACCESS_TOKEN: z.string().optional(),
    NOMINATIM_BASE_URL: z.string().optional(),
    LOCATIONIQ_API_KEY: z.string().optional(),
    HERE_API_KEY: z.string().optional(),
    HERE_APP_ID: z.string().optional(),
    OPENCAGE_API_KEY: z.string().optional(),
    GEOCODIO_API_KEY: z.string().optional(),

    // Cache configuration
    GEOCODING_CACHE_ENABLED: z.coerce.boolean().default(true),
    GEOCODING_CACHE_TTL: z.coerce.number().default(2_592_000), // 30 days in seconds
    GEOCODING_CACHE_KEY_PREFIX: z.string().default('geo:'),
  },
  options: {
    skipValidation:
      !!process.env['CI'] ||
      !!process.env['SKIP_ENV_VALIDATION'] ||
      process.env['npm_lifecycle_event'] === 'lint',
  },
});

export type GeocodingEnv = typeof geocodingEnv;
