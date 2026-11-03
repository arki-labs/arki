# @arki/geo

Geospatial toolkit for ARKI apps: coordinate and distance maths that run anywhere, geocoding with
provider fallback and a cache, and React hooks and Google Maps components for the browser.

## Install

```sh
bun add @arki/geo
```

Peers are optional. Install `react` and `react-dom` for `@arki/geo/react`. Install
`@vis.gl/react-google-maps` for `@arki/geo/react/google-maps`.

| Entry                         | What                                                                 | Runs on                  |
| ----------------------------- | -------------------------------------------------------------------- | ------------------------ |
| `@arki/geo`                   | `Coordinates`, `Bounds`, distance, bearing, bounds, formatting, failures | Node, Bun, Deno, browser |
| `@arki/geo/geocoding`         | `GeocodingService`, `createGeocodingService`, `geocodingEnv`         | server                   |
| `@arki/geo/react`             | everything in `@arki/geo`, plus `useCoordinates`, `useDistance`, `useBoundsFromCoordinates`, `useBoundsFromRadius` | browser, React |
| `@arki/geo/react/google-maps` | `GoogleMapsProvider`, `GoogleMap`, `GoogleMarker`, `LocationPicker`, street view and polyline helpers | browser, React |

Import `@arki/geo/geocoding` only on the server. It pulls in the geocoder libraries.

## Quick start

Coordinates are `{ lat, lng }` in WGS84. Distance defaults to kilometres.

```ts run
import { bearingToDirection, calculateBearing, calculateDistance } from '@arki/geo';

const paris = { lat: 48.8566, lng: 2.3522 };
const london = { lat: 51.5074, lng: -0.1278 };

const km = calculateDistance(paris, london);
const miles = calculateDistance(paris, london, 'mi');
const heading = bearingToDirection(calculateBearing(paris, london));

if (Math.round(km) !== 344 || miles >= km) throw new Error('unexpected distance');
if (heading !== 'NNW') throw new Error(`unexpected heading ${heading}`);
```

Functions that take untrusted input return a failure instead of throwing. `validateCoordinates`
and `parseCoordinates` give `InvalidCoordinates` for a bad value.

```ts run
import { InvalidCoordinates, parseCoordinates } from '@arki/geo';

const point = parseCoordinates('48.8566, 2.3522');
if (InvalidCoordinates.is(point)) throw new Error('should parse');
if (point.lat !== 48.8566) throw new Error('wrong latitude');

const bad = parseCoordinates('north pole');
if (!InvalidCoordinates.is(bad)) throw new Error('should fail');
```

## Geocoding

`createGeocodingService` takes a config and an optional cache. The cache needs `get` and `set`,
so an `@arki/kv` instance fits. `geocodingEnv` reads the matching environment variables
(`GEOCODING_PROVIDER`, `GOOGLE_MAPS_API_KEY`, `GEOCODING_CACHE_TTL` and so on).

```ts skip="calls a live geocoding provider"
import { AddressNotFound } from '@arki/geo';
import { createGeocodingService } from '@arki/geo/geocoding';

const geocoding = createGeocodingService({
  provider: 'nominatim',
  fallbackProviders: [],
  google: { enabled: false },
  mapbox: { enabled: false },
  nominatim: { enabled: true },
  locationiq: { enabled: false },
  here: { enabled: false },
  opencage: { enabled: false },
  geocodio: { enabled: false },
  cache: { enabled: false, ttl: 2_592_000, keyPrefix: 'geo:' },
});

const result = await geocoding.geocode('1600 Amphitheatre Parkway');
if (AddressNotFound.is(result)) throw new Error('no provider knows this address');
```

## Failure behaviour

Failures are returned as values. Check them with `.is(value)`.

- `geocode` returns `AddressNotFound` (`geo.address_not_found`, status 404) when every provider that
  answered found nothing. A provider with no results passes to the next one first. A missing
  address is not cached.
- When no provider answers, `geocode` returns `ProviderRateLimited` (with `retryAfterMs` from
  `Retry-After`), `ProviderUnreachable` (outage or timeout; `timeoutMs` in the config, default
  10 s) or `ProviderRejected` (bad key). Each carries the list of attempts.
- A caller that aborts through `signal` gets `GeocodingCancelled`.
- `reverseGeocode(lat, lon)` follows the same rules. It returns `NoAddressAtLocation`
  (`geo.no_address_at_location`, status 404) when no provider finds an address, such as a point at sea.
- `batchGeocode(addresses, concurrency)` maps each address to what `geocode` returned for it.
- Coordinate helpers return `InvalidCoordinates` for a value out of range or not a number.

Import every failure from `@arki/geo`.

## React

```tsx skip="needs a browser and React rendering"
import { useDistance } from '@arki/geo/react';

export function Away({ from, to }: { from: { lat: number; lng: number }; to: { lat: number; lng: number } }) {
  const km = useDistance(from, to, 'km');
  return <span>{km === null ? 'unknown' : `${km.toFixed(1)} km`}</span>;
}
```

`useDistance` returns `null` when either point is `null`. Apps import the Google Maps components
from `@arki/geo/react/google-maps` and never import `@vis.gl/react-google-maps` directly.

## When not to use this

- You need routing, travel time or isochrones. This package gives straight-line (great-circle) distance.
- You need geometry on a projected plane or polygon maths. Use a GIS library.
- You need Mapbox or Leaflet components. Only Google Maps components ship today.

## Runtime support

The maths in `@arki/geo` is pure and runs on Node, Bun, Deno and browsers. `@arki/geo/geocoding`
needs Node or Bun. `@arki/geo/react` and `@arki/geo/react/google-maps` need React 18 or later in a browser.

## Limits

- Distance uses the haversine formula on a sphere (Earth radius 6371 km). Error is up to about 0.5%.
- The geocoding cache stores results by a hash of the address. It does not cache failures.
- Provider rate limits and terms of use are yours to follow.
