---
'@arki/geo': minor
---

Geocoding and coordinate doors return typed failures. Breaking in 0.x.

- `geocode` and `reverseGeocode` return `ProviderRateLimited` (`geo.provider_rate_limited`, with `retryAfterMs` from `Retry-After`), `ProviderRejected` (`geo.provider_rejected`: bad key or denied), `ProviderUnreachable` (`geo.provider_unreachable`: outage, timeout) and `GeocodingCancelled` (`geo.cancelled`) in place of throwing `GeocodingError` / `GeocodingAbortedError`. Each provider failure lists every attempt. `GeocodingError`, `GeocodingAbortedError` and `InvalidCoordinatesError` are removed.
- A provider failure never carries an API key: every configured key is replaced with `[redacted]` in each attempt's message and in the log record.
- The abort signal and a timeout (`timeoutMs`, default 10 s) now reach the provider request. Provider failures are logged through `@arki/log`.
- A provider answer without coordinates is no result, never (0, 0). A cache value is checked with a schema; a cache read or write error is a miss and never loses a good answer.
- `parseCoordinates`, `coordinatesFromUrl`, `toStandardCoordinates`, `validateCoordinates`, `normalizeCoordinates`, `normalizeLatitude` and `normalizeLongitude` return `InvalidCoordinates` (`geo.invalid_coordinates`) for bad input. `normalizeLongitude` runs in constant time (it used to loop forever on `Infinity`). `reverseGeocode` checks its coordinates.
- `batchGeocode` records an empty address as `AddressNotFound` and keeps going; it returns `GeocodingCancelled` on abort; `concurrency` below 1 is a caller bug and throws.
- `useCoordinates` exposes `error` (the `InvalidCoordinates` of the last refused change) in its state.
- `GeocodeResult` and `AddressComponents` are inferred from `geocodeResultSchema`; the provider list is one `GEOCODING_PROVIDERS` array.
