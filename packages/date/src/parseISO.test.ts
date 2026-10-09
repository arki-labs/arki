import { parseISO as fnsParseISO } from 'date-fns/parseISO';
import { describe, expect, it } from 'vitest';

import { parseISO } from './parseISO.js';

// Every form date-fns accepts, its quirks, and the inputs it rejects. Equal getTime() (NaN === NaN counts as equal).
const INPUTS = [
  '2026-05-20',
  '2026-05',
  '2026',
  '20',
  '20260520',
  '2026-05-20T10:30',
  '2026-05-20T10:30:45',
  '2026-05-20T10:30:45.123',
  '2026-05-20T10:30:45,5',
  '2026-05-20T10:30:01.005',
  '2026-05-20 10:30',
  '20260520T1030',
  '20260520T103045',
  '2026-05-20T10',
  '2026-05-20T10.5',
  '2026-05-20T10:30.25',
  '2026-05-20T24:00',
  '2026-05-20T10:30:45Z',
  '2026-05-20Z',
  '2026-05-20T10:30:45.123456789Z',
  '2026-05-20T10:30:45+03:00',
  '2026-05-20T10:30:45.123+0300',
  '2026-05-20T10:30:45-0530',
  '2026-05-20T10:30:45+03',
  '2026-05-20T10:30+3',
  '2026-W41-5',
  '2026W415',
  '2026-W41',
  '2026-W53-1',
  '2025-W53-1',
  '2026-283',
  '2026283',
  '2024-366',
  '+002026-05-20',
  '-000001-05-20',
  '+012345-01-01T00:00:00Z',
  '0050-01-01',
  '2026-03-29T03:30',
  '2026-10-25T03:30',
  '2026-11-01T02:30',
  // invalid
  '',
  'not a date',
  '10:30',
  '2026-13-01',
  '2026-00-10',
  '2026-02-30',
  '2023-02-29',
  '2026-5-20',
  '2026/05/20',
  '2026-367',
  '2026-W54-1',
  '2026-W41-8',
  '2026-05-20T25:00',
  '2026-05-20T10:60',
  '2026-05-20T24:00:01',
  '2026-05-20T10:30+03:60',
  '2026-05-20T10:30:45 extra',
  '+999999-01-01',
];

describe('parseISO — differential against date-fns v4', () => {
  it.each(INPUTS)('%j matches date-fns', text => {
    const ours = parseISO(text);
    expect(ours).toBeInstanceOf(Date);
    expect(ours.getTime()).toBe(fnsParseISO(text).getTime());
  });
});

describe('parseISO — semantics', () => {
  it('reads zone-less text as local time and offset text as exact', () => {
    expect(parseISO('2026-05-20T10:30').getTime()).toBe(new Date(2026, 4, 20, 10, 30).getTime());
    expect(parseISO('2026-05-20').getTime()).toBe(new Date(2026, 4, 20).getTime());
    expect(parseISO('2026-05-20T10:30:00+03:00').toISOString()).toBe('2026-05-20T07:30:00.000Z');
  });

  it('returns an Invalid Date instead of throwing', () => {
    expect(Number.isNaN(parseISO('2026-02-30').getTime())).toBe(true);
    expect(Number.isNaN(parseISO('+999999-01-01').getTime())).toBe(true);
  });
});
