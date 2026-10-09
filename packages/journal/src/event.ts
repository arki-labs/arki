import type { z } from 'zod';

import type { EventDef, Pending } from './types.js';

/** Declare an event. Calling the result validates the data and returns a pending event. */
export function defineEvent<T extends string, S extends z.ZodType>(type: T, schema: S): EventDef<T, S> {
  const make = (data: z.input<S>): Pending<T, z.output<S>> => ({ type, data: schema.parse(data) });
  return Object.assign(make, { type, schema });
}
