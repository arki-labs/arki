/**
 * The Zod schemas of `@arki/geo`, for callers that parse with them: a cached or stored `GeocodeResult`,
 * its `AddressComponents`, and a `ProviderAttempt` from a provider failure.
 *
 * The other entries expose plain TS types only. Each type is the source; `zod.test.ts` locks every schema
 * here to its type with an exact two-way type test, so the two cannot drift.
 */
export { providerAttemptSchema } from './core/schemas.js';
export { addressComponentsSchema, geocodeResultSchema } from './geocoding/schemas.js';
