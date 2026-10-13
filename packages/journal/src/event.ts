import type { z } from 'zod';

import type { EventDef, EventOptions, Pending, Upcaster } from './types.js';
import { assertStoredName } from './id.js';

/**
 * Declare an event. Calling the result validates the data and returns a pending event.
 * `opts.erased` gives the event's erased form for `forget`; see the README, Erasure.
 * `opts.upcasters` lifts data stored under older schemas; see the README, Changing events later.
 */
export function defineEvent<T extends string, S extends z.ZodType, const U extends readonly z.ZodType[] = readonly []>(
  type: T,
  schema: S,
  opts?: EventOptions<S, U>,
): EventDef<T, S> {
  assertStoredName('event type', type);
  const upcasters: readonly Upcaster[] = opts?.upcasters ?? [];
  const make = (data: z.input<S>): Pending<T, z.output<S>> => ({ type, data: schema.parse(data) });
  return Object.assign(make, {
    type,
    schema,
    version: upcasters.length + 1,
    upcasters,
    ...(opts?.erased === undefined ? {} : { erased: opts.erased }),
  });
}
