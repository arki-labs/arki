import type { z } from 'zod';

import type { EventDef, EventOptions, Pending } from './types.js';
import { assertStoredName } from './id.js';

/**
 * Declare an event. Calling the result validates the data and returns a pending event.
 * `opts.erased` gives the event's erased form for `forget`; see the README, Erasure.
 */
export function defineEvent<T extends string, S extends z.ZodType>(
  type: T,
  schema: S,
  opts?: EventOptions<S>,
): EventDef<T, S> {
  assertStoredName('event type', type);
  const make = (data: z.input<S>): Pending<T, z.output<S>> => ({ type, data: schema.parse(data) });
  return Object.assign(make, { type, schema, ...(opts?.erased === undefined ? {} : { erased: opts.erased }) });
}
