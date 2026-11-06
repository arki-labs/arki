/**
 * The Zod schemas of the geocoding types, offered to callers by `@arki/geo/zod`. The TS types in `types.ts`
 * are the source; `zod.test.ts` locks each schema to its type both ways. They live apart from `types.ts` so
 * `./geocoding` names no Zod type (`TYPES_E001`).
 */
import { z } from 'zod';

import { GEOCODING_PROVIDERS } from './types.js';

/** An `AddressComponents`. */
export const addressComponentsSchema = z.object({
  streetAddress: z.string().optional(),
  locality: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

/** A `GeocodeResult`, also the shape read back from the cache. */
export const geocodeResultSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  formattedAddress: z.string(),
  addressComponents: addressComponentsSchema,
  placeId: z.string().optional(),
  provider: z.enum(GEOCODING_PROVIDERS),
});
