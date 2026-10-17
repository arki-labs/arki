import { http, HttpResponse, setupMswServer } from '@arki/testing/msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeocodingAbortedError, GeocodingError } from '../core/errors';
import { AddressNotFound, NoAddressAtLocation } from '../core/failures';
import type { GeocodingCache } from './service';
import { createGeocodingService, GeocodingService } from './service';
import type { GeocodeResult, GeocodingConfig } from './types';

const NOMINATIM = 'https://nominatim.test';
const GOOGLE = 'https://maps.googleapis.com/maps/api/geocode/json';

const server = setupMswServer();

const baseConfig = (overrides: Partial<GeocodingConfig> = {}): GeocodingConfig => ({
  provider: 'nominatim',
  fallbackProviders: ['google'],
  google: { enabled: true, apiKey: 'google-key' },
  mapbox: { enabled: false },
  nominatim: { enabled: true, baseUrl: NOMINATIM },
  locationiq: { enabled: false },
  here: { enabled: false },
  opencage: { enabled: false },
  geocodio: { enabled: false },
  cache: { enabled: true, ttl: 3600, keyPrefix: 'geo:' },
  ...overrides,
});

/** In-memory cache that records every write, including the TTL. */
const createFakeCache = () => {
  const store = new Map<string, unknown>();
  const writes: { key: string; ttl: number | undefined }[] = [];
  const cache: GeocodingCache = {
    get: <T = unknown>(key: string) => Promise.resolve(store.get(key) as T | undefined),
    set: <T = unknown>(key: string, value: T, ttl?: number) => {
      store.set(key, value);
      writes.push({ key, ttl });
      return Promise.resolve(true);
    },
  };
  return { cache, store, writes };
};

const nominatimHit = (lat: string, lon: string) => [
  {
    place_id: 1,
    lat,
    lon,
    display_name: '1600, Pennsylvania Avenue NW, Washington, DC, 20500, United States',
    address: {
      house_number: '1600',
      road: 'Pennsylvania Avenue NW',
      city: 'Washington',
      state: 'District of Columbia',
      postcode: '20500',
      country: 'United States',
      country_code: 'us',
    },
  },
];

const googleHit = {
  status: 'OK',
  results: [
    {
      formatted_address: '10 Downing St, London SW1A 2AA, UK',
      place_id: 'ChIJ-google-place',
      geometry: { location: { lat: 51.5034, lng: -0.1276 } },
      address_components: [
        { long_name: '10', short_name: '10', types: ['street_number'] },
        { long_name: 'Downing Street', short_name: 'Downing St', types: ['route'] },
        { long_name: 'London', short_name: 'London', types: ['locality', 'political'] },
        { long_name: 'England', short_name: 'England', types: ['administrative_area_level_1'] },
        { long_name: 'SW1A 2AA', short_name: 'SW1A 2AA', types: ['postal_code'] },
        { long_name: 'United Kingdom', short_name: 'GB', types: ['country', 'political'] },
      ],
    },
  ],
};

describe('GeocodingService', () => {
  beforeEach(() => {
    // The service logs provider failures with console.warn; keep test output clean.
    vi.spyOn(console, 'warn').mockReturnValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('response normalization', () => {
    it('maps a nominatim response to the provider-neutral GeocodeResult', async () => {
      server.use(http.get(`${NOMINATIM}/search`, () => HttpResponse.json(nominatimHit('38.8977', '-77.0365'))));
      const service = new GeocodingService(baseConfig({ cache: { enabled: false, ttl: 0, keyPrefix: '' } }));

      const result = await service.geocode('1600 Pennsylvania Ave');

      expect(result).toMatchObject({
        latitude: 38.8977,
        longitude: -77.0365,
        provider: 'nominatim',
        formattedAddress: expect.stringContaining('Pennsylvania Avenue'),
        addressComponents: {
          streetAddress: '1600 Pennsylvania Avenue NW',
          locality: 'Washington',
          region: 'District of Columbia',
          postalCode: '20500',
        },
      });
      // Callers rely on a two-letter country code, regardless of provider casing.
      expect(result).toMatchObject({ addressComponents: { country: expect.stringMatching(/^us$/i) } });
    });

    it('maps a google response, including the place id', async () => {
      server.use(http.get(GOOGLE, () => HttpResponse.json(googleHit)));
      const service = new GeocodingService(
        baseConfig({ provider: 'google', fallbackProviders: [], cache: { enabled: false, ttl: 0, keyPrefix: '' } }),
      );

      const result = await service.geocode('10 Downing Street');

      expect(result).toMatchObject({
        latitude: 51.5034,
        longitude: -0.1276,
        provider: 'google',
        placeId: 'ChIJ-google-place',
        addressComponents: { streetAddress: '10 Downing Street', locality: 'London', postalCode: 'SW1A 2AA' },
      });
    });

    it('reverse geocoding returns the same normalized shape', async () => {
      server.use(
        http.get(`${NOMINATIM}/reverse`, ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get('lat')).toBe('38.8977');
          expect(url.searchParams.get('lon')).toBe('-77.0365');
          return HttpResponse.json(nominatimHit('38.8977', '-77.0365')[0]);
        }),
      );
      const service = new GeocodingService(baseConfig({ cache: { enabled: false, ttl: 0, keyPrefix: '' } }));

      const result = await service.reverseGeocode(38.8977, -77.0365);

      expect(result).toMatchObject({ provider: 'nominatim', addressComponents: { locality: 'Washington' } });
    });
  });

  describe('fallback order', () => {
    const noCache = { enabled: false, ttl: 0, keyPrefix: '' };

    it('uses the primary provider and never calls the fallback when it succeeds', async () => {
      const googleCalls = vi.fn();
      server.use(
        http.get(`${NOMINATIM}/search`, () => HttpResponse.json(nominatimHit('1', '2'))),
        http.get(GOOGLE, () => {
          googleCalls();
          return HttpResponse.json(googleHit);
        }),
      );
      const service = new GeocodingService(baseConfig({ cache: noCache }));

      const result = await service.geocode('somewhere');

      expect(result).toMatchObject({ provider: 'nominatim' });
      expect(googleCalls).not.toHaveBeenCalled();
    });

    it('falls back to the next provider when the primary returns an empty list', async () => {
      server.use(
        http.get(`${NOMINATIM}/search`, () => HttpResponse.json([])),
        http.get(GOOGLE, () => HttpResponse.json(googleHit)),
      );
      const service = new GeocodingService(baseConfig({ cache: noCache }));

      const result = await service.geocode('somewhere');

      expect(result).toMatchObject({ provider: 'google' });
    });

    it('falls back when the primary answers with a server error', async () => {
      server.use(
        http.get(`${NOMINATIM}/search`, () => new HttpResponse(null, { status: 503 })),
        http.get(GOOGLE, () => HttpResponse.json(googleHit)),
      );
      const service = new GeocodingService(baseConfig({ cache: noCache }));

      const result = await service.geocode('somewhere');

      expect(result).toMatchObject({ provider: 'google' });
    });

    it('a preferred provider goes first, then the primary, even when the primary is not in the fallback list', async () => {
      const order: string[] = [];
      server.use(
        http.get(`${NOMINATIM}/search`, () => {
          order.push('nominatim');
          return HttpResponse.json(nominatimHit('1', '2'));
        }),
        http.get(GOOGLE, () => {
          order.push('google');
          return HttpResponse.json({ status: 'ZERO_RESULTS', results: [] });
        }),
      );
      const service = new GeocodingService(baseConfig({ fallbackProviders: [], cache: noCache }));

      const result = await service.geocode('somewhere', 'google');

      expect(order).toEqual(['google', 'nominatim']);
      expect(result).toMatchObject({ provider: 'nominatim' });
    });

    it('skips providers that are listed but not configured', async () => {
      server.use(http.get(`${NOMINATIM}/search`, () => HttpResponse.json(nominatimHit('1', '2'))));
      const service = new GeocodingService(
        baseConfig({ provider: 'mapbox', fallbackProviders: ['here', 'nominatim'], cache: noCache }),
      );

      const result = await service.geocode('somewhere');

      expect(result).toMatchObject({ provider: 'nominatim' });
    });

    it('throws one GeocodingError carrying the last cause when every provider fails', async () => {
      server.use(
        http.get(`${NOMINATIM}/search`, () => new HttpResponse(null, { status: 503 })),
        http.get(GOOGLE, () => HttpResponse.json({ status: 'REQUEST_DENIED', error_message: 'bad key', results: [] })),
      );
      const service = new GeocodingService(baseConfig({ cache: noCache }));

      const error = await service.geocode('nowhere').catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(GeocodingError);
      expect((error as GeocodingError).message).toMatch(/All geocoding providers failed/);
      expect((error as GeocodingError).provider).toBe('nominatim');
      expect((error as GeocodingError).cause).toBeInstanceOf(Error);
    });

    // "This address does not exist" is an answer the caller must branch on, so it is
    // returned. Only "no provider could answer" is a fault, and that stays thrown.
    it('returns AddressNotFound, not a GeocodingError, when every provider answers with no results', async () => {
      server.use(
        http.get(`${NOMINATIM}/search`, () => HttpResponse.json([])),
        http.get(GOOGLE, () => HttpResponse.json({ status: 'ZERO_RESULTS', results: [] })),
      );
      const service = new GeocodingService(baseConfig({ cache: noCache }));

      const result = await service.geocode('nowhere');

      expect(AddressNotFound.is(result)).toBe(true);
      expect(result).toMatchObject({ code: 'geo.address_not_found', status: 404, data: { address: 'nowhere' } });
    });

    it('returns AddressNotFound when one provider found nothing and the other was down', async () => {
      server.use(
        http.get(`${NOMINATIM}/search`, () => new HttpResponse(null, { status: 503 })),
        http.get(GOOGLE, () => HttpResponse.json({ status: 'ZERO_RESULTS', results: [] })),
      );
      const service = new GeocodingService(baseConfig({ cache: noCache }));

      const result = await service.geocode('nowhere');

      expect(AddressNotFound.is(result)).toBe(true);
    });

    it('reverse geocoding falls back too', async () => {
      server.use(
        http.get(`${NOMINATIM}/reverse`, () => new HttpResponse(null, { status: 500 })),
        http.get(GOOGLE, () => HttpResponse.json(googleHit)),
      );
      const service = new GeocodingService(baseConfig({ cache: noCache }));

      const result = await service.reverseGeocode(51.5, -0.12);

      expect(result).toMatchObject({ provider: 'google' });
    });

    // "No address here" (a point at sea) is an answer the caller must branch on, so it
    // is returned. Only "no provider could answer" is a fault, and that stays thrown.
    it('reverse geocoding returns NoAddressAtLocation when every provider answers with no results', async () => {
      server.use(http.get(`${NOMINATIM}/reverse`, () => HttpResponse.json([])));
      const service = new GeocodingService(baseConfig({ fallbackProviders: [], cache: noCache }));

      const result = await service.reverseGeocode(0, -30);

      expect(NoAddressAtLocation.is(result)).toBe(true);
      expect(result).toMatchObject({
        code: 'geo.no_address_at_location',
        status: 404,
        data: { latitude: 0, longitude: -30 },
      });
    });

    it('reverse geocoding returns NoAddressAtLocation when one provider found nothing and the other was down', async () => {
      server.use(
        http.get(`${NOMINATIM}/reverse`, () => HttpResponse.json([])),
        http.get(GOOGLE, () => new HttpResponse(null, { status: 503 })),
      );
      const service = new GeocodingService(
        baseConfig({ provider: 'google', fallbackProviders: ['nominatim'], cache: noCache }),
      );

      expect(NoAddressAtLocation.is(await service.reverseGeocode(0, -30))).toBe(true);
    });

    // node-geocoder throws for these "nothing here" bodies instead of returning an empty
    // list. These tests run the real adapters on the providers' real bodies, so a
    // node-geocoder upgrade that changes the wording fails here.
    it("reverse geocoding returns NoAddressAtLocation for Google's ZERO_RESULTS", async () => {
      server.use(http.get(GOOGLE, () => HttpResponse.json({ status: 'ZERO_RESULTS', results: [] })));
      const service = new GeocodingService(baseConfig({ provider: 'google', fallbackProviders: [], cache: noCache }));

      expect(NoAddressAtLocation.is(await service.reverseGeocode(0, -30))).toBe(true);
    });

    it('reverse geocoding returns NoAddressAtLocation for Nominatim\'s "Unable to geocode"', async () => {
      server.use(http.get(`${NOMINATIM}/reverse`, () => HttpResponse.json({ error: 'Unable to geocode' })));
      const service = new GeocodingService(baseConfig({ fallbackProviders: [], cache: noCache }));

      expect(NoAddressAtLocation.is(await service.reverseGeocode(0, -30))).toBe(true);
    });

    it('reverse geocoding treats any other Google status or Nominatim error as a provider fault', async () => {
      server.use(
        http.get(`${NOMINATIM}/reverse`, () => HttpResponse.json({ error: 'Unable to geocode right now' })),
        http.get(GOOGLE, () => HttpResponse.json({ status: 'OVER_QUERY_LIMIT', results: [] })),
      );
      const service = new GeocodingService(baseConfig({ cache: noCache }));

      await expect(service.reverseGeocode(0, -30)).rejects.toBeInstanceOf(GeocodingError);
    });

    it('reverse geocoding throws GeocodingError when every provider fails', async () => {
      server.use(
        http.get(`${NOMINATIM}/reverse`, () => new HttpResponse(null, { status: 503 })),
        http.get(GOOGLE, () => HttpResponse.json({ status: 'REQUEST_DENIED', error_message: 'bad key', results: [] })),
      );
      const service = new GeocodingService(baseConfig({ cache: noCache }));

      await expect(service.reverseGeocode(0, -30)).rejects.toBeInstanceOf(GeocodingError);
    });
  });

  describe('cache keys and TTL', () => {
    it('writes the result under prefix + normalized address, with the configured TTL in seconds', async () => {
      server.use(http.get(`${NOMINATIM}/search`, () => HttpResponse.json(nominatimHit('1', '2'))));
      const { cache, writes } = createFakeCache();
      const service = new GeocodingService(baseConfig(), cache);

      expect(await service.geocode('  1600  Pennsylvania Ave., NW ')).toMatchObject({ provider: 'nominatim' });

      expect(writes).toEqual([{ key: 'geo:-1600-pennsylvania-ave-nw-', ttl: 3600 }]);
    });

    it('treats case and punctuation differences as the same address', async () => {
      let calls = 0;
      server.use(
        http.get(`${NOMINATIM}/search`, () => {
          calls += 1;
          return HttpResponse.json(nominatimHit('1', '2'));
        }),
      );
      const { cache } = createFakeCache();
      const service = new GeocodingService(baseConfig(), cache);

      expect(await service.geocode('10 Main St.')).toMatchObject({ provider: 'nominatim' });
      expect(await service.geocode('10 main st')).toMatchObject({ provider: 'nominatim' });

      expect(calls).toBe(1);
    });

    it('does not mix up different addresses', async () => {
      let calls = 0;
      server.use(
        http.get(`${NOMINATIM}/search`, () => {
          calls += 1;
          return HttpResponse.json(nominatimHit('1', '2'));
        }),
      );
      const { cache } = createFakeCache();
      const service = new GeocodingService(baseConfig(), cache);

      expect(await service.geocode('10 Main St')).toMatchObject({ provider: 'nominatim' });
      expect(await service.geocode('12 Main St')).toMatchObject({ provider: 'nominatim' });

      expect(calls).toBe(2);
    });

    it('serves a cache hit without calling any provider', async () => {
      const cached: GeocodeResult = {
        latitude: 9,
        longitude: 9,
        formattedAddress: 'cached',
        addressComponents: {},
        provider: 'google',
      };
      const { cache, store } = createFakeCache();
      store.set('geo:cached-street', cached);
      // No handlers registered: any network call fails the test (onUnhandledRequest: 'error').
      const service = new GeocodingService(baseConfig(), cache);

      await expect(service.geocode('Cached Street')).resolves.toEqual(cached);
    });

    it('keys reverse lookups by exact coordinates, apart from forward lookups', async () => {
      server.use(http.get(`${NOMINATIM}/reverse`, () => HttpResponse.json(nominatimHit('1', '2')[0])));
      const { cache, writes } = createFakeCache();
      const service = new GeocodingService(baseConfig(), cache);

      expect(await service.reverseGeocode(38.8977, -77.0365)).toMatchObject({ provider: 'nominatim' });

      expect(writes).toEqual([{ key: 'geo:reverse:38.8977,-77.0365', ttl: 3600 }]);
    });

    it('does not read or write the cache when caching is disabled', async () => {
      server.use(http.get(`${NOMINATIM}/search`, () => HttpResponse.json(nominatimHit('1', '2'))));
      const { cache, writes } = createFakeCache();
      const get = vi.spyOn(cache, 'get');
      const service = new GeocodingService(baseConfig({ cache: { enabled: false, ttl: 10, keyPrefix: 'geo:' } }), cache);

      expect(await service.geocode('10 Main St')).toMatchObject({ provider: 'nominatim' });

      expect(get).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
    });

    // A missing address may be added to the provider later, so a lookup asks again.
    it('does not cache AddressNotFound', async () => {
      server.use(http.get(`${NOMINATIM}/search`, () => HttpResponse.json([])));
      const { cache, writes } = createFakeCache();
      const service = new GeocodingService(baseConfig({ fallbackProviders: [] }), cache);

      expect(AddressNotFound.is(await service.geocode('nowhere'))).toBe(true);

      expect(writes).toEqual([]);
    });

    it('does not cache NoAddressAtLocation', async () => {
      server.use(http.get(`${NOMINATIM}/reverse`, () => HttpResponse.json([])));
      const { cache, writes } = createFakeCache();
      const service = new GeocodingService(baseConfig({ fallbackProviders: [] }), cache);

      expect(NoAddressAtLocation.is(await service.reverseGeocode(0, -30))).toBe(true);

      expect(writes).toEqual([]);
    });
  });

  describe('batchGeocode', () => {
    const noCache = { enabled: false, ttl: 0, keyPrefix: '' };

    it('never runs more lookups at once than the concurrency limit', async () => {
      let inFlight = 0;
      let peak = 0;
      server.use(
        http.get(`${NOMINATIM}/search`, async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 15));
          inFlight -= 1;
          return HttpResponse.json(nominatimHit('1', '2'));
        }),
      );
      const service = new GeocodingService(baseConfig({ cache: noCache }));
      const addresses = Array.from({ length: 9 }, (_, index) => `${index} Main St`);

      const results = await service.batchGeocode(addresses, 3);

      expect(results.size).toBe(9);
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(3);
    });

    it('records a missing address as AddressNotFound, a failed one as an Error, and keeps going', async () => {
      server.use(
        http.get(`${NOMINATIM}/search`, ({ request }) => {
          const query = new URL(request.url).searchParams.get('q');
          if (query === 'missing') return HttpResponse.json([]);
          if (query === 'down') return new HttpResponse(null, { status: 503 });
          return HttpResponse.json(nominatimHit('1', '2'));
        }),
      );
      const service = new GeocodingService(baseConfig({ fallbackProviders: [], cache: noCache }));

      const results = await service.batchGeocode(['good', 'missing', 'down', 'also good'], 2);

      expect(results.get('good')).toMatchObject({ provider: 'nominatim' });
      expect(AddressNotFound.is(results.get('missing'))).toBe(true);
      expect(results.get('down')).toBeInstanceOf(GeocodingError);
      expect(results.get('also good')).toMatchObject({ provider: 'nominatim' });
    });
  });

  describe('cancellation', () => {
    const noCache = { enabled: false, ttl: 0, keyPrefix: '' };

    it('rejects before any request when the signal is already aborted', async () => {
      let calls = 0;
      server.use(
        http.get(`${NOMINATIM}/search`, () => {
          calls += 1;
          return HttpResponse.json(nominatimHit('1', '2'));
        }),
      );
      const service = new GeocodingService(baseConfig({ cache: noCache }));
      const signal = AbortSignal.abort();

      await expect(service.geocode('1 Main St', undefined, { signal })).rejects.toBeInstanceOf(
        GeocodingAbortedError,
      );
      await expect(service.reverseGeocode(1, 2, undefined, { signal })).rejects.toMatchObject({
        code: 'GEOCODING_ABORTED',
      });
      expect(calls).toBe(0);
    });

    it('stops the fallback chain when the signal aborts during the primary attempt', async () => {
      const controller = new AbortController();
      let googleCalls = 0;
      server.use(
        http.get(`${NOMINATIM}/search`, () => {
          controller.abort();
          return new HttpResponse(null, { status: 500 });
        }),
        http.get(GOOGLE, () => {
          googleCalls += 1;
          return HttpResponse.json(googleHit);
        }),
      );
      const service = new GeocodingService(baseConfig({ cache: noCache }));

      const failure = await service
        .geocode('1 Main St', undefined, { signal: controller.signal })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(GeocodingAbortedError);
      expect(googleCalls).toBe(0);
    });

    it('stops a batch between items and starts no new lookups', async () => {
      const controller = new AbortController();
      let calls = 0;
      server.use(
        http.get(`${NOMINATIM}/search`, () => {
          calls += 1;
          if (calls === 2) controller.abort();
          return HttpResponse.json(nominatimHit('1', '2'));
        }),
      );
      const service = new GeocodingService(baseConfig({ cache: noCache }));
      const addresses = Array.from({ length: 6 }, (_, index) => `${index} Main St`);

      await expect(
        service.batchGeocode(addresses, 1, { signal: controller.signal }),
      ).rejects.toBeInstanceOf(GeocodingAbortedError);
      expect(calls).toBe(2);
    });
  });

  it('createGeocodingService builds a working service', async () => {
    server.use(http.get(`${NOMINATIM}/search`, () => HttpResponse.json(nominatimHit('1', '2'))));
    const service = createGeocodingService(baseConfig({ cache: { enabled: false, ttl: 0, keyPrefix: '' } }));

    await expect(service.geocode('x')).resolves.toMatchObject({ provider: 'nominatim' });
  });
});
