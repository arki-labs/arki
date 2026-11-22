/**
 * The schemas that check timestamps and pages. Internal: `timestamps.ts` and `assertions.ts` parse with them, and
 * no entry exports them. The TS types (`Timestamp`, `PaginatedResponse`) are the source, so the public `.d.ts`
 * names no Zod type; `schemas.test-d.ts` locks each schema to its type both ways.
 */
import { z } from 'zod';

import { Temporal } from '@arki/date/types';

/** A `Timestamp`: a `Date` that holds a time (zod refuses `Invalid Date`), a Temporal `Instant`, or a `ZonedDateTime`. */
export const timestampSchema = z.union([
  z.date(),
  z.instanceof(Temporal.Instant),
  z.instanceof(Temporal.ZonedDateTime),
]);

/** A `PaginatedResponse`: an `items` array, and `total`, `nextCursor` and `hasMore` when present. */
export const paginatedResponseSchema = z.object({
  items: z.array(z.unknown()),
  total: z.number().optional(),
  nextCursor: z.string().nullable().optional(),
  hasMore: z.boolean().optional(),
});
