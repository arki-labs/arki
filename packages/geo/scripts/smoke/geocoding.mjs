// Smoke test of ./geocoding. It runs on Node, Bun and Deno only (package.json
// "arki.entryRuntimes"): node-geocoder needs Node's `readline`, which browsers and Hermes lack.
// Cache hit and typed failures, no network.

import { createGeocodingService } from '../../dist/geocoding/index.js';
import { AddressNotFound, GeocodingCancelled, InvalidCoordinates } from '../../dist/index.js';

// A cache that already holds the answer: no provider is asked, so no network.
const store = new Map();
const cache = { get: async key => store.get(key), set: async (key, value) => void store.set(key, value) };
const config = {
  provider: 'nominatim',
  fallbackProviders: [],
  google: { enabled: false },
  mapbox: { enabled: false },
  nominatim: { enabled: true },
  locationiq: { enabled: false },
  here: { enabled: false },
  opencage: { enabled: false },
  geocodio: { enabled: false },
  cache: { enabled: true, ttl: 60, keyPrefix: 'smoke:' },
};
const service = createGeocodingService(config, cache);
await cache.set('smoke:reverse:48.8566,2.3522', {
  latitude: 48.8566,
  longitude: 2.3522,
  formattedAddress: 'Paris, France',
  addressComponents: { locality: 'Paris', country: 'FR' },
  provider: 'nominatim',
});
const hit = await service.reverseGeocode(48.8566, 2.3522);
const badReverse = await service.reverseGeocode(200, 0);
const controller = new AbortController();
controller.abort();
const cancelled = await service.geocode('Paris', undefined, { signal: controller.signal });
const batch = await service.batchGeocode(['   ']);

const checks = [
  ['cached reverse lookup answers without a provider', hit?.formattedAddress, 'Paris, France'],
  ['reverse lookup rejects latitude 200', InvalidCoordinates.is(badReverse), true],
  ['aborted signal returns GeocodingCancelled', GeocodingCancelled.is(cancelled), true],
  ['blank address in a batch is AddressNotFound', AddressNotFound.is(batch.get('   ')), true],
];

const runtime =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? `deno ${Deno.version.deno}`
      : typeof Bun !== 'undefined'
        ? `bun ${Bun.version}`
        : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
          ? `browser ${navigator.userAgent}`
          : `node ${globalThis.process?.version ?? ''}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${runtime}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
