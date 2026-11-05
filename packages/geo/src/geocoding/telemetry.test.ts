// What an operator reads when geocoding is slow or failing: one lookup span, one span per provider
// call under it (so a fallback shows which provider failed), whether the cache answered, the failure
// code, and an error status only for a fault (a provider refused or down), never for "nothing found"
// or a rate limit. The address, the coordinates and the API keys must never be attributes.
// The providers are external services, so their HTTP answers come from MSW; the service is real.
import { SpanStatusCode } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StandardSchemaV1 } from '@arki/schema';
import { isFailure } from '@arki/failure';
import { parse } from '@arki/schema';
import { http, HttpResponse, setupMswServer } from '@arki/testing/msw';
import { captureSpans } from '@arki/testing/otel';

import type { GeocodingCache } from './service';
import type { GeocodingConfig } from './types';
import { GeocodingService } from './service';

const NOMINATIM = 'https://nominatim.test';
const GOOGLE = 'https://maps.googleapis.com/maps/api/geocode/json';
const ADDRESS = '1600 Pennsylvania Avenue';

const server = setupMswServer();

const config = (cacheEnabled: boolean): GeocodingConfig => ({
  provider: 'nominatim',
  fallbackProviders: ['google'],
  google: { enabled: true, apiKey: 'google-secret-key' },
  mapbox: { enabled: false },
  nominatim: { enabled: true, baseUrl: NOMINATIM },
  locationiq: { enabled: false },
  here: { enabled: false },
  opencage: { enabled: false },
  geocodio: { enabled: false },
  cache: { enabled: cacheEnabled, ttl: 3600, keyPrefix: 'geo:' },
});

/** An in-memory cache with the `KV` contract: a read is checked against the schema the caller gives. */
const memoryCache = (): GeocodingCache => {
  const store = new Map<string, unknown>();
  return {
    get: <Schema extends StandardSchemaV1>(key: string, schema: Schema) => {
      const stored = store.get(key);
      return Promise.resolve(stored === undefined ? undefined : parse(schema, stored));
    },
    set: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve(true);
    },
  };
};

const googleHit = {
  status: 'OK',
  results: [
    {
      formatted_address: '1600 Pennsylvania Ave NW, Washington, DC 20500, USA',
      place_id: 'ChIJ-google-place',
      geometry: { location: { lat: 38.8977, lng: -77.0365 } },
      address_components: [{ long_name: 'Washington', short_name: 'Washington', types: ['locality', 'political'] }],
    },
  ],
};

/** Every attribute a geo span may carry. Anything else is a leak. */
const ALLOWED = new Set(['geo.provider', 'geo.cache', 'geo.batch.size', 'failure.code']);

function expectNoContent(spans: ReturnType<typeof captureSpans>): void {
  for (const span of spans.finished) {
    expect(Object.keys(span.attributes).filter(key => !ALLOWED.has(key))).toEqual([]);
    const text = JSON.stringify(span.attributes);
    for (const secret of ['Pennsylvania', '38.8977', 'google-secret-key']) expect(text).not.toContain(secret);
  }
}

describe('geocoding spans', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockReturnValue();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a fallback shows the failed provider as a fault and the one that answered, under geo.geocode', async () => {
    using spans = captureSpans();
    server.use(
      http.get(`${NOMINATIM}/search`, () => new HttpResponse(null, { status: 503 })),
      http.get(GOOGLE, () => HttpResponse.json(googleHit)),
    );
    const result = await new GeocodingService(config(true), memoryCache()).geocode(ADDRESS);

    expect(result).toMatchObject({ provider: 'google' });
    const lookup = spans.named('geo.geocode');
    expect(lookup.attributes).toEqual({ 'geo.cache': 'miss', 'geo.provider': 'google' });
    expect(lookup.status.code).toBe(SpanStatusCode.UNSET);
    expect(spans.childrenOf(lookup).map(span => span.name)).toEqual(['geo.nominatim.geocode', 'geo.google.geocode']);
    const down = spans.named('geo.nominatim.geocode');
    expect(down.attributes).toEqual({ 'geo.provider': 'nominatim', 'failure.code': 'geo.provider_unreachable' });
    expect(down.status.code).toBe(SpanStatusCode.ERROR);
    expect(spans.named('geo.google.geocode').status.code).toBe(SpanStatusCode.UNSET);
    expectNoContent(spans);

    const collected = await spans.collectMetrics();
    const counter = collected.find(metric => metric.descriptor.name === 'geo.operations');
    expect(counter?.dataPoints.map(point => point.attributes)).toEqual(
      expect.arrayContaining([
        { operation: 'geocode', outcome: 'success' },
        { operation: 'nominatim.geocode', outcome: 'failure' },
        { operation: 'google.geocode', outcome: 'success' },
      ]),
    );
  });

  it('a cache hit is a geo.geocode span with geo.cache hit and no provider span', async () => {
    server.use(http.get(GOOGLE, () => HttpResponse.json(googleHit)));
    const service = new GeocodingService({ ...config(true), provider: 'google', fallbackProviders: [] }, memoryCache());
    expect(isFailure(await service.geocode(ADDRESS))).toBe(false);

    using spans = captureSpans();
    expect(isFailure(await service.geocode(ADDRESS))).toBe(false);
    expect(spans.finished.map(span => span.name)).toEqual(['geo.geocode']);
    // No provider was asked, so the span names none.
    expect(spans.named('geo.geocode').attributes).toEqual({ 'geo.cache': 'hit' });
  });

  it('nothing found and a rate limit carry their codes without an error status: neither is a fault', async () => {
    using spans = captureSpans();
    server.use(http.get(`${NOMINATIM}/search`, () => HttpResponse.json([])));
    const service = new GeocodingService({ ...config(false), fallbackProviders: [] });
    expect(isFailure(await service.geocode(ADDRESS))).toBe(true);
    const notFound = spans.named('geo.geocode');
    expect(notFound.attributes).toEqual({ 'geo.cache': 'off', 'failure.code': 'geo.address_not_found' });
    expect(notFound.status.code).toBe(SpanStatusCode.UNSET);
    // The provider answered: its call succeeded, it just found nothing.
    expect(spans.named('geo.nominatim.geocode').attributes['failure.code']).toBeUndefined();

    spans.reset();
    server.use(http.get(`${NOMINATIM}/reverse`, () => new HttpResponse('Too Many Requests', { status: 429 })));
    expect(isFailure(await service.reverseGeocode(38.8977, -77.0365))).toBe(true);
    for (const name of ['geo.reverse_geocode', 'geo.nominatim.reverse_geocode']) {
      expect(spans.named(name).attributes['failure.code']).toBe('geo.provider_rate_limited');
      expect(spans.named(name).status.code).toBe(SpanStatusCode.UNSET);
    }
    expectNoContent(spans);
  });

  it('a batch is one geo.batch_geocode span with its size, and each address a geo.geocode under it', async () => {
    using spans = captureSpans();
    server.use(http.get(`${NOMINATIM}/search`, () => new HttpResponse(null, { status: 503 })));
    server.use(http.get(GOOGLE, () => HttpResponse.json(googleHit)));
    const results = await new GeocodingService(config(false)).batchGeocode([ADDRESS, `${ADDRESS} 2`], 2);

    expect(isFailure(results)).toBe(false);
    const batch = spans.named('geo.batch_geocode');
    expect(batch.attributes).toEqual({ 'geo.batch.size': 2 });
    expect(spans.childrenOf(batch).map(span => span.name)).toEqual(['geo.geocode', 'geo.geocode']);
    expectNoContent(spans);
  });
});
