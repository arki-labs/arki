/**
 * Geocoding Service
 *
 * A wrapper around node-geocoder providing:
 * - Multiple provider support (Google Maps, Mapbox, Nominatim, LocationIQ, HERE, OpenCage, Geocodio)
 * - Provider fallback chain for reliability
 * - KV-based caching (30-day TTL)
 * - Batch geocoding with concurrency control
 * - Type-safe configuration
 */

import type { KV } from '@arki/kv';
import type { Entry, Options } from 'node-geocoder';
import NodeGeocoder from 'node-geocoder';

import { GeocodingError } from '../core/errors';
import type {
  AddressComponents,
  GeocodeResult,
  GeocodingConfig,
  GeocodingProvider,
} from './types';

export class GeocodingService {
  private geocoders: Map<GeocodingProvider, NodeGeocoder.Geocoder>;
  private primaryProvider: GeocodingProvider;
  private fallbackProviders: GeocodingProvider[];
  private kv?: KV;
  private cacheEnabled: boolean;
  private cacheTTL: number;
  private cacheKeyPrefix: string;

  constructor(config: GeocodingConfig, kv?: KV) {
    this.geocoders = new Map();
    this.primaryProvider = config.provider;
    this.fallbackProviders = config.fallbackProviders;
    this.kv = kv;
    this.cacheEnabled = config.cache.enabled;
    this.cacheTTL = config.cache.ttl;
    this.cacheKeyPrefix = config.cache.keyPrefix;

    // Initialize geocoders for each enabled provider
    if (config.google.enabled && config.google.apiKey) {
      const options: Options = {
        provider: 'google',
        apiKey: config.google.apiKey,
        formatter: null,
      };
      this.geocoders.set('google', NodeGeocoder(options));
    }

    if (config.mapbox.enabled && config.mapbox.accessToken) {
      const options: Options = {
        provider: 'mapbox',
        apiKey: config.mapbox.accessToken,
        formatter: null,
      };
      this.geocoders.set('mapbox', NodeGeocoder(options));
    }

    if (config.nominatim.enabled) {
      const options: Options = {
        provider: 'openstreetmap',
        formatter: null,
        osmServer: config.nominatim.baseUrl,
      };
      this.geocoders.set('nominatim', NodeGeocoder(options));
    }

    if (config.locationiq.enabled && config.locationiq.apiKey) {
      const options: Options = {
        provider: 'locationiq',
        apiKey: config.locationiq.apiKey,
        formatter: null,
      };
      this.geocoders.set('locationiq', NodeGeocoder(options));
    }

    if (config.here.enabled && config.here.apiKey && config.here.appId) {
      const options: Options = {
        provider: 'here',
        apiKey: config.here.apiKey,
        appId: config.here.appId,
        formatter: null,
      };
      this.geocoders.set('here', NodeGeocoder(options));
    }

    if (config.opencage.enabled && config.opencage.apiKey) {
      const options: Options = {
        provider: 'opencage',
        apiKey: config.opencage.apiKey,
        formatter: null,
      };
      this.geocoders.set('opencage', NodeGeocoder(options));
    }

    if (config.geocodio.enabled && config.geocodio.apiKey) {
      const options: Options = {
        provider: 'geocodio',
        apiKey: config.geocodio.apiKey,
        formatter: null,
      };
      this.geocoders.set('geocodio', NodeGeocoder(options));
    }
  }

  /**
   * Geocode an address to coordinates
   */
  async geocode(
    address: string,
    preferredProvider?: GeocodingProvider,
  ): Promise<GeocodeResult> {
    // Check cache first
    if (this.cacheEnabled && this.kv) {
      const cacheKey = `${this.cacheKeyPrefix}${this.hashAddress(address)}`;
      const cached = await this.kv.get<GeocodeResult>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Try primary provider first (or preferred if specified)
    const providerOrder = preferredProvider
      ? [
          preferredProvider,
          ...this.fallbackProviders.filter((p) => p !== preferredProvider),
        ]
      : [this.primaryProvider, ...this.fallbackProviders];

    let lastError: Error | null = null;

    for (const providerName of providerOrder) {
      const geocoder = this.geocoders.get(providerName);
      if (!geocoder) continue;

      try {
        const results = await geocoder.geocode(address);

        if (!results || results.length === 0) {
          throw new GeocodingError(
            `No results found for address: ${address}`,
            providerName,
          );
        }

        const firstResult = results[0];
        if (!firstResult) {
          throw new GeocodingError(
            `No results found for address: ${address}`,
            providerName,
          );
        }

        const result = this.transformResult(firstResult, providerName);

        // Cache successful result
        if (this.cacheEnabled && this.kv) {
          const cacheKey = `${this.cacheKeyPrefix}${this.hashAddress(address)}`;
          await this.kv.set(cacheKey, result, this.cacheTTL);
        }

        return result;
      } catch (error) {
        lastError = error as Error;
        console.warn(`Geocoding failed with provider ${providerName}:`, error);
        continue;
      }
    }

    throw new GeocodingError(
      `All geocoding providers failed. Last error: ${lastError?.message}`,
      this.primaryProvider,
      lastError ?? undefined,
    );
  }

  /**
   * Reverse geocode coordinates to an address
   */
  async reverseGeocode(
    lat: number,
    lon: number,
    preferredProvider?: GeocodingProvider,
  ): Promise<GeocodeResult> {
    // Check cache first
    if (this.cacheEnabled && this.kv) {
      const cacheKey = `${this.cacheKeyPrefix}reverse:${lat},${lon}`;
      const cached = await this.kv.get<GeocodeResult>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Try primary provider first (or preferred if specified)
    const providerOrder = preferredProvider
      ? [
          preferredProvider,
          ...this.fallbackProviders.filter((p) => p !== preferredProvider),
        ]
      : [this.primaryProvider, ...this.fallbackProviders];

    let lastError: Error | null = null;

    for (const providerName of providerOrder) {
      const geocoder = this.geocoders.get(providerName);
      if (!geocoder) continue;

      try {
        const results = await geocoder.reverse({ lat, lon });

        if (!results || results.length === 0) {
          throw new GeocodingError(
            `No results found for coordinates: ${lat}, ${lon}`,
            providerName,
          );
        }

        const firstResult = results[0];
        if (!firstResult) {
          throw new GeocodingError(
            `No results found for coordinates: ${lat}, ${lon}`,
            providerName,
          );
        }

        const result = this.transformResult(firstResult, providerName);

        // Cache successful result
        if (this.cacheEnabled && this.kv) {
          const cacheKey = `${this.cacheKeyPrefix}reverse:${lat},${lon}`;
          await this.kv.set(cacheKey, result, this.cacheTTL);
        }

        return result;
      } catch (error) {
        lastError = error as Error;
        console.warn(`Reverse geocoding failed with provider ${providerName}:`, error);
        continue;
      }
    }

    throw new GeocodingError(
      `All reverse geocoding providers failed. Last error: ${lastError?.message}`,
      this.primaryProvider,
      lastError ?? undefined,
    );
  }

  /**
   * Batch geocode multiple addresses
   * Processes in parallel with rate limiting
   */
  async batchGeocode(
    addresses: string[],
    concurrency = 5,
  ): Promise<Map<string, GeocodeResult | Error>> {
    const results = new Map<string, GeocodeResult | Error>();
    const queue = [...addresses];

    const processNext = async (): Promise<void> => {
      const address = queue.shift();
      if (!address) return;

      try {
        const result = await this.geocode(address);
        results.set(address, result);
      } catch (error) {
        results.set(address, error as Error);
      }

      if (queue.length > 0) {
        await processNext();
      }
    };

    // Start concurrent workers
    await Promise.all(Array.from({ length: concurrency }, () => processNext()));

    return results;
  }

  /**
   * Transform node-geocoder Entry to our GeocodeResult format
   */
  private transformResult(entry: Entry, provider: GeocodingProvider): GeocodeResult {
    const addressComponents: AddressComponents = {
      streetAddress: entry.streetName
        ? `${entry.streetNumber || ''} ${entry.streetName}`.trim()
        : undefined,
      locality: entry.city ?? undefined,
      region:
        entry.state ?? entry.administrativeLevels?.level1short ?? undefined,
      postalCode: entry.zipcode ?? undefined,
      country: entry.countryCode ?? undefined,
    };

    return {
      latitude: entry.latitude ?? 0,
      longitude: entry.longitude ?? 0,
      formattedAddress: entry.formattedAddress ?? '',
      addressComponents,
      placeId: entry.extra?.googlePlaceId ?? undefined,
      provider,
    };
  }

  /**
   * Hash address for cache key generation
   */
  private hashAddress(address: string): string {
    return address
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
  }
}

/**
 * Create geocoding service instance from configuration
 */
export function createGeocodingService(
  config: GeocodingConfig,
  kv?: KV,
): GeocodingService {
  return new GeocodingService(config, kv);
}
