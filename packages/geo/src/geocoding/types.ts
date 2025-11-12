/**
 * Type definitions for the geocoding service
 */

/**
 * Supported geocoding providers
 */
export type GeocodingProvider =
  | 'google'
  | 'mapbox'
  | 'nominatim'
  | 'locationiq'
  | 'here'
  | 'opencage'
  | 'geocodio';

/**
 * Address components following Schema.org PostalAddress structure
 */
export interface AddressComponents {
  streetAddress?: string;
  locality?: string; // City
  region?: string; // State/Province
  postalCode?: string;
  country?: string; // ISO 3166-1 alpha-2 country code
}

/**
 * Result from geocoding operation
 */
export interface GeocodeResult {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  addressComponents: AddressComponents;
  placeId?: string;
  provider: GeocodingProvider;
}

/**
 * Configuration for geocoding service
 */
export interface GeocodingConfig {
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
}
