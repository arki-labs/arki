import { describe, expectTypeOf, it } from 'vitest';

import type { BucketUnitFor } from './compare.js';
import type { parseISO } from './core.js';
import type { DateTextReason, InvalidDateText, UnknownTimeZone } from './failures.js';
import type {
  Amount,
  AmountFor,
  CalendarUnit,
  Instant,
  PlainDate,
  PlainDateTime,
  TimeAmount,
  TimeUnit,
  Unit,
  UnitFor,
  ZonedDateTime,
} from './types.js';

// Compile-time contract of the exported type utilities: a change here is a breaking change.
describe('type utilities', () => {
  it('UnitFor narrows to what each point kind supports', () => {
    expectTypeOf<UnitFor<PlainDate>>().toEqualTypeOf<CalendarUnit>();
    expectTypeOf<UnitFor<PlainDateTime>>().toEqualTypeOf<Unit>();
    expectTypeOf<UnitFor<ZonedDateTime>>().toEqualTypeOf<Unit>();
    expectTypeOf<UnitFor<Instant>>().toEqualTypeOf<TimeUnit>();
    expectTypeOf<UnitFor<PlainDate | Instant>>().toEqualTypeOf<never>();
    expectTypeOf<UnitFor<ZonedDateTime | Instant>>().toEqualTypeOf<TimeUnit>();
  });

  it('AmountFor allows time-only amounts on instants', () => {
    expectTypeOf<AmountFor<PlainDate>>().toEqualTypeOf<Amount>();
    expectTypeOf<AmountFor<ZonedDateTime>>().toEqualTypeOf<Amount>();
    expectTypeOf<AmountFor<Instant>>().toEqualTypeOf<TimeAmount>();
    expectTypeOf<AmountFor<ZonedDateTime | Instant>>().toEqualTypeOf<TimeAmount>();
  });

  it('BucketUnitFor keeps time buckets off PlainDate', () => {
    expectTypeOf<BucketUnitFor<PlainDate>>().toEqualTypeOf<CalendarUnit>();
    expectTypeOf<BucketUnitFor<ZonedDateTime>>().toEqualTypeOf<Unit>();
  });

  it('parsers return the value or a typed failure, and failure data is typed', () => {
    // Outside text never throws: the failures are part of the return type, so callers must handle them.
    expectTypeOf<ReturnType<typeof parseISO>>().toEqualTypeOf<Instant | InvalidDateText | UnknownTimeZone>();
    expectTypeOf<InvalidDateText['data']['reason']>().toEqualTypeOf<DateTextReason>();
  });
});
