import type { SchemaFailure } from '@arki/failure';
import type { SchemaInput, SchemaOutput, StandardSchemaV1 } from '@arki/schema';
import { isSchemaFailure } from '@arki/failure';
import { parse } from '@arki/schema';

import type { EventDef, EventOptions, Pending, Upcaster } from './types.js';
import { assertStoredName } from './id.js';

/**
 * Declare an event. `schema` is any Standard Schema. Calling the result validates the data
 * synchronously and returns a pending event or a canonical schema failure. Writes, replay and upcasters parse sync too.
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
  const make = (data: SchemaInput<S>): Pending<T, SchemaOutput<S>> | SchemaFailure => {
    const parsed = parse<SchemaOutput<S>>(schema, data);
    return isSchemaFailure(parsed) ? parsed : { type, data: parsed };
  };
  return Object.assign(make, {
    type,
    schema,
    version: upcasters.length + 1,
    upcasters,
    ...(opts?.erased === undefined ? {} : { erased: opts.erased }),
  });
}
