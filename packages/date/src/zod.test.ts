import type { z } from 'zod';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Interval } from './interval.js';
import type { Duration, Instant, PlainDate, PlainDateTime, ZonedDateTime } from './types.js';
import { instant, plainDate, plainDateTime, zoned } from './core.js';
import { Temporal } from './types.js';
import {
  durationSchema,
  instantSchema,
  intervalSchema,
  plainDateSchema,
  plainDateTimeSchema,
  timeZoneSchema,
  zonedDateTimeSchema,
} from './zod.js';

function firstMessage(result: z.ZodSafeParseResult<unknown>): string {
  if (result.success) throw new Error('expected the parse to fail');
  return result.error.issues[0]?.message ?? '';
}

describe('plainDateSchema', () => {
  const schema = plainDateSchema();
  it('accepts a string and a value', () => {
    expect(schema.parse('2026-10-09').toString()).toBe('2026-10-09');
    const value = plainDate('2026-10-09');
    expect(schema.parse(value).equals(value)).toBe(true);
  });
  it('rejects garbage and timestamps with a message saying what was expected', () => {
    expect(firstMessage(schema.safeParse('nope'))).toContain('Invalid PlainDate: expected YYYY-MM-DD');
    expect(firstMessage(schema.safeParse('nope'))).toContain('received "nope"');
    expect(schema.safeParse('2026-10-09T10:00:00Z').success).toBe(false);
    expect(schema.safeParse(42).success).toBe(false);
  });
  it('types input and output', () => {
    expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<string | PlainDate>();
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<PlainDate>();
  });
});

describe('plainDateTimeSchema', () => {
  const schema = plainDateTimeSchema();
  it('accepts a string and a value, rejects zoned text', () => {
    expect(schema.parse('2026-10-09T10:30').toString()).toBe('2026-10-09T10:30:00');
    const value = plainDateTime('2026-10-09T10:30');
    expect(schema.parse(value).equals(value)).toBe(true);
    expect(firstMessage(schema.safeParse('2026-10-09T10:30Z'))).toContain('Invalid PlainDateTime');
  });
  it('types input and output', () => {
    expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<string | PlainDateTime>();
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<PlainDateTime>();
  });
});

describe('instantSchema', () => {
  const schema = instantSchema();
  it('accepts a string, an Instant and a Date', () => {
    expect(schema.parse('2026-10-09T10:00:00Z').toString()).toBe('2026-10-09T10:00:00Z');
    const value = instant('2026-10-09T10:00:00Z');
    expect(schema.parse(value).equals(value)).toBe(true);
    expect(schema.parse(new Date('2026-10-09T10:00:00Z')).equals(value)).toBe(true);
  });
  it('rejects a string without an offset', () => {
    expect(firstMessage(schema.safeParse('2026-10-09'))).toContain('Invalid Instant');
  });
  it('types input and output', () => {
    expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<string | Instant | Date>();
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<Instant>();
  });
});

describe('zonedDateTimeSchema', () => {
  it('needs a [Zone] annotation by default', () => {
    const schema = zonedDateTimeSchema();
    expect(schema.parse('2026-10-09T10:00+03:00[Europe/Bucharest]').timeZoneId).toBe('Europe/Bucharest');
    expect(firstMessage(schema.safeParse('2026-10-09T10:00:00Z'))).toContain('[TimeZone] annotation');
    const value = zoned('2026-10-09T10:00+03:00[Europe/Bucharest]');
    expect(schema.parse(value).equals(value)).toBe(true);
  });
  it('reads strings in the given zone', () => {
    const schema = zonedDateTimeSchema({ timeZone: 'Asia/Tokyo' });
    expect(schema.parse('2026-10-09T10:00:00Z').toString()).toBe('2026-10-09T19:00:00+09:00[Asia/Tokyo]');
    expect(schema.parse('2026-10-09T10:00').toString()).toBe('2026-10-09T10:00:00+09:00[Asia/Tokyo]');
  });
  it('types input and output', () => {
    const schema = zonedDateTimeSchema();
    expect(schema.safeParse('2026-10-09T10:00+03:00[Europe/Bucharest]').success).toBe(true);
    expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<string | ZonedDateTime>();
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<ZonedDateTime>();
  });
});

describe('durationSchema', () => {
  const schema = durationSchema();
  it('accepts ISO text and a Duration', () => {
    expect(schema.parse('P1DT2H').toString()).toBe('P1DT2H');
    const value = Temporal.Duration.from({ minutes: 5 });
    expect(schema.parse(value).toString()).toBe('PT5M');
    expect(firstMessage(schema.safeParse('2 hours'))).toContain('Invalid Duration: expected an ISO 8601 duration');
  });
  it('types input and output', () => {
    expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<string | Duration>();
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<Duration>();
  });
});

describe('timeZoneSchema', () => {
  const schema = timeZoneSchema();
  it('returns the canonical id and rejects unknown zones', () => {
    expect(schema.parse('europe/bucharest')).toBe('Europe/Bucharest');
    expect(firstMessage(schema.safeParse('Mars/Olympus'))).toContain('expected an IANA id');
    expect(schema.safeParse(3).success).toBe(false);
  });
  it('types input and output', () => {
    expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<string>();
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<string>();
  });
});

describe('intervalSchema', () => {
  const schema = intervalSchema(plainDateSchema());
  it('builds an interval from two parsed points', () => {
    const parsed = schema.parse({ start: '2026-10-01', end: plainDate('2026-10-09') });
    expect(parsed.start.toString()).toBe('2026-10-01');
    expect(parsed.end.toString()).toBe('2026-10-09');
  });
  it('turns an end before the start into an issue', () => {
    expect(firstMessage(schema.safeParse({ start: '2026-10-09', end: '2026-10-01' }))).toContain('Invalid interval');
  });
  it('reports bad ends from the point schema', () => {
    expect(schema.safeParse({ start: 'x', end: '2026-10-01' }).success).toBe(false);
  });
  it('types input and output', () => {
    expectTypeOf<z.infer<typeof schema>>().toEqualTypeOf<Interval<PlainDate>>();
    expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<{ start: unknown; end: unknown }>();
  });
});

describe('issue messages for long input', () => {
  it('copy a bounded part of the input, never all of it', () => {
    const huge = 'x'.repeat(100_000);
    for (const result of [plainDateSchema().safeParse(huge), timeZoneSchema().safeParse(huge)]) {
      expect(firstMessage(result).length).toBeLessThan(400);
    }
  });
});
