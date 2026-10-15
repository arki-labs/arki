import { describe, expect, it } from 'vitest';

import { manualScheduler } from './manual-scheduler.js';

describe('manualScheduler', () => {
  it('fires due timers in time order, each at its own time, and nothing past the target', async () => {
    const clock = manualScheduler(100);
    const seen: string[] = [];
    clock.setTimeout(() => seen.push(`late@${clock.now()}`), 50);
    clock.setTimeout(() => seen.push(`early@${clock.now()}`), 10);
    clock.setTimeout(() => seen.push('never'), 500);
    await clock.advance(60);
    expect(seen).toEqual(['early@110', 'late@150']);
    expect(clock.now()).toBe(160);
    expect(clock.pendingTimers).toBe(1);
  });

  it('breaks ties by the order the timers were set', async () => {
    const clock = manualScheduler();
    const seen: number[] = [];
    clock.setTimeout(() => seen.push(1), 5);
    clock.setTimeout(() => seen.push(2), 5);
    await clock.advance('5ms');
    expect(seen).toEqual([1, 2]);
  });

  it('awaits a promise a callback returns before it fires the next timer', async () => {
    const clock = manualScheduler();
    const seen: string[] = [];
    clock.setTimeout(async () => {
      seen.push('renew:start');
      await new Promise(resolve => setTimeout(resolve, 10));
      seen.push('renew:end');
    }, 1);
    clock.setTimeout(() => seen.push('next'), 2);
    await clock.advance(5);
    expect(seen).toEqual(['renew:start', 'renew:end', 'next']);
  });

  it('fires timers that a callback sets, when they are due inside the window', async () => {
    const clock = manualScheduler();
    const seen: number[] = [];
    clock.setTimeout(() => {
      clock.setTimeout(() => seen.push(clock.now()), 3);
    }, 2);
    await clock.advance(10);
    expect(seen).toEqual([5]);
  });

  it('advance(0) fires what is due now; clearTimeout removes a timer from pendingTimers', async () => {
    const clock = manualScheduler();
    let fired = 0;
    clock.setTimeout(() => fired++, 0);
    const handle = clock.setTimeout(() => fired++, 10);
    expect(clock.pendingTimers).toBe(2);
    clock.clearTimeout(handle);
    await clock.advance(0);
    expect(fired).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it('fixes its target when called, so a hanging callback does not need to be awaited', async () => {
    const clock = manualScheduler();
    const gate: { open?: () => void } = {};
    clock.setTimeout(
      () =>
        new Promise<void>(resolve => {
          gate.open = resolve;
        }),
      1,
    );
    const advancing = clock.advance(10);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(clock.now()).toBe(1);
    gate.open?.();
    await advancing;
    expect(clock.now()).toBe(10);
  });
});
