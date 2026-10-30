/**
 * The expected ways a geo lookup can fail, each defined once. They are
 * returned, not thrown: a correct caller must branch on them.
 */
import { z } from 'zod';

import { defineFailure } from '@arki/failure';

/** Every provider that answered found nothing for this address. Not cached, so a later lookup asks again.
 * @fix Check the address for typos, or add detail such as the city and country.
 * @verify bun run test -- src/geocoding/service.test.ts
 */
export const AddressNotFound = defineFailure('geo.address_not_found', {
  status: 404,
  data: z.object({ address: z.string() }),
  message: 'No results found for address: {address}',
  remediation: 'Check the address for typos, or add detail such as the city and country.',
});

/** Every provider that answered found no address at these coordinates, such as a point at sea. Not cached.
 * @fix Check the coordinates are latitude then longitude, or treat the place as having no address.
 * @verify bun run test -- src/geocoding/service.test.ts
 */
export const NoAddressAtLocation = defineFailure('geo.no_address_at_location', {
  status: 404,
  data: z.object({ latitude: z.number(), longitude: z.number() }),
  message: 'No address found at {latitude}, {longitude}',
  remediation: 'Check the coordinates are latitude then longitude, or treat the place as having no address.',
});

/** Coordinates, or text that should hold coordinates, are not a valid latitude and longitude. Nothing was looked up.
 * @fix Send finite numbers: latitude from -90 to 90, longitude from -180 to 180. Text must read "lat, lng".
 * @verify bun run test -- src/core/coordinates.test.ts
 */
export const InvalidCoordinates = defineFailure('geo.invalid_coordinates', {
  status: 400,
  data: z.object({ reason: z.string() }),
  message: 'Invalid coordinates: {reason}',
  remediation: 'Send finite numbers: latitude from -90 to 90, longitude from -180 to 180. Text must read "lat, lng".',
});

/** The lookup was cancelled through its `AbortSignal`. This is not a provider fault.
 * @fix Do not retry unless the caller still wants the result. Pass a fresh signal if it does.
 * @verify bun run test -- src/geocoding/service.test.ts
 */
export const GeocodingCancelled = defineFailure('geo.cancelled', {
  status: 499,
  message: 'The geocoding lookup was cancelled by the caller.',
  remediation: 'Do not retry unless the caller still wants the result. Pass a fresh signal if it does.',
});

/** One provider's failed try, kept so a failure that ends the lookup still shows every provider. */
export const providerAttemptSchema = z.object({
  provider: z.string(),
  kind: z.enum(['rate_limited', 'rejected', 'unreachable']),
  message: z.string(),
});

const providerFailureData = z.object({
  /** The provider whose failure is reported here. */
  provider: z.string(),
  /** Every provider that was tried, in order, with why it failed. */
  attempts: z.array(providerAttemptSchema),
});

/** No provider answered and at least one said it is over its limit. `retryAfterMs` is that provider's `Retry-After`, when it sent one.
 * @fix Wait `retryAfterMs` (or back off) and retry, or add a provider to the fallback list.
 * @verify bun run test -- src/geocoding/service.test.ts
 */
export const ProviderRateLimited = defineFailure('geo.provider_rate_limited', {
  status: 429,
  data: providerFailureData.extend({ retryAfterMs: z.number().optional() }),
  message: 'Geocoding provider {provider} is rate limited.',
  remediation: 'Wait for retryAfterMs (or back off) and retry, or add a provider to the fallback list.',
});

/** No provider answered and at least one refused the request: a bad or missing key, a denied account, or a malformed request. Retrying gives the same answer.
 * @fix Check the provider's API key and plan in the configuration, then retry.
 * @verify bun run test -- src/geocoding/service.test.ts
 */
export const ProviderRejected = defineFailure('geo.provider_rejected', {
  status: 502,
  data: providerFailureData,
  message: 'Geocoding provider {provider} refused the request.',
  remediation: "Check the provider's API key and plan in the configuration, then retry.",
});

/** No provider answered: each was down, timed out, or sent an unreadable answer. A later retry may work.
 * @fix Retry later, or add a fallback provider.
 * @verify bun run test -- src/geocoding/service.test.ts
 */
export const ProviderUnreachable = defineFailure('geo.provider_unreachable', {
  status: 503,
  data: providerFailureData,
  message: 'Geocoding provider {provider} could not be reached.',
  remediation: 'Retry later, or add a fallback provider.',
});

export type ProviderAttempt = z.infer<typeof providerAttemptSchema>;

export type InvalidCoordinates = ReturnType<typeof InvalidCoordinates>;
export type GeocodingCancelled = ReturnType<typeof GeocodingCancelled>;
export type ProviderRateLimited = ReturnType<typeof ProviderRateLimited>;
export type ProviderRejected = ReturnType<typeof ProviderRejected>;
export type ProviderUnreachable = ReturnType<typeof ProviderUnreachable>;
