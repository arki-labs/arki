import { describe, expect, it } from 'vitest';

import { MockClock } from '../src/index.js';
import { createCooldownGate } from './cooldown-gate.js';

const fifteenMinutes = 15 * 60 * 1000;

describe('createCooldownGate', () => {
  it('blocks a second request inside the window and allows it at the boundary', () => {
    const clock = new MockClock(new Date('2026-01-01T00:00:00.000Z'));
    const gate = createCooldownGate(clock, fifteenMinutes);

    expect(gate.tryAcquire('ana@example.com')).toBe(true);
    clock.advance(fifteenMinutes - 1);
    expect(gate.tryAcquire('ana@example.com')).toBe(false);
    clock.advance(1);
    expect(gate.tryAcquire('ana@example.com')).toBe(true);
  });

  it('keeps one window per key', () => {
    const gate = createCooldownGate(new MockClock(), fifteenMinutes);
    expect(gate.tryAcquire('a')).toBe(true);
    expect(gate.tryAcquire('b')).toBe(true);
  });
});
