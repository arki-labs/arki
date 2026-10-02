import { describe, expect, it } from 'vitest';

import { pipIntervalCandidates } from './pips';

describe('Pip source windows', () => {
  it('preserves sentence context and emits only timed source ranges near capture', () => {
    const transcript = {
      language: 'en',
      segments: [
        { start: 0, end: 3, text: 'A sentence continues' },
        { start: 3, end: 7, text: 'with a necessary qualification.' },
        { start: 7, end: 12, text: 'The next complete thought.' },
        { start: 12, end: 140, text: 'A passage too long for one suggestion.' },
      ],
    };
    const ranges = pipIntervalCandidates(transcript, 10);
    expect(ranges.some(r => r.start === 0 && r.end === 7)).toBe(true);
    expect(ranges.some(r => r.start === 3)).toBe(false);
    expect(ranges.every(r => r.end - r.start <= 120)).toBe(true);
    expect(ranges.find(r => r.end === 7)?.text).toContain('necessary qualification.');
    expect(pipIntervalCandidates(transcript, 1000)).toEqual([]);
  });
});
