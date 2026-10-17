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

import type { FailureOf } from '@arki/failure';

import { GeocodingAbortedError, GeocodingError } from '../core/errors';
import { AddressNotFound } from '../core/failures';
import type {
  AddressComponents,
  GeocodeResult,
  GeocodingConfig,
  GeocodingProvider,
} from './types';

/** The slice of `KV` the service needs. Any store with `get` and `set` fits. */
export type GeocodingCache = Pick<KV, 'get' | 'set'>;

/**
 * Options shared by every lookup.
 *
 * `signal` cancels the lookup. It is checked before each provider attempt and
 * between batch items. node-geocoder does not accept a signal, so a request
 * that is already in flight finishes in the background; the lookup itself
 * rejects with `GeocodingAbortedError` at the next check.
 */
export interface GeocodingOptions {
  signal?: AbortSignal;
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw new GeocodingAbortedError(undefined, signal.reason);
};

export class GeocodingService {
  private geocoders: Map<GeocodingProvider, NodeGeocoder.Geocoder>;
  private primaryProvider: GeocodingProvider;
  private fallbackProviders: GeocodingProvider[];
  private kv?: GeocodingCache;
  private cacheEnabled: boolean;
  private cacheTTL: number;
  private cacheKeyPrefix: string;

  constructor(config: GeocodingConfig, kv?: GeocodingCache) {
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
   * Geocode an address to coordinates.
   *
   * Returns `AddressNotFound` when every provider that answered found nothing
   * (a provider with no results passes to the next one). Throws
   * `GeocodingError` when no provider answered at all.
   */
  async geocode(
    address: string,
    preferredProvider?: GeocodingProvider,
    options: GeocodingOptions = {},
  ) {
    const { signal } = options;
    throwIfAborted(signal);

    // Check cache first
    if (this.cacheEnabled && this.kv) {
      const cacheKey = `${this.cacheKeyPrefix}${this.hashAddress(address)}`;
      const cached = await this.kv.get<GeocodeResult>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Try primary provider first (or preferred if specified)
    const providerOrder = this.getProviderOrder(preferredProvider);

    let lastError: Error | null = null;
    let answeredWithNoResults = false;

    for (const providerName of providerOrder) {
      const geocoder = this.geocoders.get(providerName);
      if (!geocoder) continue;
      throwIfAborted(signal);

      try {
        const results = await geocoder.geocode(address);
        throwIfAborted(signal);

        const firstResult = results[0];
        if (!firstResult) {
          answeredWithNoResults = true;
          continue;
        }

        const result = this.transformResult(firstResult, providerName);

        // Cache successful result
        if (this.cacheEnabled && this.kv) {
          const cacheKey = `${this.cacheKeyPrefix}${this.hashAddress(address)}`;
          await this.kv.set(cacheKey, result, this.cacheTTL);
        }

        return result;
      } catch (error) {
        if (error instanceof GeocodingAbortedError) throw error;
        lastError = error as Error;
        console.warn(`Geocoding failed with provider ${providerName}:`, error);
        continue;
      }
    }

    if (answeredWithNoResults) return AddressNotFound({ address });

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
    options: GeocodingOptions = {},
  ): Promise<GeocodeResult> {
    const { signal } = options;
    throwIfAborted(signal);

    // Check cache first
    if (this.cacheEnabled && this.kv) {
      const cacheKey = `${this.cacheKeyPrefix}reverse:${lat},${lon}`;
      const cached = await this.kv.get<GeocodeResult>(cacheKey);
      if (cached) {
        return cached;
      }
    }

    // Try primary provider first (or preferred if specified)
    const providerOrder = this.getProviderOrder(preferredProvider);

    let lastError: Error | null = null;

    for (const providerName of providerOrder) {
      const geocoder = this.geocoders.get(providerName);
      if (!geocoder) continue;
      throwIfAborted(signal);

      try {
        const results = await geocoder.reverse({ lat, lon });
        throwIfAborted(signal);

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
        if (error instanceof GeocodingAbortedError) throw error;
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
   *
   * Each address maps to its result, its `AddressNotFound`, or the error it threw.
   */
  async batchGeocode(
    addresses: string[],
    concurrency = 5,
    options: GeocodingOptions = {},
  ): Promise<Map<string, GeocodeResult | FailureOf<GeocodingService['geocode']> | Error>> {
    const { signal } = options;
    throwIfAborted(signal);
    const results = new Map<string, GeocodeResult | FailureOf<GeocodingService['geocode']> | Error>();
    const queue = [...addresses];

    const processNext = async (): Promise<void> => {
      throwIfAborted(signal);
      const address = queue.shift();
      if (!address) return;

      try {
        const result = await this.geocode(address, undefined, { signal });
        results.set(address, result);
      } catch (error) {
        if (error instanceof GeocodingAbortedError) throw error;
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
   * Providers to try, in order: the preferred one (if any), then the primary,
   * then the fallbacks. Each provider appears once.
   */
  private getProviderOrder(preferredProvider?: GeocodingProvider): GeocodingProvider[] {
    const ordered = preferredProvider
      ? [preferredProvider, this.primaryProvider, ...this.fallbackProviders]
      : [this.primaryProvider, ...this.fallbackProviders];
    return [...new Set(ordered)];
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
      .replaceAll(/\s+/g, '-')
      .replaceAll(/[^a-z0-9-]/g, '');
  }
}

/**
 * Create geocoding service instance from configuration
 */
export function createGeocodingService(
  config: GeocodingConfig,
  kv?: GeocodingCache,
): GeocodingService {
  return new GeocodingService(config, kv);
}
