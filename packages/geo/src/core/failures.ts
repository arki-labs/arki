/**
 * The expected ways a geo lookup can fail, each defined once. They are
 * returned, not thrown: a correct caller must branch on them. A provider that
 * is down still throws `GeocodingError`.
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
