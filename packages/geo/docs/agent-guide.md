# Agent guide: @arki/geo

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, `src/index.ts`, `src/client.ts`, `src/geocoding/index.ts` and `src/maps/google/index.ts` win.

## The model

1. `@arki/geo` is pure maths on `{ lat, lng }` points in WGS84: distance (haversine, kilometres by default), bearing, bounds and formatting.
2. `@arki/geo/geocoding` holds `createGeocodingService`. It tries each configured provider in turn, and takes an optional cache with `get` and `set` (an `@arki/kv` instance fits).
3. `@arki/geo/react` re-exports the root helpers and adds hooks. `@arki/geo/react/google-maps` adds the Google Maps components.
4. Failures are returned values. Check them with `.is(value)`.
5. It does no routing and no travel time. Distance is a straight line on a sphere.

## Task map

### Measure distance or heading

1. `calculateDistance(a, b)` gives kilometres. Pass `'mi'` for miles.
2. `bearingToDirection(calculateBearing(a, b))` gives a compass name such as `NNW`.

### Parse a coordinate from text

1. `parseCoordinates('48.8566, 2.3522')`.
2. `InvalidCoordinates.is(result)` handles a bad value.

### Turn an address into coordinates

1. `createGeocodingService(config, cache?)` once at boot, on the server. `geocodingEnv` reads the environment variables.
2. `await service.geocode(address)`. Check the result with the failure `.is` helpers.
3. `reverseGeocode(lat, lon)` and `batchGeocode(addresses, concurrency)` follow the same rules.
4. Pass a `signal` to cancel. A cancelled call returns `GeocodingCancelled`.

### Show a map

1. Wrap the page in `GoogleMapsProvider` from `@arki/geo/react/google-maps`.
2. Use `GoogleMap`, `GoogleMarker` and `LocationPicker`.

## Rules that bite

- Failures are returned, not thrown. Check them with `.is(value)`.
- A provider with no result passes to the next one. A missing address is not cached.
- Import `@arki/geo/geocoding` only on the server. It pulls in the geocoder libraries and does not run in a browser or on Hermes.
- Distance uses a sphere of radius 6371 km. The error is up to about 0.5%.
- `useDistance` returns `null` when either point is `null`.
- Provider rate limits and terms of use are yours to follow.
- Never import `@vis.gl/react-google-maps` directly.

## Errors

| Code                         | Meaning                                                                                 | What to do                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `geo.address_not_found`      | Every provider that answered found nothing. Status 404.                                 | Ask the user to check the address. A later lookup asks again. |
| `geo.no_address_at_location` | No provider found an address at the point, such as the sea. Status 404.                 | Show the coordinates instead.                                 |
| `geo.invalid_coordinates`    | A value is out of range or not a number.                                                | Fix the input.                                                |
| `geo.provider_rate_limited`  | No provider answered and one was rate limited. `retryAfterMs` comes from `Retry-After`. | Wait, then retry.                                             |
| `geo.provider_unreachable`   | An outage or a timeout (`timeoutMs`, default 10 s). Status 503.                         | Retry later, or add a provider.                               |
| `geo.provider_rejected`      | A provider refused the request, such as a bad key. Status 502.                          | Check the API key.                                            |
| `geo.cancelled`              | The caller aborted through `signal`.                                                    | Nothing. The caller asked for it.                             |

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
