import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { parse } from '@arki/schema';

import type { EventDef, EventOptions, Pending, Upcaster } from './types.js';
import { assertStoredName } from './id.js';

/**
 * Declare an event. `schema` is any Standard Schema. Calling the result validates the data
 * synchronously (`parse`: bad data throws `SchemaError`, an async schema `SchemaRunError`)
 * and returns a pending event. Writes, replay and upcasters parse sync too.
 * `opts.erased` gives the event's erased form for `forget`; see the README, Erasure.
 * `opts.upcasters` lifts data stored under older schemas; see the README, Changing events later.
 */
export function defineEvent<
  T extends string,
  S extends StandardSchemaV1,
  const U extends readonly StandardSchemaV1[] = readonly [],
>(type: T, schema: S, opts?: EventOptions<S, U>): EventDef<T, S> {
  assertStoredName('event type', type);
  const upcasters: readonly Upcaster[] = opts?.upcasters ?? [];
  const make = (data: SchemaInput<S>): Pending<T, SchemaOutput<S>> => ({
    type,
    data: parse<SchemaOutput<S>>(schema, data),
  });
  return Object.assign(make, {
    type,
    schema,
    version: upcasters.length + 1,
    upcasters,
    ...(opts?.erased === undefined ? {} : { erased: opts.erased }),
  });
}
