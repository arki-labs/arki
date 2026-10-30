/**
 * Type definitions for the geocoding service
 */

import { z } from 'zod';

/** Every supported provider, written once. The type, the env enum and the cache schema all read it. */
export const GEOCODING_PROVIDERS = [
  'google',
  'mapbox',
  'nominatim',
  'locationiq',
  'here',
  'opencage',
  'geocodio',
] as const;

/**
 * Supported geocoding providers
 */
export type GeocodingProvider = (typeof GEOCODING_PROVIDERS)[number];

/**
 * Address components following Schema.org PostalAddress structure.
 * `locality` is the city, `region` the state or province, `country` an ISO 3166-1 alpha-2 code.
 */
export const addressComponentsSchema = z.object({
  streetAddress: z.string().optional(),
  locality: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

export type AddressComponents = z.infer<typeof addressComponentsSchema>;

/**
 * Result from geocoding operation. Also the shape read back from the cache.
 */
export const geocodeResultSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  formattedAddress: z.string(),
  addressComponents: addressComponentsSchema,
  placeId: z.string().optional(),
  provider: z.enum(GEOCODING_PROVIDERS),
});

export type GeocodeResult = z.infer<typeof geocodeResultSchema>;

/**
 * Configuration for geocoding service
 */
export type GeocodingConfig = {
  provider: GeocodingProvider;
  fallbackProviders: GeocodingProvider[];
  google: {
    enabled: boolean;
    apiKey?: string;
  };
  mapbox: {
    enabled: boolean;
    accessToken?: string;
  };
  nominatim: {
    enabled: boolean;
    baseUrl?: string;
  };
  locationiq: {
    enabled: boolean;
    apiKey?: string;
  };
  here: {
    enabled: boolean;
    apiKey?: string;
    appId?: string;
  };
  opencage: {
    enabled: boolean;
    apiKey?: string;
  };
  geocodio: {
    enabled: boolean;
    apiKey?: string;
  };
  cache: {
    enabled: boolean;
    ttl: number; // Time to live in seconds
    keyPrefix: string;
  };
  /** Longest wait for one provider answer, in milliseconds. Default 10000. */
  timeoutMs?: number;
}
