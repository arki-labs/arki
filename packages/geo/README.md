# @arki/geo

Geospatial toolkit for ARKI apps: coordinate and distance maths that run anywhere, geocoding with
provider fallback and a cache, and React hooks and Google Maps components for the browser.

## Install

```sh
bun add @arki/geo
```

Peers are optional. Install `react` and `react-dom` for `@arki/geo/react`. Install
`@vis.gl/react-google-maps` for `@arki/geo/react/google-maps`.

| Entry                         | What                                                                                                               | Runs on                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `@arki/geo`                   | `Coordinates`, `Bounds`, distance, bearing, bounds, formatting, failures                                           | Node, Bun, Deno, browser |
| `@arki/geo/geocoding`         | `GeocodingService`, `createGeocodingService`, `geocodingEnv`                                                       | server                   |
| `@arki/geo/react`             | everything in `@arki/geo`, plus `useCoordinates`, `useDistance`, `useBoundsFromCoordinates`, `useBoundsFromRadius` | browser, React           |
| `@arki/geo/react/google-maps` | `GoogleMapsProvider`, `GoogleMap`, `GoogleMarker`, `LocationPicker`, street view and polyline helpers              | browser, React           |
| `@arki/geo/zod`               | `geocodeResultSchema`, `addressComponentsSchema`, `providerAttemptSchema`                                          | anywhere                 |

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

## When not to use this

- You need routing, travel time or isochrones. This package gives straight-line (great-circle) distance.
- You need geometry on a projected plane or polygon maths. Use a GIS library.
- You need Mapbox or Leaflet components. Only Google Maps components ship today.

## Runtime support

The maths in `@arki/geo` is pure and runs on Node, Bun, Deno, browsers and Hermes. `@arki/geo/geocoding`
runs on Node, Bun and Deno only: `node-geocoder` needs Node's `readline` (package.json `arki.entryRuntimes`).
`@arki/geo/react` and `@arki/geo/react/google-maps` need React 18 or later.

<!-- runtimes:start -->

| Runtime | Result | Version tested        | Date (UTC) |
| ------- | ------ | --------------------- | ---------- |
| node    | pass   | v22.13.1              | 2026-11-05 |
| bun     | pass   | 1.4.2                 | 2026-11-05 |
| deno    | pass   | 2.9.8                 | 2026-11-05 |
| browser | pass   | Chromium 156.0.8078.4 | 2026-11-05 |
| hermes  | pass   | V1 250829098.0.17     | 2026-11-05 |

- `./geocoding` runs on node, bun, deno (`scripts/smoke/geocoding.mjs`).

<!-- runtimes:end -->

## Public imports

The table under [Install](#install) lists each entry with what it holds and where it runs. In short:

- `@arki/geo`: `Coordinates`, `Bounds`, `calculateDistance`, `calculateBearing`, `bearingToDirection`, `validateCoordinates`, `parseCoordinates`, bounds and formatting helpers, and every failure.
- `@arki/geo/geocoding`: `GeocodingService`, `createGeocodingService` and `geocodingEnv`. Server only.
- `@arki/geo/react`: everything in `@arki/geo`, plus `useCoordinates`, `useDistance`, `useBoundsFromCoordinates` and `useBoundsFromRadius`.
- `@arki/geo/react/google-maps`: `GoogleMapsProvider`, `GoogleMap`, `GoogleMarker`, `LocationPicker`, and street view and polyline helpers.
- `@arki/geo/zod`: `geocodeResultSchema`, `addressComponentsSchema` and `providerAttemptSchema`, the Zod schemas behind the plain TS types, for callers that parse with Zod.

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

## Observability

Spans from `@arki/geo/geocoding` (OpenTelemetry API only; nothing is exported until the app configures an SDK):

| Span                                                                                 | When                                                                          | Attributes                                                                                                    |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `geo.geocode`, `geo.reverse_geocode`                                                 | each lookup                                                                   | `geo.cache` (`hit`, `miss` or `off`), `geo.provider` of the provider that answered, `failure.code` on failure |
| `geo.<provider>.geocode`, `geo.<provider>.reverse_geocode` (`geo.nominatim.geocode`) | each provider call, under the lookup; a fallback makes one per provider tried | `geo.provider`, `failure.code` on failure                                                                     |
| `geo.batch_geocode`                                                                  | each `batchGeocode`; each address is a `geo.geocode` under it                 | `geo.batch.size`, `failure.code` on failure                                                                   |

A returned failure sets `failure.code`. The span status is error only for a fault: `geo.provider_rejected` (502) or `geo.provider_unreachable` (503). Nothing found, invalid coordinates, a rate limit and a cancellation leave it unset. The address, the coordinates, the cache key, provider messages and API keys are never attributes.

Metrics: `geo.operations` (counter; `operation` = `geocode`, `reverse_geocode`, `batch_geocode` or `<provider>.<lookup>`, `outcome` = `success`, `failure` or `error`).

Not instrumented: the cache read and write as their own spans — the lookup span says whether the cache answered (`geo.cache`), and an `@arki/kv` cache spans its own `kv.get` and `kv.set`. The root entry and `./react` — pure computation and map components, no I/O of their own.

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

## Limits

- Distance uses the haversine formula on a sphere (Earth radius 6371 km). Error is up to about 0.5%.
- The geocoding cache stores results by a hash of the address. It does not cache failures.
- Provider rate limits and terms of use are yours to follow.

## Documentation

- [Agent guide](docs/agent-guide.md): the model, the task map, the rules that bite, the errors and how to verify.
- [API reference](docs/api.md): every export.
- [`llms.txt`](llms.txt): the short map an agent reads first.
- [`AGENTS.md`](AGENTS.md): the laws for changing this package.

## Support

Questions and bugs: <https://github.com/arki-labs/arki/issues>. Include the package version, the geocoding provider and the failure `code`.
