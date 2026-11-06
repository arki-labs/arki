/**
 * Type definitions for the geocoding service
 */

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
export type AddressComponents = {
  streetAddress?: string | undefined;
  locality?: string | undefined;
  region?: string | undefined;
  postalCode?: string | undefined;
  country?: string | undefined;
};

/**
 * Result from geocoding operation. Also the shape read back from the cache. `latitude` is in [-90, 90],
 * `longitude` in [-180, 180]. `geocodeResultSchema` (`@arki/geo/zod`) checks it.
 */
export type GeocodeResult = {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  addressComponents: AddressComponents;
  placeId?: string | undefined;
  provider: GeocodingProvider;
};

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
