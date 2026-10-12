import { describe, expect, it } from 'vitest';

import { instant as toInstant, plainDate as toPlainDate } from '@arki/date/core';

import { instantFromDriver, instantToDriver, plainDateFromDriver, plainDateToDriver } from './temporal.js';

describe('plainDate column', () => {
  it('round-trips ISO text and never shifts through the runtime zone', () => {
    expect(plainDateToDriver(toPlainDate('2026-05-20'))).toBe('2026-05-20');
    expect(plainDateFromDriver('2026-05-20').toString()).toBe('2026-05-20');
    // node-postgres hands `date` back as a Date at LOCAL midnight: read the local fields, not the instant.
    expect(plainDateFromDriver(new Date(2026, 4, 20)).toString()).toBe('2026-05-20');
  });
});

describe('instant column', () => {
  it('round-trips exact moments from both driver shapes', () => {
    const value = toInstant('2026-05-20T07:30:00Z');
    expect(instantToDriver(value)).toBe('2026-05-20T07:30:00Z');
    expect(instantFromDriver(new Date('2026-05-20T07:30:00Z')).equals(value)).toBe(true);
    expect(instantFromDriver('2026-05-20 10:30:00+03').equals(value)).toBe(true);
    expect(instantFromDriver('2026-05-20 07:30:00.25+00').toString()).toBe('2026-05-20T07:30:00.25Z');
  });
});
