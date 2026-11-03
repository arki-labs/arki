/**
 * Geocoding Service
 *
 * A wrapper around node-geocoder providing:
 * - Multiple provider support (Google Maps, Mapbox, Nominatim, LocationIQ, HERE, OpenCage, Geocodio)
 * - Provider fallback chain for reliability
 * - KV-based caching (30-day TTL)
 * - Batch geocoding with concurrency control
 * - Type-safe configuration
 *
 * Every expected outcome is returned, never thrown: a result, "nothing found",
 * "rate limited" (with the provider's Retry-After), "provider refused",
 * "provider unreachable" or "cancelled".
 */

import type { Entry, Options } from 'node-geocoder';
import NodeGeocoder from 'node-geocoder';
import nodeFetch from 'node-fetch';

import { invariant, isFailure } from '@arki/failure';
import type { KV } from '@arki/kv';
import { getLogger } from '@arki/log';

import { isValidCoordinates } from '../core/coordinates.js';
import {
  AddressNotFound,
  GeocodingCancelled,
  InvalidCoordinates,
  NoAddressAtLocation,
  ProviderRateLimited,
  ProviderRejected,
  ProviderUnreachable,
} from '../core/failures.js';
import type { ProviderAttempt } from '../core/failures.js';
import { geocodeResultSchema } from './types.js';
import type {
  AddressComponents,
  GeocodeResult,
  GeocodingConfig,
  GeocodingProvider,
} from './types.js';

const log = getLogger('arki:geo');

/** Longest wait for one provider answer when the config sets no `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** The slice of `KV` the service needs. Any store with `get` and `set` fits. */
export type GeocodingCache = Pick<KV, 'get' | 'set'>;

/**
 * Options shared by every lookup.
 *
 * `signal` cancels the lookup. It is passed to the HTTP request of each
 * provider, so an in-flight request is cut off. A cancelled lookup returns
 * `GeocodingCancelled`.
 */
export type GeocodingOptions = {
  signal?: AbortSignal;
};

/** What a forward or reverse lookup returns. */
export type GeocodeOutcome = Awaited<ReturnType<GeocodingService['geocode']>>;

/** What `batchGeocode` records for one address: everything a lookup returns except cancellation. */
export type BatchGeocodeEntry = Exclude<GeocodeOutcome, ReturnType<typeof GeocodingCancelled>>;

/**
 * True when a reverse lookup error is really the answer "no address here".
 * node-geocoder throws for these instead of returning an empty list, so they
 * would otherwise look like a provider fault:
 * - Google: the status `ZERO_RESULTS` (node-geocoder says "Status is ZERO_RESULTS.").
 * - Nominatim: the error "Unable to geocode", sent for a point with no address.
 * Any other error is a provider fault.
 */
const isNoAddressError = (provider: GeocodingProvider, error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (provider === 'google') return /\bZERO_RESULTS\b/.test(error.message);
  if (provider === 'nominatim') return error.message === 'Unable to geocode';
  return false;
};

/** `Retry-After` is whole seconds or an HTTP date. Returns milliseconds, or undefined when absent or unreadable. */
const retryAfterMs = (header: string | null): number | undefined => {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
};

/** What the HTTP layer saw for the last answer of one attempt. node-geocoder hides the status, so it is recorded here. */
type SeenResponse = { status?: number; retryAfterMs?: number };

const RATE_LIMIT_MESSAGE = /OVER_QUERY_LIMIT|OVER_DAILY_LIMIT|rate.?limit|too many requests/i;
const REJECTED_MESSAGE = /REQUEST_DENIED|INVALID_REQUEST|invalid.{0,20}(?:key|token)|forbidden|unauthori[sz]ed/i;

/** Sorts a provider error into rate limited, refused (retry gives the same answer) or unreachable (retry may work). */
const classify = (
  provider: GeocodingProvider,
  error: unknown,
  seen: SeenResponse,
): ProviderAttempt & { retryAfterMs?: number } => {
  const message = error instanceof Error ? error.message : String(error);
  const { status } = seen;
  if (status === 429 || RATE_LIMIT_MESSAGE.test(message)) {
    return { provider, kind: 'rate_limited', message, retryAfterMs: seen.retryAfterMs };
  }
  if (status === 400 || status === 401 || status === 402 || status === 403 || REJECTED_MESSAGE.test(message)) {
    return { provider, kind: 'rejected', message };
  }
  return { provider, kind: 'unreachable', message };
};

/** Every form an API key can take in a provider message: as configured, and as encoded into the request URL. */
const secretForms = (secret: string): string[] => [
  secret,
  encodeURIComponent(secret),
  new URLSearchParams({ secret }).toString().slice('secret='.length),
];

type Lookup =
  | { kind: 'found'; result: GeocodeResult }
  | { kind: 'failed'; answeredWithNoResults: boolean; attempts: (ProviderAttempt & { retryAfterMs?: number })[] }
  | { kind: 'cancelled' };

export class GeocodingService {
  private providerOptions: Map<GeocodingProvider, Options>;
  private primaryProvider: GeocodingProvider;
  private fallbackProviders: GeocodingProvider[];
  private kv?: GeocodingCache;
  private cacheEnabled: boolean;
  private cacheTTL: number;
  private cacheKeyPrefix: string;
  private timeoutMs: number;
  /** The configured API keys in every form they can appear in a message. Removed from each provider message. */
  private secrets: string[];

  constructor(config: GeocodingConfig, kv?: GeocodingCache) {
    this.providerOptions = new Map();
    this.primaryProvider = config.provider;
    this.fallbackProviders = config.fallbackProviders;
    this.kv = kv;
    this.cacheEnabled = config.cache.enabled;
    this.cacheTTL = config.cache.ttl;
    this.cacheKeyPrefix = config.cache.keyPrefix;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Remember the options of each enabled provider. A geocoder is built per
    // attempt, because each attempt has its own signal and timeout.
    if (config.google.enabled && config.google.apiKey) {
      this.providerOptions.set('google', { provider: 'google', apiKey: config.google.apiKey, formatter: null });
    }

    if (config.mapbox.enabled && config.mapbox.accessToken) {
      this.providerOptions.set('mapbox', { provider: 'mapbox', apiKey: config.mapbox.accessToken, formatter: null });
    }

    if (config.nominatim.enabled) {
      this.providerOptions.set('nominatim', {
        provider: 'openstreetmap',
        formatter: null,
        osmServer: config.nominatim.baseUrl,
      });
    }

    if (config.locationiq.enabled && config.locationiq.apiKey) {
      this.providerOptions.set('locationiq', {
        provider: 'locationiq',
        apiKey: config.locationiq.apiKey,
        formatter: null,
      });
    }

    if (config.here.enabled && config.here.apiKey && config.here.appId) {
      this.providerOptions.set('here', {
        provider: 'here',
        apiKey: config.here.apiKey,
        appId: config.here.appId,
        formatter: null,
      });
    }

    if (config.opencage.enabled && config.opencage.apiKey) {
      this.providerOptions.set('opencage', {
        provider: 'opencage',
        apiKey: config.opencage.apiKey,
        formatter: null,
      });
    }

    if (config.geocodio.enabled && config.geocodio.apiKey) {
      this.providerOptions.set('geocodio', { provider: 'geocodio', apiKey: config.geocodio.apiKey, formatter: null });
    }

    this.secrets = [
      ...new Set(
        [...this.providerOptions.values()].flatMap((options) =>
          'apiKey' in options && options.apiKey ? secretForms(options.apiKey) : [],
        ),
      ),
    ];
  }

  /**
   * Geocode an address to coordinates.
   *
   * Returns `AddressNotFound` when every provider that answered found nothing
   * (a provider with no results passes to the next one). When no provider
   * answered at all, returns `ProviderRateLimited`, `ProviderUnreachable` or
   * `ProviderRejected`, each listing every attempt. Returns `GeocodingCancelled`
   * when the signal aborts. A cache fault is logged and treated as a miss.
   */
  async geocode(address: string, preferredProvider?: GeocodingProvider, options: GeocodingOptions = {}) {
    const { signal } = options;
    if (signal?.aborted) return GeocodingCancelled();

    const cacheKey = `${this.cacheKeyPrefix}${this.hashAddress(address)}`;
    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    const lookup = await this.lookup(
      preferredProvider,
      signal,
      (geocoder) => geocoder.geocode(address),
      () => false,
    );
    if (lookup.kind === 'cancelled') return GeocodingCancelled();
    if (lookup.kind === 'found') {
      await this.writeCache(cacheKey, lookup.result);
      return lookup.result;
    }
    if (lookup.answeredWithNoResults) return AddressNotFound({ address });
    return this.providerFailure(lookup.attempts);
  }

  /**
   * Reverse geocode coordinates to an address.
   *
   * Returns `InvalidCoordinates` for a latitude or longitude that is not
   * finite or out of range, and `NoAddressAtLocation` when every provider that
   * answered found no address there (a provider with no results passes to the
   * next one). Provider faults and cancellation are returned as for `geocode`.
   */
  async reverseGeocode(
    lat: number,
    lon: number,
    preferredProvider?: GeocodingProvider,
    options: GeocodingOptions = {},
  ) {
    const { signal } = options;
    if (signal?.aborted) return GeocodingCancelled();
    if (!isValidCoordinates({ lat, lng: lon })) {
      return InvalidCoordinates({
        reason: `lat=${lat}, lng=${lon}. Latitude must be between -90 and 90, longitude between -180 and 180.`,
      });
    }

    const cacheKey = `${this.cacheKeyPrefix}reverse:${lat},${lon}`;
    const cached = await this.readCache(cacheKey);
    if (cached) return cached;

    const lookup = await this.lookup(
      preferredProvider,
      signal,
      (geocoder) => geocoder.reverse({ lat, lon }),
      isNoAddressError,
    );
    if (lookup.kind === 'cancelled') return GeocodingCancelled();
    if (lookup.kind === 'found') {
      await this.writeCache(cacheKey, lookup.result);
      return lookup.result;
    }
    if (lookup.answeredWithNoResults) return NoAddressAtLocation({ latitude: lat, longitude: lon });
    return this.providerFailure(lookup.attempts);
  }

  /**
   * Batch geocode multiple addresses
   * Processes in parallel with rate limiting
   *
   * Each address maps to what `geocode` returned for it. An empty or blank
   * address is recorded as `AddressNotFound` without asking a provider, and
   * never stops the batch. Returns `GeocodingCancelled` if the signal aborts,
   * and starts no new lookups after that. `concurrency` must be a whole
   * number of at least 1; anything else is a bug in the caller and throws.
   */
  async batchGeocode(addresses: string[], concurrency = 5, options: GeocodingOptions = {}) {
    invariant(
      Number.isInteger(concurrency) && concurrency >= 1,
      () => `batchGeocode concurrency must be a whole number of at least 1, got ${concurrency}`,
    );
    const { signal } = options;
    if (signal?.aborted) return GeocodingCancelled();
    const results = new Map<string, BatchGeocodeEntry>();
    const queue = [...addresses];
    let cancelled = false;

    const worker = async (): Promise<void> => {
      for (let address = queue.shift(); address !== undefined; address = queue.shift()) {
        if (cancelled || signal?.aborted) {
          cancelled = true;
          return;
        }
        if (address.trim() === '') {
          results.set(address, AddressNotFound({ address }));
          continue;
        }
        const result = await this.geocode(address, undefined, { signal });
        if (GeocodingCancelled.is(result)) {
          cancelled = true;
          return;
        }
        results.set(address, result);
      }
    };

    // Start concurrent workers
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return cancelled ? GeocodingCancelled() : results;
  }

  /**
   * Ask each provider in order until one answers with a result.
   * `isNoAddress` says whether a thrown error means "found nothing" instead of "provider fault".
   */
  private async lookup(
    preferredProvider: GeocodingProvider | undefined,
    signal: AbortSignal | undefined,
    ask: (geocoder: NodeGeocoder.Geocoder) => Promise<Entry[]>,
    isNoAddress: (provider: GeocodingProvider, error: unknown) => boolean,
  ): Promise<Lookup> {
    const attempts: (ProviderAttempt & { retryAfterMs?: number })[] = [];
    let answeredWithNoResults = false;

    for (const provider of this.getProviderOrder(preferredProvider)) {
      const providerOptions = this.providerOptions.get(provider);
      if (!providerOptions) continue;
      if (signal?.aborted) return { kind: 'cancelled' };

      const seen: SeenResponse = {};
      const requestSignal = AbortSignal.any(
        signal ? [signal, AbortSignal.timeout(this.timeoutMs)] : [AbortSignal.timeout(this.timeoutMs)],
      );
      const geocoder = NodeGeocoder({
        ...providerOptions,
        // node-geocoder hides the HTTP status and headers, so this fetch records
        // them, and it cuts the request off on cancellation or timeout.
        fetch: (url, init) =>
          nodeFetch(url, { ...init, signal: requestSignal }).then((response) => {
            seen.status = response.status;
            seen.retryAfterMs = retryAfterMs(response.headers.get('retry-after'));
            return response;
          }),
      });

      try {
        const entries = await ask(geocoder);
        const result = this.transformResult(entries[0], provider);
        if (result) return { kind: 'found', result };
        answeredWithNoResults = true;
      } catch (error) {
        if (signal?.aborted) return { kind: 'cancelled' };
        if (isNoAddress(provider, error)) {
          answeredWithNoResults = true;
          continue;
        }
        // Provider messages can carry the request URL (and so the API key), and
        // the attempt is both logged and returned to the caller.
        const classified = classify(provider, error, seen);
        const attempt = { ...classified, message: this.redactSecrets(classified.message) };
        log.warn('Geocoding with provider {provider} failed ({kind}): {message}', {
          provider,
          kind: attempt.kind,
          message: attempt.message,
        });
        attempts.push(attempt);
      }
    }

    return { kind: 'failed', answeredWithNoResults, attempts };
  }

  /** Replaces every configured API key in `text` with `[redacted]`. */
  private redactSecrets(text: string): string {
    return this.secrets.reduce((redacted, secret) => redacted.replaceAll(secret, '[redacted]'), text);
  }

  /**
   * The failure for a lookup where no provider gave an answer. Rate limit wins
   * (it names when to retry), then unreachable (a retry may work), then refused.
   * No configured provider at all counts as unreachable with no attempts.
   */
  private providerFailure(attempts: (ProviderAttempt & { retryAfterMs?: number })[]) {
    const listed = attempts.map(({ provider, kind, message }) => ({ provider, kind, message }));
    const limited = attempts.find((attempt) => attempt.kind === 'rate_limited');
    if (limited) {
      const waits = attempts.flatMap((attempt) =>
        attempt.kind === 'rate_limited' && attempt.retryAfterMs !== undefined ? [attempt.retryAfterMs] : [],
      );
      return ProviderRateLimited({
        provider: limited.provider,
        attempts: listed,
        retryAfterMs: waits.length > 0 ? Math.min(...waits) : undefined,
      });
    }
    const unreachable = attempts.find((attempt) => attempt.kind === 'unreachable');
    if (unreachable) return ProviderUnreachable({ provider: unreachable.provider, attempts: listed });
    const rejected = attempts.find((attempt) => attempt.kind === 'rejected');
    if (rejected) return ProviderRejected({ provider: rejected.provider, attempts: listed });
    return ProviderUnreachable({ provider: this.primaryProvider, attempts: listed });
  }

  /** A stored answer, or undefined on a miss. A cache fault or a stored value of the wrong shape is a miss, never an error. */
  private async readCache(key: string): Promise<GeocodeResult | undefined> {
    if (!this.cacheEnabled || !this.kv) return undefined;
    const stored = await this.kv.get(key, geocodeResultSchema);
    if (isFailure(stored)) {
      log.warn('Geocode cache read failed for {key}: {message}', { key, message: stored.message });
      return undefined;
    }
    return stored;
  }

  /** Store an answer. A cache fault is logged and the good answer is still returned. */
  private async writeCache(key: string, result: GeocodeResult): Promise<void> {
    if (!this.cacheEnabled || !this.kv) return;
    const stored = await this.kv.set(key, result, this.cacheTTL);
    if (isFailure(stored)) {
      log.warn('Geocode cache write failed for {key}: {message}', { key, message: stored.message });
    }
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
   * Transform node-geocoder Entry to our GeocodeResult format.
   * An entry without usable coordinates is no result: it is never turned into (0, 0).
   */
  private transformResult(entry: Entry | undefined, provider: GeocodingProvider): GeocodeResult | undefined {
    if (!entry) return undefined;
    const { latitude, longitude } = entry;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return undefined;
    if (!isValidCoordinates({ lat: latitude, lng: longitude })) return undefined;

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
      latitude,
      longitude,
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
