# @arki/geo

## 0.2.0

### Minor Changes

- 7c8ab60: `@arki/kv` data methods return typed failures instead of rejecting with the raw Redis error. `get` and `mget` take a schema (any Standard Schema) and return the checked value, `undefined` for a missing key, or `KvValueInvalid`. Every method returns `KvUnavailable` when Redis is down, slow (`commandTimeoutMs`, default 5000) or drops the reply, and `KvCancelled` when the `signal` option aborts; after a failed write the effect is unknown. `mset` now applies its TTL, and `setIfNotExists` writes the same stored format as `set`, so `get` reads it back. `close()` returns `KvCloseFailed` instead of logging to the console. TLS certificates for a `rediss://` URL are now verified; skipping the check needs `allowUnverifiedTls: true` (or `KV_ALLOW_UNVERIFIED_TLS`). A rate limiter made while Redis is not ready is listed in `degradedRateLimiters` and is rebuilt on Redis once the connection is ready. Every command runs under a `kv.<command>` span. The consumers follow: `@arki/admin` `ReceiptKV`, `@arki/embeddings` `kvCacheStore`, `@arki/geo` `GeocodingCache` and `@arki/mail` `QuotaStore`/`kvQuotaStore` take the new `get(key, schema)` and failure-returning methods; a cache or quota failure is logged and read as a miss.

  `@arki/kv` no longer exports `RateLimitExceededError`: nothing in kv threw it. `getRateLimiter(...).consume()` rejects with the limiter's own `RateLimiterRes`, which `@arki/kv` now re-exports; check it with `instanceof` and read `msBeforeNext`. `get` and `mget` now return a schema failure that is not a wrong shape (an async schema, a validator defect) as the failure itself; before, it was returned as if it were the stored value.

- ba05496: Geocoding and coordinate doors return typed failures. Breaking in 0.x.

  - `geocode` and `reverseGeocode` return `ProviderRateLimited` (`geo.provider_rate_limited`, with `retryAfterMs` from `Retry-After`), `ProviderRejected` (`geo.provider_rejected`: bad key or denied), `ProviderUnreachable` (`geo.provider_unreachable`: outage, timeout) and `GeocodingCancelled` (`geo.cancelled`) in place of throwing `GeocodingError` / `GeocodingAbortedError`. Each provider failure lists every attempt. `GeocodingError`, `GeocodingAbortedError` and `InvalidCoordinatesError` are removed.
  - A provider failure never carries an API key: every configured key is replaced with `[redacted]` in each attempt's message and in the log record.
  - The abort signal and a timeout (`timeoutMs`, default 10 s) now reach the provider request. Provider failures are logged through `@arki/log`.
  - A provider answer without coordinates is no result, never (0, 0). A cache value is checked with a schema; a cache read or write error is a miss and never loses a good answer.
  - `parseCoordinates`, `coordinatesFromUrl`, `toStandardCoordinates`, `validateCoordinates`, `normalizeCoordinates`, `normalizeLatitude` and `normalizeLongitude` return `InvalidCoordinates` (`geo.invalid_coordinates`) for bad input. `normalizeLongitude` runs in constant time (it used to loop forever on `Infinity`). `reverseGeocode` checks its coordinates.
  - `batchGeocode` records an empty address as `AddressNotFound` and keeps going; it returns `GeocodingCancelled` on abort; `concurrency` below 1 is a caller bug and throws.
  - `useCoordinates` exposes `error` (the `InvalidCoordinates` of the last refused change) in its state.
  - `GeocodeResult` and `AddressComponents` are inferred from `geocodeResultSchema`; the provider list is one `GEOCODING_PROVIDERS` array.

- e132ad3: Fix the AI react/index wildcard target to resolve its existing TypeScript source. Remove Geo exports and typesVersions entries for unimplemented Apple, Mapbox, Leaflet and HERE modules; these paths never resolved. Google Maps and geocoding exports remain supported.
- 4324acd: `geocode` returns `AddressNotFound` (`geo.address_not_found`, 404, data `{ address }`) when every provider that answered found nothing, in place of throwing `GeocodingError`. A caller can now tell "this address does not exist" from "the provider is down": the second one still throws `GeocodingError`. `batchGeocode` records `AddressNotFound` for a missing address. Import `AddressNotFound` from `@arki/geo`.

  - `reverseGeocode` returns `NoAddressAtLocation` (`geo.no_address_at_location`, 404, data `{ latitude, longitude }`) when every provider that answered found no address at the coordinates, in place of throwing `GeocodingError`. Import it from `@arki/geo`.
  - `reverseGeocode` also returns `NoAddressAtLocation` for Google's `ZERO_RESULTS` and Nominatim's "Unable to geocode", which node-geocoder throws as errors. Any other provider error still counts as a fault.

### Patch Changes

- e132ad3: Document actionable fixes and verification commands for canonical error definitions.

  Journal command/workflow failures and Embeddings failures also expose the missing runtime remediation guidance. Existing failure codes, data and inferred unions are unchanged.

## 0.1.3

### Patch Changes

- Updated dependencies
  - @arki/contracts@0.0.2
  - @arki/env@0.0.3
  - @arki/kv@0.1.2

## 0.1.2

### Patch Changes

- Updated dependencies
  - @arki/env@0.0.2
  - @arki/kv@0.1.1

## 0.1.1

### Patch Changes

- Updated dependencies
  - @arki/contracts@1.0.0
  - @arki/kv@0.1.1
