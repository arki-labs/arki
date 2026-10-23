/** SQLite's `instant` column: a `Temporal.Instant` stored as integer milliseconds since the epoch. */
import { customType } from 'drizzle-orm/sqlite-core';

import type { Instant } from '@arki/date/types';
import { Temporal } from '@arki/date/types';

/**
 * An `integer` column holding an `Instant` at millisecond precision, the
 * SQLite form of `@arki/db/temporal`'s `instant`. Sub-millisecond digits are
 * dropped on write.
 */
export const instant = customType<{ data: Instant; driverData: number }>({
  dataType: () => 'integer',
  toDriver: (value) => value.epochMilliseconds,
  fromDriver: (milliseconds) => Temporal.Instant.fromEpochMilliseconds(milliseconds),
});

/** The builder `instant(name)` returns. */
export type SqliteInstantBuilder = ReturnType<typeof instant>;
