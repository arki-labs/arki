import type { z } from 'zod';
import { expectTypeOf, it } from 'vitest';

import type { ProviderAttempt } from './core/failures';
import type { AddressComponents, GeocodeResult } from './geocoding/types';
import type * as zodEntry from './zod';

// Every public entry but `./zod` exposes plain TS types, written once as the source. These exact two-way tests
// keep each schema in `./zod` equal to its type: a field added to one side only, a widened enum or a dropped
// `optional` fails here instead of reaching a caller as a type that lies.
it('every schema in ./zod parses to exactly its public type', () => {
  expectTypeOf<z.output<typeof zodEntry.providerAttemptSchema>>().toEqualTypeOf<ProviderAttempt>();
  expectTypeOf<z.output<typeof zodEntry.addressComponentsSchema>>().toEqualTypeOf<AddressComponents>();
  expectTypeOf<z.output<typeof zodEntry.geocodeResultSchema>>().toEqualTypeOf<GeocodeResult>();
});
