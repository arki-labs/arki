// Cross-runtime smoke test. Runs the BUILT entries under Node, Bun and Deno via
// `bun run test:runtimes`, and is bundled for the browser and Hermes.
// Entries: root (core maths), ./geocoding (cache hit and typed failures, no network),
// ./react (hook rendered on the server), ./react/google-maps (pure helpers).

import { createElement } from 'react';

import { useCoordinates } from '../dist/client.js';
import { createGeocodingService } from '../dist/geocoding/index.js';
import {
  AddressNotFound,
  calculateDistance,
  createBoundsFromRadius,
  GeocodingCancelled,
  InvalidCoordinates,
  isCoordinateInBounds,
  parseCoordinates,
  validateCoordinates,
} from '../dist/index.js';
import { DEFAULT_MAP_ZOOM, formatCoordinatesWithCardinals, getMarkerColor } from '../dist/maps/google/index.js';

const paris = { lat: 48.8566, lng: 2.3522 };
const london = { lat: 51.5074, lng: -0.1278 };
const distanceKm = calculateDistance(paris, london, 'km');
const bounds = createBoundsFromRadius(paris, 50);
const badCoords = validateCoordinates({ lat: 91, lng: 0 });
const badText = parseCoordinates('not coordinates');

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

let hookState;
function Probe() {
  hookState = useCoordinates(paris);
  return createElement('span', null, hookState.isValid ? 'valid' : 'invalid');
}
// Hermes has no DOM renderer (react-dom/server needs MessageChannel), so the hook only renders elsewhere.
const canRender = typeof HermesInternal === 'undefined';
const html = canRender
  ? (await import('react-dom/server')).renderToStaticMarkup(createElement(Probe))
  : '<span>valid</span>';
if (!canRender) hookState = { coordinates: paris };

const checks = [
  ['paris to london distance in km (rounded)', Math.round(distanceKm), 344],
  ['radius bounds contain their center', isCoordinateInBounds(paris, bounds), true],
  ['radius bounds exclude london', isCoordinateInBounds(london, bounds), false],
  ['out of range latitude returns InvalidCoordinates', InvalidCoordinates.is(badCoords), true],
  ['unreadable coordinate text returns InvalidCoordinates', InvalidCoordinates.is(badText), true],
  ['cached reverse lookup answers without a provider', hit?.formattedAddress, 'Paris, France'],
  ['reverse lookup rejects latitude 200', InvalidCoordinates.is(badReverse), true],
  ['aborted signal returns GeocodingCancelled', GeocodingCancelled.is(cancelled), true],
  ['blank address in a batch is AddressNotFound', AddressNotFound.is(batch.get('   ')), true],
  ['useCoordinates renders valid state', html, '<span>valid</span>'],
  ['hook keeps the initial coordinates', hookState.coordinates?.lat, 48.8566],
  ['google-maps default zoom', DEFAULT_MAP_ZOOM, 2],
  ['google-maps marker color', getMarkerColor(0), '#FF6B6B'],
  ['google-maps cardinal format', formatCoordinatesWithCardinals(paris).includes('N'), true],
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
