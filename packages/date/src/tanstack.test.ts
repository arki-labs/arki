import { makeSerovalPlugin } from '@tanstack/router-core';
import { fromCrossJSON, toCrossJSON } from 'seroval';
import { describe, expect, it } from 'vitest';

import { temporalSerializationAdapters } from './tanstack.js';
import { Temporal } from './types.js';

const plugins = temporalSerializationAdapters.map(adapter => makeSerovalPlugin(adapter));

/** The trip TanStack Start makes: seroval cross-JSON with the adapters as plugins. */
function roundTrip<T>(value: T): T {
  return fromCrossJSON<T>(toCrossJSON(value, { plugins }), { plugins, refs: new Map() });
}

describe('temporalSerializationAdapters', () => {
  // Why: loader data and server-function results reach the browser through
  // seroval. Without an adapter seroval throws on a Temporal value, and a value
  // restored as a string would break every Temporal method call in render code.
  it('restores every Temporal type with its class and exact value', () => {
    const value = {
      instant: Temporal.Instant.from('2026-10-13T06:00:00.123456789Z'),
      zoned: Temporal.ZonedDateTime.from('2026-03-29T04:30:00+03:00[Europe/Bucharest]'),
      date: Temporal.PlainDate.from('2026-10-13'),
      dateTime: Temporal.PlainDateTime.from('2026-10-13T09:05:00'),
      duration: Temporal.Duration.from('P1DT2H30M'),
    };

    const restored = roundTrip(value);

    expect(restored.instant).toBeInstanceOf(Temporal.Instant);
    expect(restored.instant.equals(value.instant)).toBe(true);
    expect(restored.zoned).toBeInstanceOf(Temporal.ZonedDateTime);
    expect(restored.zoned.equals(value.zoned)).toBe(true);
    expect(restored.zoned.timeZoneId).toBe('Europe/Bucharest');
    expect(restored.date).toBeInstanceOf(Temporal.PlainDate);
    expect(restored.date.equals(value.date)).toBe(true);
    expect(restored.dateTime).toBeInstanceOf(Temporal.PlainDateTime);
    expect(restored.dateTime.equals(value.dateTime)).toBe(true);
    expect(restored.duration).toBeInstanceOf(Temporal.Duration);
    expect(restored.duration.toString()).toBe('P1DT2H30M');
  });

  it('restores values nested in arrays next to plain dates', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    const restored = roundTrip({ rows: [{ seenAt: Temporal.Instant.from('2026-01-01T00:00:00Z'), at }] });

    expect(restored.rows[0]?.seenAt).toBeInstanceOf(Temporal.Instant);
    expect(restored.rows[0]?.at).toBeInstanceOf(Date);
  });

  // Each adapter claims only its own type: a ZonedDateTime is not handed to the
  // Instant adapter, which would drop its zone.
  it('claims each value with exactly one adapter', () => {
    const samples = [
      Temporal.Instant.from('2026-01-01T00:00:00Z'),
      Temporal.ZonedDateTime.from('2026-01-01T00:00:00+00:00[UTC]'),
      Temporal.PlainDate.from('2026-01-01'),
      Temporal.PlainDateTime.from('2026-01-01T00:00:00'),
      Temporal.Duration.from('PT1S'),
    ];
    for (const sample of samples) {
      expect(temporalSerializationAdapters.filter(adapter => adapter.test(sample))).toHaveLength(1);
    }
    expect(temporalSerializationAdapters.some(adapter => adapter.test(new Date()))).toBe(false);
    expect(temporalSerializationAdapters.some(adapter => adapter.test('2026-01-01'))).toBe(false);
  });
});
