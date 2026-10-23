/**
 * `@arki/journal/zod`: the Zod schemas that decode what the journal stores, such as a job's
 * `args` or a log position. The types are written where they belong (`StoredEventRow` and
 * `ForwardArgs` in `pg`, `EventLogPosition` in `event-log`); `zod.test-d.ts` locks each schema
 * to its type both ways. Public types never name Zod, so the schemas live in this entry only.
 */
import { z } from 'zod';

import { is } from '@arki/schema';

import type { EventLogPosition } from './event-log.js';

/** A `timestamptz` column after a JSON round trip: an ISO string in, a `Date` out. */
const jsonTimestamp = z.codec(z.iso.datetime({ offset: true }), z.date(), {
  decode: text => new Date(text),
  encode: date => date.toISOString(),
});

/**
 * A `journal_events` row as an effect job's `args` holds it: the row the write inserted, after the
 * jsonb round trip. Its output is exactly `StoredEventRow`, so the worker decodes the copy as it
 * would decode the stored row. The schema only brings the timestamps back from their JSON strings.
 */
export const storedEventRowSchema = z.object({
  seq: z.int(),
  id: z.string(),
  kind: z.string(),
  entityId: z.string(),
  version: z.int(),
  type: z.string(),
  data: z.unknown(),
  meta: z.unknown(),
  recordedAt: jsonTimestamp,
  commandId: z.string().nullable(),
  causeSeq: z.int().nullable(),
  correlationId: z.string().nullable(),
  erasedAt: jsonTimestamp.nullable(),
  schemaVersion: z.int(),
});

/** A `forward` job's `args`. Written by the writer, so a parse failure is a library bug. */
export const forwardArgsSchema = z.object({ events: z.array(storedEventRowSchema).min(1) });

const nonEmptyText = z.string().min(1);

/**
 * A log position: any non-empty text a log made. The brand is the type's own, so the check is a
 * schema and the brand comes from `z.custom`, never from a cast at a call site.
 */
export const eventLogPositionSchema = z.custom<EventLogPosition>(
  value => is(value, nonEmptyText),
  'an event log position is non-empty text',
);
